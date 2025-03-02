'use strict';

const { parentPort } = require('worker_threads');
const config = require('wild-config');
const logger = require('../lib/logger');
const util = require('util');
const { redis, notifyQueue, queueConf } = require('../lib/db');
const { Worker } = require('bullmq');
const { Account } = require('../lib/account');
const { getDuration } = require('../lib/tools');
const getSecret = require('../lib/get-secret');
const settings = require('../lib/settings');
const packageData = require('../package.json');
const msgpack = require('msgpack5')();

const { EMAIL_FAILED_NOTIFY } = require('../lib/consts');

config.smtp = config.smtp || {
    port: 2525,
    host: '127.0.0.1'
};

config.queues = config.queues || {
    submit: 1
};

config.service = config.service || {};

const DEFAULT_EENGINE_TIMEOUT = 10 * 1000;

const EENGINE_TIMEOUT = getDuration(process.env.EENGINE_TIMEOUT || config.service.commandTimeout) || DEFAULT_EENGINE_TIMEOUT;

const SUBMIT_QC = (process.env.EENGINE_SUBMIT_QC && Number(process.env.EENGINE_SUBMIT_QC)) || config.queues.submit || 1;

let callQueue = new Map();
let mids = 0;

async function call(message, transferList) {
    return new Promise((resolve, reject) => {
        let mid = `${Date.now()}:${++mids}`;

        let timer = setTimeout(() => {
            let err = new Error('Timeout waiting for command response [T5]');
            err.statusCode = 504;
            err.code = 'Timeout';
            reject(err);
        }, message.timeout || EENGINE_TIMEOUT);

        callQueue.set(mid, { resolve, reject, timer });

        parentPort.postMessage(
            {
                cmd: 'call',
                mid,
                message
            },
            transferList
        );
    });
}

async function metrics(logger, key, method, ...args) {
    try {
        parentPort.postMessage({
            cmd: 'metrics',
            key,
            method,
            args
        });
    } catch (err) {
        logger.error({ msg: 'Failed to post metrics to parent', err });
    }
}

async function notify(account, event, data) {
    metrics(logger, 'events', 'inc', {
        event
    });

    let payload = {
        account,
        date: new Date().toISOString()
    };

    if (event) {
        payload.event = event;
    }

    if (data) {
        payload.data = data;
    }

    let queueKeep = (await settings.get('queueKeep')) || true;
    await notifyQueue.add(event, payload, {
        removeOnComplete: queueKeep,
        removeOnFail: queueKeep,
        attempts: 10,
        backoff: {
            type: 'exponential',
            delay: 5000
        }
    });
}

const smtpLogger = {};
for (let level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    smtpLogger[level] = (data, message, ...args) => {
        if (args && args.length) {
            message = util.format(message, ...args);
        }
        data.msg = message;
        data.sub = 'smtp-server';
        if (typeof logger[level] === 'function') {
            logger[level](data);
        } else {
            logger.debug(data);
        }
    };
}

const submitWorker = new Worker(
    'submit',
    async job => {
        if (!job.data.queueId && job.data.qId) {
            // this value was used to be called qId
            job.data.queueId = job.data.qId;
        }

        let queueEntryBuf = await redis.hgetBuffer(`iaq:${job.data.account}`, job.data.queueId);
        if (!queueEntryBuf) {
            // nothing to do here
            try {
                await redis.hdel(`iaq:${job.data.account}`, job.data.queueId);
            } catch (err) {
                // ignore
            }
            return;
        }

        let queueEntry;
        try {
            queueEntry = msgpack.decode(queueEntryBuf);
        } catch (err) {
            logger.error({ msg: 'Failed to parse queued email entry', job: job.data, err });
            try {
                await redis.hdel(`iaq:${job.data.account}`, job.data.queueId);
            } catch (err) {
                // ignore
            }
            return;
        }

        if (!queueEntry) {
            //could be expired?
            return false;
        }

        let accountObject = new Account({ account: job.data.account, redis, call, secret: await getSecret() });
        try {
            try {
                // try to update
                await job.updateProgress({
                    status: 'processing'
                });
            } catch (err) {
                // ignore
            }

            let backoffDelay = Number(job.opts.backoff && job.opts.backoff.delay) || 0;
            let nextAttempt = job.attemptsMade < job.opts.attempts ? Math.round(job.processedOn + Math.pow(2, job.attemptsMade) * backoffDelay) : false;

            queueEntry.job = {
                attemptsMade: job.attemptsMade,
                attempts: job.opts.attempts,
                nextAttempt: new Date(nextAttempt).toISOString()
            };

            let res = await accountObject.submitMessage(queueEntry);

            logger.info({
                msg: 'Submitted queued message for delivery',
                account: queueEntry.account,
                queueId: job.data.queueId,
                messageId: job.data.messageId,
                res
            });

            try {
                // try to update
                await job.updateProgress({
                    status: 'submitted',
                    response: res.response
                });
            } catch (err) {
                // ignore
            }
        } catch (err) {
            logger.error({
                msg: 'Message submission failed',
                account: queueEntry.account,
                queueId: job.data.queueId,
                messageId: job.data.messageId,
                err
            });

            try {
                // try to update
                await job.updateProgress({
                    status: 'error',
                    error: {
                        message: err.message,
                        code: err.code,
                        statusCode: err.statusCode
                    }
                });
            } catch (err) {
                // ignore
            }

            if (err.statusCode >= 500 && job.attemptsMade < job.opts.attempts) {
                try {
                    // do not retry after 5xx error
                    await job.discard();
                    logger.info({
                        msg: 'Job discarded',
                        account: queueEntry.account,
                        queueId: job.data.queueId
                    });
                } catch (E) {
                    // ignore
                    logger.error({ msg: 'Failed to discard job', account: queueEntry.account, queueId: job.data.queueId, err: E });
                }
            }

            throw err;
        }
    },
    Object.assign(
        {
            concurrency: SUBMIT_QC
        },
        queueConf
    )
);

submitWorker.on('completed', async job => {
    if (!job.data.queueId && job.data.qId) {
        // this value was used to be called qId
        job.data.queueId = job.data.qId;
    }

    if (job.data && job.data.account && job.data.queueId) {
        try {
            await redis.hdel(`iaq:${job.data.account}`, job.data.queueId);
        } catch (err) {
            logger.error({ msg: 'Failed to remove queue entry', account: job.data.account, queueId: job.data.queueId, messageId: job.data.messageId, err });
        }
    }
});

submitWorker.on('failed', async job => {
    if (job.finishedOn || job.discarded) {
        // this was final attempt, remove it
        if (!job.data.queueId && job.data.qId) {
            // this value was used to be called qId
            job.data.queueId = job.data.qId;
        }
        if (job.data && job.data.account && job.data.queueId) {
            try {
                await redis.hdel(`iaq:${job.data.account}`, job.data.queueId);
            } catch (err) {
                logger.error({ msg: 'Failed to remove queue entry', account: job.data.account, queueId: job.data.queueId, messageId: job.data.messageId, err });
            }
            // report as failed
            await notify(job.data.account, EMAIL_FAILED_NOTIFY, {
                messageId: job.data.messageId,
                queueId: job.data.queueId,
                error: job.stacktrace && job.stacktrace[0] && job.stacktrace[0].split('\n').shift()
            });
        }
    }
});

async function onCommand(command) {
    logger.debug({ msg: 'Unhandled command', command });
}

parentPort.on('message', message => {
    if (message && message.cmd === 'resp' && message.mid && callQueue.has(message.mid)) {
        let { resolve, reject, timer } = callQueue.get(message.mid);
        clearTimeout(timer);
        callQueue.delete(message.mid);
        if (message.error) {
            let err = new Error(message.error);
            if (message.code) {
                err.code = message.code;
            }
            if (message.statusCode) {
                err.statusCode = message.statusCode;
            }
            return reject(err);
        } else {
            return resolve(message.response);
        }
    }

    if (message && message.cmd === 'call' && message.mid) {
        return onCommand(message.message)
            .then(response => {
                parentPort.postMessage({
                    cmd: 'resp',
                    mid: message.mid,
                    response
                });
            })
            .catch(err => {
                parentPort.postMessage({
                    cmd: 'resp',
                    mid: message.mid,
                    error: err.message,
                    code: err.code,
                    statusCode: err.statusCode
                });
            });
    }
});

logger.info({ msg: 'Started SMTP submission worker thread', version: packageData.version });
