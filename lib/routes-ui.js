'use strict';

const Boom = require('@hapi/boom');
const consts = require('./consts');
const settings = require('./settings');
const tokens = require('./tokens');
const Joi = require('joi');
const logger = require('./logger');
const fetch = require('node-fetch');
const { failAction, verifyAccountInfo, getLogs, flattenObjectKeys, getStats, getBoolean } = require('./tools');
const packageData = require('../package.json');
const he = require('he');
const crypto = require('crypto');
const pbkdf2 = require('@phc/pbkdf2');
const { Account } = require('./account');
const { redis, submitQueue, notifyQueue } = require('./db');
const psl = require('psl');
const { getOAuth2Client } = require('./oauth');
const { autodetectImapSettings } = require('./autodetect-imap-settings');
const getSecret = require('./get-secret');
const humanize = require('humanize');
const { resolvePublicInterfaces } = require('pubface');
const os = require('os');
const { ADDRESS_STRATEGIES, settingsSchema } = require('./schemas');
const fs = require('fs');
const pathlib = require('path');
const beautifyHtml = require('js-beautify').html;

const { DEFAULT_MAX_LOG_LINES, PDKDF2_ITERATIONS, PDKDF2_SALT_SIZE, PDKDF2_DIGEST, LOGIN_PERIOD_TTL, DEFAULT_PAGE_SIZE, REDIS_PREFIX } = require('./consts');

const notificationTypes = Object.keys(consts)
    .map(key => {
        if (/_NOTIFY$/.test(key)) {
            return key.replace(/_NOTIFY$/, '');
        }
        return false;
    })
    .filter(key => key)
    .map(key => ({
        key,
        name: consts[`${key}_NOTIFY`],
        description: consts[`${key}_DESCRIPTION`]
    }));

const cachedTemplates = {
    addressList: fs.readFileSync(pathlib.join(__dirname, '..', 'views', 'partials', 'address_list.hbs'), 'utf-8')
};

const configWebhooksSchema = {
    webhooksEnabled: Joi.boolean().truthy('Y', 'true', '1', 'on').falsy('N', 'false', 0, '').default(false).description('Enable Webhooks'),
    webhooks: Joi.string()
        .uri({
            scheme: ['http', 'https'],
            allowRelative: false
        })
        .allow('')
        .example('https://myservice.com/imap/webhooks')
        .description('Webhook URL'),
    notifyAll: Joi.boolean().truthy('Y', 'true', '1', 'on').falsy('N', 'false', 0, '').default(false),
    headersAll: Joi.boolean().truthy('Y', 'true', '1', 'on').falsy('N', 'false', 0, '').default(false),
    notifyHeaders: Joi.string().empty('').trim(),
    notifyText: Joi.boolean().truthy('Y', 'true', '1', 'on').falsy('N', 'false', 0, '').default(false),
    notifyTextSize: Joi.number().empty('')
};

for (let type of notificationTypes) {
    configWebhooksSchema[`notify_${type.name}`] = Joi.boolean().truthy('Y', 'true', '1', 'on').falsy('N', 'false', 0, '').default(false);
}

const configSmtpSchema = {
    smtpServerEnabled: settingsSchema.smtpServerEnabled.default(false),
    smtpServerPassword: settingsSchema.smtpServerPassword.required(),
    smtpServerAuthEnabled: settingsSchema.smtpServerAuthEnabled.default(false),
    smtpServerPort: settingsSchema.smtpServerPort,
    smtpServerHost: settingsSchema.smtpServerHost.default('0.0.0.0'),
    smtpServerProxy: settingsSchema.smtpServerProxy.default(false)
};

const configLoggingSchema = {
    all: Joi.boolean().truthy('Y', 'true', '1', 'on').falsy('N', 'false', 0, '').default(false).description('Enable logs for all accounts'),
    maxLogLines: Joi.number().empty('').min(0).max(10000000).default(DEFAULT_MAX_LOG_LINES)
};

const configOauthSchema = {
    provider: Joi.string().valid('gmail', 'gmailService', 'outlook').required().description('OAuth2 provider'),

    oauth2Enabled: Joi.boolean().truthy('Y', 'true', '1', 'on').falsy('N', 'false', 0, '').default(false).description('Enable OAuth2'),

    clientId: Joi.string().trim().allow('').max(256).description('OAuth2 Client ID'),
    clientSecret: Joi.string().trim().empty('').max(256).description('OAuth2 Client Secret'),

    serviceClient: Joi.string().trim().allow('').max(256).description('OAuth2 Service Client ID'),
    serviceKey: Joi.string()
        .trim()
        .empty('')
        .max(100 * 1024)
        .description('OAuth2 Secret Service Key'),

    authority: Joi.any()
        .when('provider', {
            switch: [
                {
                    is: 'gmail',
                    then: Joi.string().empty('').forbidden()
                },

                {
                    is: 'gmailService',
                    then: Joi.string().empty('').forbidden()
                },

                {
                    is: 'outlook',
                    then: Joi.string().empty('').max(1024).allow('consumers', 'organizations', 'common').default('consumers').example('consumers')
                }
            ]
        })
        .label('SupportedAccountTypes'),

    redirectUrl: Joi.string()
        .allow('')
        .uri({ scheme: ['http', 'https'], allowRelative: false })
        .description('OAuth2 Callback URL')
};

function formatAccountData(account) {
    account.type = {};
    if (account.oauth2 && account.oauth2.provider) {
        account.type.name = 'OAuth2';

        switch (account.oauth2.provider) {
            case 'gmail':
                account.type.comment = 'Gmail';
                account.type.icon = 'fab fa-google';
                break;
            case 'gmailService':
                account.type.comment = 'Gmail service account';
                account.type.icon = 'fab fa-google';
                break;
            case 'outlook':
                account.type.comment = 'Outlook';
                account.type.icon = 'fab fa-microsoft';
                break;
            default:
                account.type.comment = account.oauth2.provider.replace(/^./, c => c.toUpperCase());
        }
    } else if (account.imap) {
        account.type.icon = 'fa fa-envelope-square';
        account.type.name = 'IMAP';
        account.type.comment = psl.get(account.imap.host) || account.imap.host;
    } else {
        account.type.name = 'N/A';
    }

    switch (account.state) {
        case 'init':
            account.stateLabel = {
                type: 'info',
                name: 'Initializing'
            };
            break;
        case 'connecting':
            account.stateLabel = {
                type: 'info',
                name: 'Connecting'
            };
            break;
        case 'syncing':
            account.stateLabel = {
                type: 'info',
                name: 'Syncing',
                spinner: true
            };
            break;
        case 'connected':
            account.stateLabel = {
                type: 'success',
                name: 'Connected'
            };
            break;

        case 'authenticationError':
        case 'connectError':
            account.stateLabel = {
                type: 'danger',
                name: 'Failed',
                error: account.lastErrorState ? account.lastErrorState.response : false
            };
            break;
        case 'unset':
        case 'disconnected':
            account.stateLabel = {
                type: 'warning',
                name: 'Disconnected'
            };
            break;
        default:
            account.stateLabel = {
                type: 'secondary',
                name: 'N/A'
            };
            break;
    }

    if (account.oauth2) {
        account.oauth2.scopes = []
            .concat(account.oauth2.scope || [])
            .concat(account.oauth2.scopes || [])
            .flatMap(entry => entry.split(/\s+/))
            .map(entry => entry.trim())
            .filter(entry => entry);

        account.oauth2.expiresStr = account.oauth2.expires ? account.oauth2.expires.toISOString() : false;
    }

    return account;
}

function formatSmtpState(state, payload) {
    switch (state) {
        case 'suspended':
        case 'exited':
        case 'disabled':
            return {
                type: 'warning',
                name: state
            };

        case 'spawning':
        case 'initializing':
            return {
                type: 'info',
                name: state,
                spinner: true
            };

        case 'listening':
            return {
                type: 'success',
                name: state
            };

        case 'failed':
            return {
                type: 'danger',
                name: state,
                error: (payload && payload.error && payload.error.message) || null
            };

        default:
            return {
                type: 'secondary',
                name: 'N/A'
            };
    }
}

async function getSignedFormData(opts) {
    opts = opts || {};

    let data = Buffer.from(
        JSON.stringify({
            account: opts.account,
            name: opts.name,
            email: opts.email,
            redirectUrl: opts.redirectUrl
        })
    );

    let signature;
    let serviceSecret = await settings.get('serviceSecret');
    if (!serviceSecret) {
        serviceSecret = crypto.randomBytes(16).toString('hex');
        await settings.set('serviceSecret', serviceSecret);
    }

    let hmac = crypto.createHmac('sha256', serviceSecret);
    hmac.update(data);
    signature = hmac.digest('base64url');

    return { data: data.toString('base64url'), signature };
}

async function updatePublicInterfaces() {
    let interfaces = await resolvePublicInterfaces();

    for (let iface of interfaces) {
        if (!iface.localAddress) {
            continue;
        }

        if (iface.defaultInterface) {
            await redis.hset(`${REDIS_PREFIX}interfaces`, `default:${iface.family}`, iface.localAddress);
        }

        let existingEntry = await redis.hget(`${REDIS_PREFIX}interfaces`, iface.localAddress);
        if (existingEntry) {
            try {
                existingEntry = JSON.parse(existingEntry);

                iface.name = iface.name || existingEntry.name;

                if (!iface.localAddress || !iface.ip || !iface.name) {
                    // not much point in updating
                    continue;
                }
            } catch (err) {
                // ignore?
            }
        }

        delete iface.defaultInterface;
        await redis.hset(`${REDIS_PREFIX}interfaces`, iface.localAddress, JSON.stringify(iface));
    }
}

async function listPublicInterfaces(selectedAddresses) {
    let existingAddresses = Object.values(os.networkInterfaces())
        .flatMap(entry => entry)
        .map(entry => entry.address);

    let entries = await redis.hgetall(`${REDIS_PREFIX}interfaces`);

    let defaultInterfaces = {};

    let addresses = Object.keys(entries)
        .map(key => {
            if (/^default:/.test(key)) {
                let family = key.split(':').pop();
                defaultInterfaces[family] = entries[key];
                return false;
            }

            let entry = entries[key];
            try {
                return JSON.parse(entry);
            } catch (err) {
                return false;
            }
        })
        .filter(entry => entry && entry.family === 'IPv4')
        .map(entry => entry);

    addresses.forEach(address => {
        if (address.localAddress === defaultInterfaces[address.family]) {
            address.defaultInterface = true;
        }

        if (selectedAddresses && selectedAddresses.includes(address.localAddress)) {
            address.checked = true;
        }

        if (!existingAddresses.includes(address.localAddress)) {
            address.notice = 'This address was not found from the current interface listing';
        }
    });

    return addresses.sort((a, b) => {
        if (a.family !== b.family) {
            return a.family.localeCompare(b.family);
        }
        if (a.defaultInterface) {
            return -1;
        }
        if (b.defaultInterface) {
            return 1;
        }
        return (a.name || a.ip).localeCompare(b.name || b.ip);
    });
}

async function getSmtpServerStatus() {
    let serverStatus = await redis.hgetall(`${REDIS_PREFIX}smtp`);
    let state = (serverStatus && serverStatus.state) || 'disabled';
    let payload;
    try {
        payload = (serverStatus && typeof serverStatus.payload === 'string' && JSON.parse(serverStatus.payload)) || {};
    } catch (err) {
        // ignore
    }

    return { state, payload, label: formatSmtpState(state, payload) };
}

function applyRoutes(server, call) {
    server.route({
        method: 'GET',
        path: '/admin',
        async handler(request, h) {
            let stats = await getStats(redis, call, request.query.seconds || 24 * 3600);

            let counterList = [
                {
                    key: 'events:messageNew',
                    title: 'New messages',
                    color: 'info',
                    icon: 'envelope'
                },

                {
                    key: 'events:messageDeleted',
                    title: 'Deleted messages',
                    color: 'info',
                    icon: 'envelope'
                },
                {
                    key: 'webhooks:success',
                    title: 'Webhooks sent',
                    color: 'success',
                    icon: 'network-wired'
                },

                {
                    key: 'webhooks:fail',
                    title: 'Webhooks failed',
                    color: 'danger',
                    icon: 'network-wired'
                },

                {
                    key: 'apiCall:success',
                    title: 'Successful API calls',
                    color: 'success',
                    icon: 'file-code'
                },

                {
                    key: 'apiCall:failed',
                    title: 'Failed API calls',
                    color: 'danger',
                    icon: 'file-code'
                }
            ];

            for (let counter of counterList) {
                counter.value = humanize.numberFormat(stats.counters[counter.key] || 0, 0, '.', ' ');
            }

            stats.accounts = humanize.numberFormat(stats.accounts || 0, 0, '.', ' ');
            stats.connectedAccounts = humanize.numberFormat((stats.connections.connected || 0) + (stats.connections.syncing || 0), 0, '.', ' ');

            return h.view(
                'dashboard',
                {
                    menuDashboard: true,
                    stats,
                    counterList
                },
                {
                    layout: 'app'
                }
            );
        }
    });

    server.route({
        method: 'GET',
        path: '/admin/swagger',
        async handler(request, h) {
            return h.view(
                'swagger/index',
                {
                    menuSwagger: true,
                    iframePage: true
                },
                {
                    layout: 'app'
                }
            );
        }
    });

    server.route({
        method: 'GET',
        path: '/admin/arena',
        async handler(request, h) {
            return h.view(
                'arena/index',
                {
                    menuTools: true,
                    menuToolsArena: true,
                    iframePage: true
                },
                {
                    layout: 'app'
                }
            );
        }
    });

    server.route({
        method: 'GET',
        path: '/admin/upgrade',
        async handler(request, h) {
            const isDO = getBoolean(process.env.EENGINE_DOCEAN);
            const isGeneral = !isDO;

            return h.view(
                'upgrade',
                {
                    isDO,
                    isGeneral
                },
                {
                    layout: 'app'
                }
            );
        }
    });

    server.route({
        method: 'GET',
        path: '/admin/config/webhooks',
        async handler(request, h) {
            const notifyHeaders = (await settings.get('notifyHeaders')) || [];
            const webhookEvents = (await settings.get('webhookEvents')) || [];
            const notifyText = (await settings.get('notifyText')) || false;
            const notifyTextSize = Number(await settings.get('notifyTextSize')) || 0;

            let webhooksEnabled = await settings.get('webhooksEnabled');
            let values = {
                webhooksEnabled: webhooksEnabled !== null ? !!webhooksEnabled : false,
                webhooks: (await settings.get('webhooks')) || '',

                notifyAll: webhookEvents.includes('*'),

                headersAll: notifyHeaders.includes('*'),
                notifyHeaders: notifyHeaders
                    .filter(entry => entry !== '*')
                    .map(entry => entry.replace(/^mime|^dkim|-id$|^.|-./gi, c => c.toUpperCase()))
                    .join('\n'),
                notifyText,
                notifyTextSize: notifyTextSize ? notifyTextSize : ''
            };

            return h.view(
                'config/webhooks',
                {
                    menuConfig: true,
                    menuConfigWebhooks: true,

                    notificationTypes: notificationTypes.map(type => Object.assign({}, type, { checked: webhookEvents.includes(type.name) })),

                    values
                },
                {
                    layout: 'app'
                }
            );
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/config/webhooks',
        async handler(request, h) {
            try {
                const data = {
                    webhooksEnabled: request.payload.webhooksEnabled,
                    webhooks: request.payload.webhooks,
                    notifyText: request.payload.notifyText,
                    notifyTextSize: request.payload.notifyTextSize || 0,

                    webhookEvents: notificationTypes.filter(type => !!request.payload[`notify_${type.name}`]).map(type => type.name),
                    notifyHeaders: (request.payload.notifyHeaders || '')
                        .split(/\r?\n/)
                        .map(line => line.toLowerCase().trim())
                        .filter(line => line)
                };

                if (!data.webhooks) {
                    data.webhooksEnabled = false;
                }

                if (request.payload.notifyAll) {
                    data.webhookEvents.push('*');
                }
                if (request.payload.headersAll) {
                    data.notifyHeaders.push('*');
                }

                for (let key of Object.keys(data)) {
                    await settings.set(key, data[key]);
                }

                await request.flash({ type: 'info', message: `Configuration updated` });

                return h.redirect('/admin/config/webhooks');
            } catch (err) {
                await request.flash({ type: 'danger', message: `Failed to update configuration` });
                logger.error({ msg: 'Failed to update configuration', err });

                return h.view(
                    'config/webhooks',
                    {
                        menuConfig: true,
                        menuConfigWebhooks: true,

                        notificationTypes: notificationTypes.map(type => Object.assign({}, type, { checked: !!request.payload[`notify_${type.name}`] }))
                    },
                    {
                        layout: 'app'
                    }
                );
            }
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    let errors = {};

                    if (err.details) {
                        err.details.forEach(detail => {
                            if (!errors[detail.path]) {
                                errors[detail.path] = detail.message;
                            }
                        });
                    }

                    await request.flash({ type: 'danger', message: `Failed to update configuration` });
                    logger.error({ msg: 'Failed to update configuration', err });

                    return h
                        .view(
                            'config/webhooks',
                            {
                                menuConfig: true,
                                menuConfigWebhooks: true,

                                notificationTypes: notificationTypes.map(type =>
                                    Object.assign({}, type, { checked: !!request.payload[`notify_${type.name}`], error: errors[`notify_${type.name}`] })
                                ),

                                errors
                            },
                            {
                                layout: 'app'
                            }
                        )
                        .takeover();
                },

                payload: Joi.object(configWebhooksSchema)
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/admin/config/service',
        async handler(request, h) {
            const values = {
                serviceUrl: (await settings.get('serviceUrl')) || null,
                serviceSecret: (await settings.get('serviceSecret')) || null,
                queueKeep: (await settings.get('queueKeep')) || 0,
                templateHeader: (await settings.get('templateHeader')) || '',
                enableTokens: !(await settings.get('disableTokens')),
                enableApiProxy: (await settings.get('enableApiProxy')) || false
            };

            return h.view(
                'config/service',
                {
                    menuConfig: true,
                    menuConfigService: true,

                    encryption: await getSecret(),

                    values
                },
                {
                    layout: 'app'
                }
            );
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/config/service',
        async handler(request, h) {
            try {
                let data = {
                    serviceSecret: request.payload.serviceSecret,
                    queueKeep: request.payload.queueKeep,
                    templateHeader: request.payload.templateHeader,
                    disableTokens: !request.payload.enableTokens,
                    enableApiProxy: request.payload.enableApiProxy
                };

                try {
                    data.templateHeader = data.templateHeader ? beautifyHtml(data.templateHeader, {}) : data.templateHeader;
                } catch (err) {
                    request.logger.error({ msg: 'Failed to preprocess provided HTML', err, html: request.payload.templateHeader });
                }

                if (request.payload.serviceUrl) {
                    let url = new URL(request.payload.serviceUrl);
                    data.serviceUrl = url.origin;
                }

                for (let key of Object.keys(data)) {
                    await settings.set(key, data[key]);
                }

                await request.flash({ type: 'info', message: `Configuration updated` });

                return h.redirect('/admin/config/service');
            } catch (err) {
                await request.flash({ type: 'danger', message: `Failed to update configuration` });
                logger.error({ msg: 'Failed to update configuration', err });

                return h.view(
                    'config/service',
                    {
                        menuConfig: true,
                        menuConfigService: true,

                        encryption: await getSecret()
                    },
                    {
                        layout: 'app'
                    }
                );
            }
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    let errors = {};

                    if (err.details) {
                        err.details.forEach(detail => {
                            if (!errors[detail.path]) {
                                errors[detail.path] = detail.message;
                            }
                        });
                    }

                    await request.flash({ type: 'danger', message: `Failed to update configuration` });
                    logger.error({ msg: 'Failed to update configuration', err });

                    return h
                        .view(
                            'config/service',
                            {
                                menuConfig: true,
                                menuConfigService: true,
                                encryption: await getSecret(),

                                errors
                            },
                            {
                                layout: 'app'
                            }
                        )
                        .takeover();
                },

                payload: Joi.object({
                    serviceUrl: settingsSchema.serviceUrl,
                    serviceSecret: settingsSchema.serviceSecret,
                    queueKeep: settingsSchema.queueKeep.default(0),
                    templateHeader: settingsSchema.templateHeader.default(''),
                    enableApiProxy: settingsSchema.enableApiProxy.default(false),
                    // can only be changed via the UI
                    enableTokens: Joi.boolean().truthy('Y', 'true', '1', 'on').falsy('N', 'false', 0, '').default(false)
                })
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/config/service/preview',
        async handler(request, h) {
            return h.view(
                'config/service-preview',
                {
                    embeddedTemplateHeader: request.payload.templateHeader
                },
                {
                    layout: 'public'
                }
            );
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    logger.error({ msg: 'Failed to process preview', err });
                    return h.redirect('/admin').takeover();
                },

                payload: Joi.object({
                    templateHeader: settingsSchema.templateHeader.default('')
                })
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/config/service/clean',
        async handler() {
            try {
                await submitQueue.clean(1000, 'failed');
                await submitQueue.clean(1000, 'completed');
                await notifyQueue.clean(1000, 'failed');
                await notifyQueue.clean(1000, 'completed');
            } catch (err) {
                return { success: false, error: err.message };
            }

            return { success: true };
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                }
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/admin/config/logging',
        async handler(request, h) {
            let values = (await settings.get('logs')) || {};

            if (typeof values.maxLogLines === 'undefined') {
                values.maxLogLines = DEFAULT_MAX_LOG_LINES;
            }

            values.accounts = [].concat(values.accounts || []).join('\n');

            return h.view(
                'config/logging',
                {
                    menuConfig: true,
                    menuConfigLogging: true,

                    values
                },
                {
                    layout: 'app'
                }
            );
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/config/logging',
        async handler(request, h) {
            try {
                const data = {
                    logs: {
                        all: !!request.payload.all,
                        maxLogLines: request.payload.maxLogLines || 0
                    }
                };

                for (let key of Object.keys(data)) {
                    await settings.set(key, data[key]);
                }

                await request.flash({ type: 'info', message: `Configuration updated` });

                return h.redirect('/admin/config/logging');
            } catch (err) {
                await request.flash({ type: 'danger', message: `Failed to update configuration` });
                logger.error({ msg: 'Failed to update configuration', err });

                return h.view(
                    'config/logging',
                    {
                        menuConfig: true,
                        menuConfigWebhooks: true
                    },
                    {
                        layout: 'app'
                    }
                );
            }
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    let errors = {};

                    if (err.details) {
                        err.details.forEach(detail => {
                            if (!errors[detail.path]) {
                                errors[detail.path] = detail.message;
                            }
                        });
                    }

                    await request.flash({ type: 'danger', message: `Failed to update configuration` });
                    logger.error({ msg: 'Failed to update configuration', err });

                    return h
                        .view(
                            'config/logging',
                            {
                                menuConfig: true,
                                menuConfigWebhooks: true,

                                errors
                            },
                            {
                                layout: 'app'
                            }
                        )
                        .takeover();
                },

                payload: Joi.object(configLoggingSchema)
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/config/logging/reconnect',
        async handler(request) {
            try {
                let requested = 0;
                for (let account of request.payload.accounts) {
                    logger.info({ msg: 'Request reconnect for logging', account });
                    try {
                        await call({ cmd: 'update', account });
                        requested++;
                    } catch (err) {
                        logger.error({ msg: 'Reconnect request failed', action: 'request_reconnect', account, err });
                    }
                }

                return {
                    success: true,
                    accounts: requested
                };
            } catch (err) {
                logger.error({ msg: 'Failed to request reconnect', err, accounts: request.payload.accounts });
                return { success: false, error: err.message };
            }
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                failAction,

                payload: Joi.object({
                    accounts: Joi.array()
                        .items(Joi.string().max(256))
                        .default([])
                        .example(['account-id-1', 'account-id-2'])
                        .description('Request reconnect for listed accounts')
                        .label('LoggedAccounts')
                })
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/config/webhooks/test',
        async handler(request) {
            let headers = {
                'Content-Type': 'application/json',
                'User-Agent': `${packageData.name}/${packageData.version} (+${packageData.homepage})`
            };

            const webhooks = request.payload.webhooks;

            let parsed = new URL(webhooks);
            let username, password;

            if (parsed.username) {
                username = he.decode(parsed.username);
                parsed.username = '';
            }

            if (parsed.password) {
                password = he.decode(parsed.password);
                parsed.password = '';
            }

            if (username || password) {
                headers.Authorization = `Basic ${Buffer.from(he.encode(username || '') + ':' + he.encode(password || '')).toString('base64')}`;
            }

            let start = Date.now();
            let duration;
            try {
                let res;

                try {
                    res = await fetch(parsed.toString(), {
                        method: 'post',
                        body: JSON.stringify({
                            account: null,
                            date: new Date().toISOString(),
                            event: 'test',
                            data: {
                                nonce: crypto.randomBytes(12).toString('hex')
                            }
                        }),
                        headers
                    });
                    duration = Date.now() - start;
                } catch (err) {
                    duration = Date.now() - start;
                    throw err;
                }

                if (!res.ok) {
                    let err = new Error(`Invalid response: ${res.status} ${res.statusText}`);
                    err.status = res.status;
                    throw err;
                }

                return {
                    success: true,
                    target: webhooks,
                    duration
                };
            } catch (err) {
                logger.error({ msg: 'Failed posting webhook', webhooks, event: 'test', err });
                return {
                    success: false,
                    target: webhooks,
                    duration,
                    error: err.message
                };
            }
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                failAction,

                payload: Joi.object({
                    webhooks: Joi.string()
                        .uri({
                            scheme: ['http', 'https'],
                            allowRelative: false
                        })
                        .allow('')
                        .example('https://myservice.com/imap/webhooks')
                        .description('Webhook URL')
                })
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/admin/config/oauth/{provider?}',
        async handler(request, h) {
            let values = {
                provider: request.params.provider
            };

            let hasClientSecret, hasServiceKey;

            switch (values.provider) {
                case 'gmail':
                    values.oauth2Enabled = await settings.get('gmailEnabled');
                    values.clientId = await settings.get('gmailClientId');
                    hasClientSecret = !!(await settings.get('gmailClientSecret'));
                    values.redirectUrl = await settings.get('gmailRedirectUrl');

                    if (!values.clientId || !hasClientSecret) {
                        values.oauth2Enabled = false;
                    }
                    break;
                case 'gmailService':
                    values.oauth2Enabled = await settings.get('gmailServiceEnabled');
                    values.serviceClient = await settings.get('gmailServiceClient');
                    hasServiceKey = !!(await settings.get('gmailServiceKey'));

                    if (!values.serviceClient || !hasServiceKey) {
                        values.oauth2Enabled = false;
                    }
                    break;
                case 'outlook':
                    values.oauth2Enabled = await settings.get('outlookEnabled');
                    values.clientId = await settings.get('outlookClientId');
                    hasClientSecret = !!(await settings.get('outlookClientSecret'));
                    values.redirectUrl = await settings.get('outlookRedirectUrl');
                    values.authority = (await settings.get('outlookAuthority')) || 'consumers';

                    if (!values.clientId || !hasClientSecret) {
                        values.oauth2Enabled = false;
                    }
                    break;
                default: {
                    await request.flash({ type: 'danger', message: `Unknown OAuth2 provider requested` });
                    return h.redirect('/admin');
                }
            }

            let serviceUrl = await settings.get('serviceUrl');
            let defaultRedirectUrl = `${serviceUrl}/oauth`;
            if (values.provider === 'outlook') {
                defaultRedirectUrl = defaultRedirectUrl.replace(/^http:\/\/127\.0\.0\.1\b/i, 'http://localhost');
            }

            return h.view(
                'config/oauth',
                {
                    menuConfig: true,
                    menuConfigOauth: true,

                    activeGmail: values.provider === 'gmail',
                    activeGmailService: values.provider === 'gmailService',
                    activeOutlook: values.provider === 'outlook',

                    providerName: values.provider.replace(/^./, c => c.toUpperCase()),

                    hasClientSecret,
                    hasServiceKey,
                    defaultRedirectUrl,

                    values
                },
                {
                    layout: 'app'
                }
            );
        },

        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    logger.error({ msg: 'Failed to validate provider argument', err });
                    return h.redirect('/admin').takeover();
                },

                params: Joi.object({
                    provider: Joi.string().empty('').valid('gmail', 'gmailService', 'outlook').default('gmail').label('Provider')
                })
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/config/oauth',
        async handler(request, h) {
            try {
                const provider = request.payload.provider;
                const data = {};

                data[`${provider}Enabled`] = request.payload.oauth2Enabled;

                switch (provider) {
                    case 'gmail':
                        for (let key of ['clientId', 'clientSecret', 'redirectUrl']) {
                            if (typeof request.payload[key] !== 'undefined') {
                                data[`${provider}${key.replace(/^./, c => c.toUpperCase())}`] = request.payload[key];
                            }
                        }

                        break;

                    case 'gmailService':
                        for (let key of ['serviceClient', 'serviceKey']) {
                            if (typeof request.payload[key] !== 'undefined') {
                                data[`gmail${key.replace(/^./, c => c.toUpperCase())}`] = request.payload[key];
                            }
                        }

                        break;

                    case 'outlook':
                        for (let key of ['clientId', 'clientSecret', 'redirectUrl', 'authority']) {
                            if (typeof request.payload[key] !== 'undefined') {
                                data[`${provider}${key.replace(/^./, c => c.toUpperCase())}`] = request.payload[key];
                            }
                        }

                        break;

                    default:
                        await request.flash({ type: 'danger', message: `Unknown OAuth2 provider requested` });
                        return h.redirect('/admin');
                }

                if (['outlook', 'gmail'].includes(provider) && request.payload.clientId === '') {
                    // clear secret as well
                    data[`${provider}ClientSecret`] = '';
                }

                if (['gmailService'].includes(provider) && request.payload.serviceClient === '') {
                    // clear secret key as well
                    data.gmailServiceKey = '';
                }

                for (let key of Object.keys(data)) {
                    await settings.set(key, data[key]);
                }

                // clear alert flag if set
                await settings.clear(`${provider}AuthFlag`);

                await request.flash({ type: 'info', message: `Configuration updated` });

                return h.redirect(`/admin/config/oauth/${request.payload.provider}`);
            } catch (err) {
                await request.flash({ type: 'danger', message: `Failed to update configuration` });
                logger.error({ msg: 'Failed to update configuration', err });

                let serviceUrl = await settings.get('serviceUrl');
                let defaultRedirectUrl = `${serviceUrl}/oauth`;
                if (request.payload.provider === 'outlook') {
                    defaultRedirectUrl = defaultRedirectUrl.replace(/^http:\/\/127\.0\.0\.1\b/i, 'http://localhost');
                }

                return h.view(
                    'config/oauth',
                    {
                        menuConfig: true,
                        menuConfigOauth: true,

                        activeGmail: request.payload.provider === 'gmail',
                        activeGmailService: request.payload.provider === 'gmailService',
                        activeOutlook: request.payload.provider === 'outlook',

                        providerName: request.payload.provider.replace(/^./, c => c.toUpperCase()),

                        defaultRedirectUrl,

                        hasClientSecret: !!(await settings.get(`${request.payload.provider}ClientSecret`))
                    },
                    {
                        layout: 'app'
                    }
                );
            }
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    let errors = {};

                    if (err.details) {
                        err.details.forEach(detail => {
                            if (!errors[detail.path]) {
                                errors[detail.path] = detail.message;
                            }
                        });
                    }

                    await request.flash({ type: 'danger', message: `Failed to update configuration` });
                    logger.error({ msg: 'Failed to update configuration', err });

                    let serviceUrl = await settings.get('serviceUrl');
                    let defaultRedirectUrl = `${serviceUrl}/oauth`;
                    if (request.payload.provider === 'outlook') {
                        defaultRedirectUrl = defaultRedirectUrl.replace(/^http:\/\/127\.0\.0\.1\b/i, 'http://localhost');
                    }

                    return h
                        .view(
                            'config/oauth',
                            {
                                menuConfig: true,
                                menuConfigOauth: true,

                                activeGmail: request.payload.provider === 'gmail',
                                activeGmailService: request.payload.provider === 'gmailService',
                                activeOutlook: request.payload.provider === 'outlook',

                                providerName: request.payload.provider.replace(/^./, c => c.toUpperCase()),

                                hasClientSecret: !!(await settings.get(`${request.payload.provider}ClientSecret`)),

                                defaultRedirectUrl,

                                errors
                            },
                            {
                                layout: 'app'
                            }
                        )
                        .takeover();
                },

                payload: Joi.object(configOauthSchema)
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/admin/tokens',
        async handler(request, h) {
            const tokenList = await tokens.list();
            return h.view(
                'tokens/index',
                {
                    menuTokens: true,
                    tokenList: tokenList.map(entry => {
                        entry.access = entry.access || {};
                        entry.access.timeStr =
                            entry.access && entry.access.time && typeof entry.access.time.toISOString === 'function' ? entry.access.time.toISOString() : null;
                        entry.scopes = entry.scopes
                            ? entry.scopes.map((scope, i) => ({
                                  name: scope === '*' ? 'all scopes' : scope,
                                  first: !i
                              }))
                            : false;
                        return entry;
                    })
                },
                {
                    layout: 'app'
                }
            );
        }
    });

    server.route({
        method: 'GET',
        path: '/admin/tokens/new',
        async handler(request, h) {
            return h.view(
                'tokens/new',
                {
                    menuTokens: true,
                    values: {
                        scopesAll: true
                    }
                },
                {
                    layout: 'app'
                }
            );
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/tokens/new',

        async handler(request) {
            try {
                let data = {
                    ip: request.app.ip,
                    remoteAddress: request.app.ip,
                    description: request.payload.description,
                    scopes: request.payload.scopes
                };

                let token = await tokens.provision(data);

                return {
                    success: true,
                    token
                };
            } catch (err) {
                logger.error({ msg: 'Failed to generate token', err, remoteAddress: request.app.ip, description: request.payload.description });
                return { success: false, error: err.message };
            }
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                failAction,

                payload: Joi.object({
                    description: Joi.string().empty('').trim().max(1024).required().example('Token description').description('Token description'),
                    scopes: Joi.array().items(Joi.string().valid('*', 'api', 'metrics')).required().label('Scopes')
                })
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/tokens/delete',
        async handler(request, h) {
            try {
                let deleted = await tokens.delete(request.payload.token, { remoteAddress: request.app.ip });
                if (deleted) {
                    await request.flash({ type: 'info', message: `Access token was deleted` });
                }

                return h.redirect('/admin/tokens');
            } catch (err) {
                await request.flash({ type: 'danger', message: `Failed to delete access token` });
                logger.error({ msg: 'Failed to delete access token', err, token: request.payload.token, remoteAddress: request.app.ip });
                return h.redirect('/admin/tokens');
            }
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    await request.flash({ type: 'danger', message: `Failed to delete access token` });
                    logger.error({ msg: 'Failed to delete access token', err });

                    return h.redirect('/admin/tokens').takeover();
                },

                payload: Joi.object({ token: Joi.string().length(64).hex().required().example('123456').description('Access token') })
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/admin/login',
        async handler(request, h) {
            return h.view(
                'account/login',
                {
                    menuLogin: true,
                    values: {
                        username: 'admin',
                        next: request.query.next
                    }
                },
                {
                    layout: 'login'
                }
            );
        },
        options: {
            auth: false,

            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    logger.error({ msg: 'Failed to validate login arguments', err });
                    return h.redirect('/admin/login').takeover();
                },

                query: Joi.object({
                    next: Joi.string().uri({ relativeOnly: true }).label('NextUrl')
                })
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/admin/logout',
        async handler(request, h) {
            if (request.cookieAuth) {
                request.cookieAuth.clear();
            }
            return h.redirect('/');
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/login',
        async handler(request, h) {
            try {
                let authData = await settings.get('authData');
                if (authData && authData.password) {
                    try {
                        let valid = await pbkdf2.verify(authData.password, request.payload.password);
                        if (!valid) {
                            throw new Error('Invalid password');
                        }
                    } catch (E) {
                        logger.error({ msg: 'Failed to verify password hash', err: E, hash: authData.password });
                        let err = new Error('Failed to authenticate');
                        err.details = { password: err.message };
                        throw err;
                    }

                    request.cookieAuth.set({ user: authData.user });
                    if (request.payload.remember) {
                        request.cookieAuth.ttl(LOGIN_PERIOD_TTL);
                    }
                }

                await request.flash({ type: 'info', message: `Authentication successful` });

                if (request.payload.next) {
                    return h.redirect(request.payload.next);
                } else {
                    return h.redirect('/admin');
                }
            } catch (err) {
                await request.flash({ type: 'danger', message: `Failed to authenticate` });
                logger.error({ msg: 'Failed to authenticate', err });

                let errors = err.details;

                return h.view(
                    'account/login',
                    {
                        menuLogin: true,
                        errors
                    },
                    {
                        layout: 'login'
                    }
                );
            }
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    let errors = {};

                    if (err.details) {
                        err.details.forEach(detail => {
                            if (!errors[detail.path]) {
                                errors[detail.path] = detail.message;
                            }
                        });
                    }

                    await request.flash({ type: 'danger', message: `Failed to authenticate` });
                    logger.error({ msg: 'Failed to authenticate', err });

                    return h
                        .view(
                            'account/login',
                            {
                                menuLogin: true,
                                errors
                            },
                            {
                                layout: 'login'
                            }
                        )
                        .takeover();
                },

                payload: Joi.object({
                    username: Joi.string().max(256).example('user').label('Username').description('Your account username'),
                    password: Joi.string().max(256).min(8).required().example('secret').label('Password').description('Your account password'),
                    remember: Joi.boolean().truthy('Y', 'true', '1', 'on').falsy('N', 'false', 0, '').default(false).description('Remember me'),
                    next: Joi.string().uri({ relativeOnly: true }).label('NextUrl')
                })
            },

            auth: {
                strategy: 'session',
                mode: 'try'
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/admin/account/password',
        async handler(request, h) {
            return h.view(
                'account/password',
                {
                    menuPassword: true,
                    disableAuthWarning: true,

                    username: 'admin' //fixed value
                },
                {
                    layout: 'app'
                }
            );
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/account/password',
        async handler(request, h) {
            try {
                let authData = await settings.get('authData');
                if (authData && authData.password) {
                    try {
                        let valid = await pbkdf2.verify(authData.password, request.payload.password0);
                        if (!valid) {
                            throw new Error('Invalid current password');
                        }
                    } catch (E) {
                        logger.error({ msg: 'Failed to verify password hash', err: E, hash: authData.password });
                        let err = new Error('Failed to verify current password');
                        err.details = { password0: err.message };
                        throw err;
                    }
                }

                const passwordHash = await pbkdf2.hash(request.payload.password, {
                    iterations: PDKDF2_ITERATIONS,
                    saltSize: PDKDF2_SALT_SIZE,
                    digest: PDKDF2_DIGEST
                });

                authData = authData || {};
                authData.user = authData.user || 'admin';
                authData.password = passwordHash;

                await settings.set('authData', authData);

                if (!server.auth.settings.default) {
                    server.auth.default('session');
                    request.cookieAuth.set({ user: authData.user });
                }

                await request.flash({ type: 'info', message: `Authentication password updated` });

                return h.redirect('/admin/account/password');
            } catch (err) {
                await request.flash({ type: 'danger', message: `Failed to update password` });
                logger.error({ msg: 'Failed to update password', err });

                return h.view(
                    'account/password',
                    {
                        menuPassword: true,
                        disableAuthWarning: true,
                        errors: err.details,

                        username: 'admin' //fixed value
                    },
                    {
                        layout: 'app'
                    }
                );
            }
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    let errors = {};

                    if (err.details) {
                        err.details.forEach(detail => {
                            if (!errors[detail.path]) {
                                errors[detail.path] = detail.message;
                            }
                        });
                    }

                    await request.flash({ type: 'danger', message: `Failed to update account password` });
                    logger.error({ msg: 'Failed to update account password', err });

                    return h
                        .view(
                            'account/password',
                            {
                                menuPassword: true,
                                disableAuthWarning: true,
                                errors,

                                username: 'admin' //fixed value
                            },
                            {
                                layout: 'app'
                            }
                        )
                        .takeover();
                },

                payload: Joi.object({
                    password0: Joi.string().max(256).min(8).example('secret').label('Currrent password').description('Current password'),
                    password: Joi.string().max(256).min(8).required().example('secret').label('New password').description('New password'),
                    password2: Joi.string()
                        .max(256)
                        .required()
                        .example('secret')
                        .label('Repeat password')
                        .description('Repeat password')
                        .valid(Joi.ref('password'))
                })
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/admin/accounts',
        async handler(request, h) {
            let accountObject = new Account({ redis });

            const accounts = await accountObject.listAccounts(request.query.state, request.query.page - 1, request.query.pageSize);

            if (accounts.pages < request.query.page) {
                request.query.page = accounts.pages;
            }

            for (let account of accounts.accounts) {
                let accountObject = new Account({ redis, account: account.account });
                account.data = await accountObject.loadAccountData();
            }

            let nextPage = false;
            let prevPage = false;

            let getPagingUrl = page => {
                let url = new URL(`admin/accounts`, 'http://localhost');
                url.searchParams.append('page', page);
                if (request.query.pageSize !== DEFAULT_PAGE_SIZE) {
                    url.searchParams.append('pageSize', request.query.pageSize);
                }
                return url.pathname + url.search;
            };

            if (accounts.pages > accounts.page + 1) {
                nextPage = getPagingUrl(accounts.page + 2);
            }

            if (accounts.page > 0) {
                prevPage = getPagingUrl(accounts.page);
            }

            return h.view(
                'accounts/index',
                {
                    menuAccounts: true,

                    showPaging: accounts.pages > 1,
                    nextPage,
                    prevPage,
                    firstPage: accounts.page === 0,
                    pageLinks: new Array(accounts.pages || 1).fill(0).map((z, i) => ({
                        url: getPagingUrl(i + 1),
                        title: i + 1,
                        active: i === accounts.page
                    })),

                    accounts: accounts.accounts.map(account => formatAccountData(account.data || account)),

                    curpage: encodeURIComponent(request.url.pathname + request.url.search)
                },
                {
                    layout: 'app'
                }
            );
        },

        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h /*, err*/) {
                    return h.redirect('/admin/accounts').takeover();
                },

                query: Joi.object({
                    page: Joi.number().min(1).max(1000000).default(1),
                    pageSize: Joi.number().min(1).max(250).default(DEFAULT_PAGE_SIZE)
                })
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/accounts/new',

        async handler(request, h) {
            let { data, signature } = await getSignedFormData({
                account: request.payload.account,
                name: request.payload.name
            });

            let url = new URL(`accounts/new`, 'http://localhost');

            url.searchParams.append('data', data.toString('base64url'));
            if (signature) {
                url.searchParams.append('sig', signature);
            }

            return h.redirect(url.pathname + url.search);
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    let errors = {};

                    if (err.details) {
                        err.details.forEach(detail => {
                            if (!errors[detail.path]) {
                                errors[detail.path] = detail.message;
                            }
                        });
                    }

                    await request.flash({ type: 'danger', message: `Failed to set up account${errors.account ? `: ${errors.account}` : ''}` });
                    logger.error({ msg: 'Failed to update configuration', err });

                    return h.redirect('/admin/accounts').takeover();
                },

                payload: Joi.object({
                    account: Joi.string().empty('').max(256).default(null).example('johnsmith').description('Account ID'),
                    name: Joi.string().empty('').max(256).example('John Smith').description('Account Name')
                })
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/accounts/new',
        async handler(request, h) {
            let data = Buffer.from(request.query.data, 'base64url').toString();
            let serviceSecret = await settings.get('serviceSecret');
            if (serviceSecret) {
                let hmac = crypto.createHmac('sha256', serviceSecret);
                hmac.update(data);
                if (hmac.digest('base64url') !== request.query.sig) {
                    let error = Boom.boomify(new Error('Signature validation failed'), { statusCode: 403 });
                    throw error;
                }
            }

            let gmailEnabled = await settings.get('gmailEnabled');
            if (gmailEnabled && (!(await settings.get('gmailClientId')) || !(await settings.get('gmailClientSecret')))) {
                gmailEnabled = false;
            }

            let outlookEnabled = await settings.get('outlookEnabled');
            if (outlookEnabled && (!(await settings.get('outlookClientId')) || !(await settings.get('outlookClientSecret')))) {
                outlookEnabled = false;
            }

            return h.view(
                'accounts/register/index',
                {
                    values: {
                        data: request.query.data,
                        sig: request.query.sig
                    },

                    gmailEnabled,
                    outlookEnabled
                },
                {
                    layout: 'public'
                }
            );
        },
        options: {
            auth: false,

            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    logger.error({ msg: 'Failed to validate request arguments', err });
                    let error = Boom.boomify(new Error('Failed to validate request arguments'), { statusCode: 400 });
                    if (err.code) {
                        error.output.payload.code = err.code;
                    }
                    throw error;
                },

                query: Joi.object({
                    data: Joi.string().base64({ paddingRequired: false, urlSafe: true }).required(),
                    sig: Joi.string().base64({ paddingRequired: false, urlSafe: true })
                })
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/accounts/new',

        async handler(request, h) {
            let data = Buffer.from(request.payload.data, 'base64url').toString();
            let serviceSecret = await settings.get('serviceSecret');
            if (serviceSecret) {
                let hmac = crypto.createHmac('sha256', serviceSecret);
                hmac.update(data);
                if (hmac.digest('base64url') !== request.payload.sig) {
                    let error = Boom.boomify(new Error('Signature validation failed'), { statusCode: 403 });
                    throw error;
                }
            }

            data = JSON.parse(data);

            let oauth2Enabled;

            if (['gmail', 'outlook'].includes(request.payload.type)) {
                oauth2Enabled = !!(
                    (await settings.get(`${request.payload.type}Enabled`)) &&
                    (await settings.get(`${request.payload.type}ClientId`)) &&
                    (await settings.get(`${request.payload.type}ClientSecret`))
                );
            }

            if (['gmail', 'outlook'].includes(request.payload.type) && oauth2Enabled) {
                // prepare account entry
                let accountData = {
                    account: data.account
                };

                if (data.name) {
                    accountData.name = data.name;
                }

                if (data.email) {
                    accountData.email = data.email;
                }

                if (data.redirectUrl) {
                    accountData._meta = {
                        redirectUrl: data.redirectUrl
                    };
                }

                const oAuth2Client = await getOAuth2Client(request.payload.type);
                let nonce = crypto.randomBytes(12).toString('hex');

                accountData.notifyFrom = new Date().toISOString();
                accountData.copy = false;
                accountData.oauth2 = {
                    provider: request.payload.type
                };

                // store account data
                await redis
                    .multi()
                    .set(`${REDIS_PREFIX}account:add:${nonce}`, JSON.stringify(accountData))
                    .expire(`${REDIS_PREFIX}account:add:${nonce}`, 1 * 24 * 3600)
                    .exec();

                // Generate the url that will be used for the consent dialog.

                let requestPyload = {
                    state: `account:add:${nonce}`
                };

                if (accountData.email) {
                    requestPyload.email = accountData.email;
                }

                let authorizeUrl;
                switch (request.payload.type) {
                    case 'gmail':
                    case 'outlook':
                        authorizeUrl = oAuth2Client.generateAuthUrl(requestPyload);
                        break;

                    default: {
                        let error = Boom.boomify(new Error('Unknown OAuth provider'), { statusCode: 400 });
                        throw error;
                    }
                }

                return h.redirect(authorizeUrl);
            }

            return h.view(
                'accounts/register/imap',
                {
                    values: {
                        data: request.payload.data,
                        sig: request.payload.sig,

                        email: data.email,
                        name: data.name
                    }
                },
                {
                    layout: 'public'
                }
            );
        },
        options: {
            auth: false,

            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    logger.error({ msg: 'Failed to validate request arguments', err });
                    let error = Boom.boomify(new Error('Failed to validate request arguments'), { statusCode: 400 });
                    if (err.code) {
                        error.output.payload.code = err.code;
                    }
                    throw error;
                },

                payload: Joi.object({
                    data: Joi.string().base64({ paddingRequired: false, urlSafe: true }).required(),
                    sig: Joi.string().base64({ paddingRequired: false, urlSafe: true }),
                    type: Joi.string().valid('imap', 'gmail', 'outlook').required()
                })
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/accounts/new/imap',

        async handler(request, h) {
            let data = Buffer.from(request.payload.data, 'base64url').toString();
            let serviceSecret = await settings.get('serviceSecret');
            if (serviceSecret) {
                let hmac = crypto.createHmac('sha256', serviceSecret);
                hmac.update(data);
                if (hmac.digest('base64url') !== request.payload.sig) {
                    let error = Boom.boomify(new Error('Signature validation failed'), { statusCode: 403 });
                    throw error;
                }
            }

            data = JSON.parse(data);

            let serverSettings;
            try {
                serverSettings = await autodetectImapSettings(request.payload.email);
            } catch (err) {
                logger.error({ msg: 'Failed to resolve email server settings', email: request.payload.email, err });
            }

            let values = Object.assign(
                {
                    name: request.payload.name,
                    email: request.payload.email,
                    password: request.payload.password,
                    data: request.payload.data,
                    sig: request.payload.sig
                },
                flattenObjectKeys(serverSettings)
            );

            values.imap_auth_user = values.imap_auth_user || request.payload.email;
            values.smtp_auth_user = values.smtp_auth_user || request.payload.email;

            values.imap_auth_pass = request.payload.password;
            values.smtp_auth_pass = request.payload.password;

            return h.view(
                'accounts/register/imap-server',
                {
                    values
                },
                {
                    layout: 'public'
                }
            );
        },
        options: {
            auth: false,

            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    let errors = {};

                    if (err.details) {
                        err.details.forEach(detail => {
                            if (!errors[detail.path]) {
                                errors[detail.path] = detail.message;
                            }
                        });
                    }

                    await request.flash({ type: 'danger', message: `Failed to process account` });
                    logger.error({ msg: 'Failed to process account', err });

                    return h
                        .view(
                            'accounts/register/imap',
                            {
                                errors
                            },
                            {
                                layout: 'public'
                            }
                        )
                        .takeover();
                },

                payload: Joi.object({
                    data: Joi.string().base64({ paddingRequired: false, urlSafe: true }).required(),
                    sig: Joi.string().base64({ paddingRequired: false, urlSafe: true }),
                    name: Joi.string().empty('').max(256).example('John Smith').description('Account Name'),
                    email: Joi.string().email().required().example('user@example.com').label('Email').description('Your account email'),
                    password: Joi.string().max(1024).min(1).required().example('secret').label('Password').description('Your account password')
                })
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/accounts/new/imap/test',
        async handler(request) {
            try {
                let verifyResult = await verifyAccountInfo({
                    imap: {
                        host: request.payload.imap_host,
                        port: request.payload.imap_port,
                        secure: request.payload.imap_secure,
                        auth: {
                            user: request.payload.imap_auth_user,
                            pass: request.payload.imap_auth_pass
                        }
                    },
                    smtp: {
                        host: request.payload.smtp_host,
                        port: request.payload.smtp_port,
                        secure: request.payload.smtp_secure,
                        auth: {
                            user: request.payload.smtp_auth_user,
                            pass: request.payload.smtp_auth_pass
                        }
                    }
                });

                if (verifyResult) {
                    if (verifyResult.imap && verifyResult.imap.error && verifyResult.imap.code) {
                        switch (verifyResult.imap.code) {
                            case 'ENOTFOUND':
                                verifyResult.imap.error = 'Server hostname was not found';
                                break;
                            case 'AUTHENTICATIONFAILED':
                                verifyResult.imap.error = 'Invalid username or password';
                                break;
                        }
                    }

                    if (verifyResult.smtp && verifyResult.smtp.error && verifyResult.smtp.code) {
                        switch (verifyResult.smtp.code) {
                            case 'EDNS':
                                verifyResult.smtp.error = 'Server hostname was not found';
                                break;

                            case 'EAUTH':
                                verifyResult.smtp.error = 'Invalid username or password';
                                break;

                            case 'ESOCKET':
                                if (/openssl/.test(verifyResult.smtp.error)) {
                                    verifyResult.smtp.error = 'TLS protocol error';
                                }
                                break;
                        }
                    }
                }

                return verifyResult;
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                let error = Boom.boomify(err, { statusCode: err.statusCode || 500 });
                if (err.code) {
                    error.output.payload.code = err.code;
                }
                throw error;
            }
        },
        options: {
            auth: false,

            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                failAction,

                payload: Joi.object({
                    imap_auth_user: Joi.string().empty('').trim().max(1024).required(),
                    imap_auth_pass: Joi.string().empty('').max(1024).required(),
                    imap_host: Joi.string().hostname().required().example('imap.gmail.com').description('Hostname to connect to'),
                    imap_port: Joi.number()
                        .min(1)
                        .max(64 * 1024)
                        .required()
                        .example(993)
                        .description('Service port number'),
                    imap_secure: Joi.boolean()
                        .truthy('Y', 'true', '1', 'on')
                        .falsy('N', 'false', 0, '')
                        .default(false)
                        .example(true)
                        .description('Should connection use TLS. Usually true for port 993'),

                    smtp_auth_user: Joi.string().empty('').trim().max(1024).required(),
                    smtp_auth_pass: Joi.string().empty('').max(1024).required(),
                    smtp_host: Joi.string().hostname().required().example('smtp.gmail.com').description('Hostname to connect to'),
                    smtp_port: Joi.number()
                        .min(1)
                        .max(64 * 1024)
                        .required()
                        .example(465)
                        .description('Service port number'),
                    smtp_secure: Joi.boolean()
                        .truthy('Y', 'true', '1', 'on')
                        .falsy('N', 'false', 0, '')
                        .default(false)
                        .example(true)
                        .description('Should connection use TLS. Usually true for port 465')
                })
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/accounts/new/imap/server',

        async handler(request, h) {
            let data = Buffer.from(request.payload.data, 'base64url').toString();
            let serviceSecret = await settings.get('serviceSecret');
            if (serviceSecret) {
                let hmac = crypto.createHmac('sha256', serviceSecret);
                hmac.update(data);
                if (hmac.digest('base64url') !== request.payload.sig) {
                    let error = Boom.boomify(new Error('Signature validation failed'), { statusCode: 403 });
                    throw error;
                }
            }

            data = JSON.parse(data);

            let accountData = {
                account: data.account,
                name: request.payload.name || data.name,
                email: request.payload.email,

                notifyFrom: new Date(),

                imap: {
                    host: request.payload.imap_host,
                    port: request.payload.imap_port,
                    secure: request.payload.imap_secure,
                    auth: {
                        user: request.payload.imap_auth_user,
                        pass: request.payload.imap_auth_pass
                    }
                },
                smtp: {
                    host: request.payload.smtp_host,
                    port: request.payload.smtp_port,
                    secure: request.payload.smtp_secure,
                    auth: {
                        user: request.payload.smtp_auth_user,
                        pass: request.payload.smtp_auth_pass
                    }
                }
            };

            let accountObject = new Account({ redis, call, secret: await getSecret() });
            let result = await accountObject.create(accountData);

            let httpRedirectUrl;
            if (data.redirectUrl) {
                let serviceUrl = await settings.get('serviceUrl');
                let url = new URL(data.redirectUrl, serviceUrl);
                url.searchParams.set('account', result.account);
                url.searchParams.set('state', result.state);
                httpRedirectUrl = url.href;
            } else {
                httpRedirectUrl = `/admin/accounts/${result.account}`;
            }

            return h.view(
                'redirect',
                { httpRedirectUrl },
                {
                    layout: 'public'
                }
            );
        },
        options: {
            auth: false,

            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    let errors = {};

                    if (err.details) {
                        err.details.forEach(detail => {
                            if (!errors[detail.path]) {
                                errors[detail.path] = detail.message;
                            }
                        });
                    }

                    await request.flash({ type: 'danger', message: `Failed to process account` });
                    logger.error({ msg: 'Failed to process account', err });

                    return h
                        .view(
                            'accounts/register/imap-server',
                            {
                                errors
                            },
                            {
                                layout: 'public'
                            }
                        )
                        .takeover();
                },

                payload: Joi.object({
                    data: Joi.string().base64({ paddingRequired: false, urlSafe: true }).required(),
                    sig: Joi.string().base64({ paddingRequired: false, urlSafe: true }),
                    name: Joi.string().empty('').max(256).example('John Smith').description('Account Name'),
                    email: Joi.string().email().required().example('user@example.com').label('Email').description('Your account email'),
                    imap_auth_user: Joi.string().empty('').trim().max(1024).required(),
                    imap_auth_pass: Joi.string().empty('').max(1024).required(),
                    imap_host: Joi.string().hostname().required().example('imap.gmail.com').description('Hostname to connect to'),
                    imap_port: Joi.number()
                        .min(1)
                        .max(64 * 1024)
                        .required()
                        .example(993)
                        .description('Service port number'),
                    imap_secure: Joi.boolean()
                        .truthy('Y', 'true', '1', 'on')
                        .falsy('N', 'false', 0, '')
                        .default(false)
                        .example(true)
                        .description('Should connection use TLS. Usually true for port 993'),

                    smtp_auth_user: Joi.string().empty('').trim().max(1024).required(),
                    smtp_auth_pass: Joi.string().empty('').max(1024).required(),
                    smtp_host: Joi.string().hostname().required().example('smtp.gmail.com').description('Hostname to connect to'),
                    smtp_port: Joi.number()
                        .min(1)
                        .max(64 * 1024)
                        .required()
                        .example(465)
                        .description('Service port number'),
                    smtp_secure: Joi.boolean()
                        .truthy('Y', 'true', '1', 'on')
                        .falsy('N', 'false', 0, '')
                        .default(false)
                        .example(true)
                        .description('Should connection use TLS. Usually true for port 465')
                })
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/admin/accounts/{account}',
        async handler(request, h) {
            let accountObject = new Account({ redis, account: request.params.account, call, secret: await getSecret() });
            let accountData;
            try {
                // throws if account does not exist
                accountData = await accountObject.loadAccountData();
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                let error = Boom.boomify(err, { statusCode: err.statusCode || 500 });
                if (err.code) {
                    error.output.payload.code = err.code;
                }
                throw error;
            }

            accountData = formatAccountData(accountData);

            let oauth2ProviderEnabled = false;
            if (accountData.oauth2 && accountData.oauth2.provider) {
                let provider = accountData.oauth2.provider;
                oauth2ProviderEnabled = await settings.get(`${provider}Enabled`);
                if (oauth2ProviderEnabled && (!(await settings.get(`${provider}ClientId`)) || !(await settings.get(`${provider}ClientSecret`)))) {
                    oauth2ProviderEnabled = false;
                }
            }

            return h.view(
                'accounts/account',
                {
                    menuAccounts: true,
                    account: accountData,
                    logs: await settings.get('logs'),
                    smtpError: accountData.smtpStatus && accountData.smtpStatus.status === 'error',

                    oauth2ProviderEnabled,
                    accountForm: await getSignedFormData({
                        account: request.params.account,
                        name: accountData.name,
                        email: accountData.email,
                        redirectUrl: `/admin/accounts/${request.params.account}`
                    })
                },
                {
                    layout: 'app'
                }
            );
        },

        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    await request.flash({ type: 'danger', message: `Invalid account request: ${err.message}` });
                    return h.redirect('/admin/accounts').takeover();
                },

                params: Joi.object({
                    account: Joi.string().max(256).required().example('johnsmith').description('Account ID')
                })
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/accounts/{account}/delete',
        async handler(request, h) {
            try {
                let accountObject = new Account({ redis, account: request.params.account, call, secret: await getSecret() });

                let deleted = await accountObject.delete();
                if (deleted) {
                    await request.flash({ type: 'info', message: `Account was deleted` });
                }

                return h.redirect('/admin/accounts');
            } catch (err) {
                await request.flash({ type: 'danger', message: `Failed to delete the account` });
                logger.error({ msg: 'Failed to delete the account', err, account: request.payload.account, remoteAddress: request.app.ip });
                return h.redirect(`/admin/accounts/${request.params.account}`);
            }
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    await request.flash({ type: 'danger', message: `Failed to delete the account` });
                    logger.error({ msg: 'Failed to delete delete the account', err });

                    return h.redirect('/admin/accounts').takeover();
                },

                params: Joi.object({
                    account: Joi.string().max(256).required().example('johnsmith').description('Account ID')
                })
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/accounts/{account}/reconnect',
        async handler(request) {
            let account = request.params.account;
            try {
                logger.info({ msg: 'Request reconnect for logging', account });
                try {
                    await call({ cmd: 'update', account });
                } catch (err) {
                    logger.error({ msg: 'Reconnect request failed', action: 'request_reconnect', account, err });
                }

                return {
                    success: true
                };
            } catch (err) {
                logger.error({ msg: 'Failed to request reconnect', err, account });
                return { success: false, error: err.message };
            }
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                failAction,

                params: Joi.object({
                    account: Joi.string().max(256).required().example('johnsmith').description('Account ID')
                })
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/accounts/{account}/logs',
        async handler(request) {
            let account = request.params.account;
            let accountObject = new Account({ redis, account });
            try {
                logger.info({ msg: 'Request to update account logging state', account, enabled: request.payload.enabled });

                await redis.hset(accountObject.getAccountKey(), 'logs', request.payload.enabled ? 'true' : 'false');

                return {
                    success: true,
                    enabled: (await redis.hget(accountObject.getAccountKey(), 'logs')) === 'true'
                };
            } catch (err) {
                logger.error({ msg: 'Failed to update account logging state', err, account, enabled: request.payload.enabled });
                return { success: false, error: err.message };
            }
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                failAction,

                params: Joi.object({
                    account: Joi.string().max(256).required().example('johnsmith').description('Account ID')
                }),

                payload: Joi.object({
                    enabled: Joi.boolean().truthy('Y', 'true', '1', 'on').falsy('N', 'false', 0, '').default(false)
                })
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/accounts/{account}/logs-flush',
        async handler(request) {
            let account = request.params.account;
            let accountObject = new Account({ redis, account });
            try {
                logger.info({ msg: 'Request to flush logs', account });

                await redis.del(accountObject.getLogKey());

                return {
                    success: true
                };
            } catch (err) {
                logger.error({ msg: 'Failed to flush logs', err, account });
                return { success: false, error: err.message };
            }
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                failAction,

                params: Joi.object({
                    account: Joi.string().max(256).required().example('johnsmith').description('Account ID')
                })
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/admin/accounts/{account}/logs.txt',
        async handler(request) {
            return getLogs(redis, request.params.account);
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                failAction,

                params: Joi.object({
                    account: Joi.string().max(256).required().example('johnsmith').description('Account ID')
                })
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/admin/accounts/{account}/edit',
        async handler(request, h) {
            let accountObject = new Account({ redis, account: request.params.account, call, secret: await getSecret() });
            let accountData;
            try {
                // throws if account does not exist
                accountData = await accountObject.loadAccountData();
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                let error = Boom.boomify(err, { statusCode: err.statusCode || 500 });
                if (err.code) {
                    error.output.payload.code = err.code;
                }
                throw error;
            }

            let values = Object.assign({}, flattenObjectKeys(accountData), {
                imap: !!accountData.imap,
                smtp: !!accountData.smtp,
                oauth2: !!accountData.oauth2,

                imap_auth_pass: '',
                smtp_auth_pass: ''
            });

            return h.view(
                'accounts/edit',
                {
                    menuAccounts: true,
                    account: request.params.account,
                    values
                },
                {
                    layout: 'app'
                }
            );
        },

        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    await request.flash({ type: 'danger', message: `Invalid account request: ${err.message}` });
                    return h.redirect('/admin/accounts').takeover();
                },

                params: Joi.object({
                    account: Joi.string().max(256).required().example('johnsmith').description('Account ID')
                })
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/accounts/{account}/edit',
        async handler(request, h) {
            try {
                let accountObject = new Account({ redis, account: request.params.account, call, secret: await getSecret() });

                let oldData = await accountObject.loadAccountData();

                let updates = {
                    account: request.params.account,
                    name: request.payload.name || '',
                    email: request.payload.email,
                    proxy: request.payload.proxy
                };

                if (request.payload.imap) {
                    let imapAuth = Object.assign((oldData.imap && oldData.imap.auth) || {}, { user: request.payload.imap_auth_user });
                    let imapTls = (oldData.imap && oldData.imap.tls) || {};

                    if (request.payload.imap_auth_pass) {
                        imapAuth.pass = request.payload.imap_auth_pass;
                    }

                    updates.imap = Object.assign(oldData.imap || {}, {
                        host: request.payload.imap_host,
                        port: request.payload.imap_port,
                        secure: request.payload.imap_secure,
                        auth: imapAuth,
                        tls: imapTls
                    });

                    if (request.payload.imap_resyncDelay) {
                        updates.imap.resyncDelay = request.payload.imap_resyncDelay;
                    }
                }

                if (request.payload.smtp) {
                    let smtpAuth = Object.assign((oldData.smtp && oldData.smtp.auth) || {}, { user: request.payload.smtp_auth_user });
                    let smtpTls = (oldData.smtp && oldData.smtp.tls) || {};

                    if (request.payload.smtp_auth_pass) {
                        smtpAuth.pass = request.payload.smtp_auth_pass;
                    }

                    updates.smtp = Object.assign(oldData.smtp || {}, {
                        host: request.payload.smtp_host,
                        port: request.payload.smtp_port,
                        secure: request.payload.smtp_secure,
                        auth: smtpAuth,
                        tls: smtpTls
                    });
                }

                await accountObject.update(updates);

                return h.redirect(`/admin/accounts/${request.params.account}`);
            } catch (err) {
                await request.flash({ type: 'danger', message: `Failed to update account settings` });
                logger.error({ msg: 'Failed to update account settings', err, account: request.params.account });

                return h.view(
                    'accounts/edit',
                    {
                        menuAccounts: true,
                        account: request.params.account
                    },
                    {
                        layout: 'app'
                    }
                );
            }
        },

        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    let errors = {};

                    if (err.details) {
                        err.details.forEach(detail => {
                            if (!errors[detail.path]) {
                                errors[detail.path] = detail.message;
                            }
                        });
                    }

                    await request.flash({ type: 'danger', message: `Failed to update configuration` });
                    logger.error({ msg: 'Failed to update configuration', err });

                    return h
                        .view(
                            'accounts/edit',
                            {
                                menuAccounts: true,
                                account: request.params.account,
                                errors
                            },
                            {
                                layout: 'app'
                            }
                        )
                        .takeover();
                },

                params: Joi.object({
                    account: Joi.string().max(256).required().example('johnsmith').description('Account ID')
                }),

                payload: Joi.object({
                    name: Joi.string().empty('').max(256).example('John Smith').description('Account Name'),
                    email: Joi.string().email().required().example('user@example.com').label('Email').description('Your account email'),

                    proxy: settingsSchema.proxyUrl,

                    imap: Joi.boolean().truthy('Y', 'true', '1', 'on').falsy('N', 'false', 0, '').default(false),

                    imap_auth_user: Joi.string().empty('').trim().max(1024),
                    imap_auth_pass: Joi.string().empty('').max(1024),
                    imap_host: Joi.string().hostname().example('imap.gmail.com').description('Hostname to connect to'),
                    imap_port: Joi.number()
                        .min(1)
                        .max(64 * 1024)
                        .example(993)
                        .description('Service port number'),
                    imap_secure: Joi.boolean()
                        .truthy('Y', 'true', '1', 'on')
                        .falsy('N', 'false', 0, '')
                        .default(false)
                        .example(true)
                        .description('Should connection use TLS. Usually true for port 993'),
                    imap_resyncDelay: Joi.number().empty(''),

                    smtp: Joi.boolean().truthy('Y', 'true', '1', 'on').falsy('N', 'false', 0, '').default(false),

                    smtp_auth_user: Joi.string().empty('').trim().max(1024),
                    smtp_auth_pass: Joi.string().empty('').max(1024),
                    smtp_host: Joi.string().hostname().example('smtp.gmail.com').description('Hostname to connect to'),
                    smtp_port: Joi.number()
                        .min(1)
                        .max(64 * 1024)
                        .example(465)
                        .description('Service port number'),
                    smtp_secure: Joi.boolean()
                        .truthy('Y', 'true', '1', 'on')
                        .falsy('N', 'false', 0, '')
                        .default(false)
                        .example(true)
                        .description('Should connection use TLS. Usually true for port 465')
                })
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/admin/config/network',
        async handler(request, h) {
            let smtpStrategy = (await settings.get('smtpStrategy')) || 'default';
            let imapStrategy = (await settings.get('imapStrategy')) || 'default';

            let proxyEnabled = await settings.get('proxyEnabled');
            let proxyUrl = await settings.get('proxyUrl');

            let localAddresses = [].concat((await settings.get('localAddresses')) || []);

            let smtpStrategies = ADDRESS_STRATEGIES.map(entry => Object.assign({ selected: smtpStrategy === entry.key }, entry));
            let imapStrategies = ADDRESS_STRATEGIES.map(entry => Object.assign({ selected: imapStrategy === entry.key }, entry));

            return h.view(
                'config/network',
                {
                    menuConfig: true,
                    menuConfigNetwork: true,

                    smtpStrategies,
                    imapStrategies,

                    values: {
                        proxyEnabled,
                        proxyUrl
                    },

                    addresses: await listPublicInterfaces(localAddresses),
                    addressListTemplate: cachedTemplates.addressList
                },
                {
                    layout: 'app'
                }
            );
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/config/network/reload',
        async handler() {
            try {
                await updatePublicInterfaces();

                let localAddresses = [].concat((await settings.get('localAddresses')) || []);

                return {
                    success: true,
                    addresses: await listPublicInterfaces(localAddresses)
                };
            } catch (err) {
                logger.error({ msg: 'Failed loading public IP addresses', err });
                return {
                    success: false,
                    error: err.message
                };
            }
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                failAction
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/config/network',
        async handler(request, h) {
            try {
                for (let key of ['smtpStrategy', 'imapStrategy', 'localAddresses', 'proxyUrl', 'proxyEnabled']) {
                    await settings.set(key, request.payload[key]);
                }

                await request.flash({ type: 'info', message: `Configuration updated` });

                return h.redirect('/admin/config/network');
            } catch (err) {
                await request.flash({ type: 'danger', message: `Failed to update configuration` });
                logger.error({ msg: 'Failed to update configuration', err });

                let smtpStrategies = ADDRESS_STRATEGIES.map(entry => Object.assign({ selected: request.payload.smtpStrategy === entry.key }, entry));
                let imapStrategies = ADDRESS_STRATEGIES.map(entry => Object.assign({ selected: request.payload.imapStrategy === entry.key }, entry));

                return h.view(
                    'config/network',
                    {
                        menuConfig: true,
                        menuConfigNetwork: true,
                        smtpStrategies,
                        imapStrategies,

                        addresses: await listPublicInterfaces(request.payload.localAddresses),
                        addressListTemplate: cachedTemplates.addressList
                    },
                    {
                        layout: 'app'
                    }
                );
            }
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    let errors = {};

                    if (err.details) {
                        err.details.forEach(detail => {
                            if (!errors[detail.path]) {
                                errors[detail.path] = detail.message;
                            }
                        });
                    }

                    await request.flash({ type: 'danger', message: `Failed to update configuration` });
                    logger.error({ msg: 'Failed to update configuration', err });

                    let smtpStrategies = ADDRESS_STRATEGIES.map(entry => Object.assign({ selected: request.payload.smtpStrategy === entry.key }, entry));
                    let imapStrategies = ADDRESS_STRATEGIES.map(entry => Object.assign({ selected: request.payload.imapStrategy === entry.key }, entry));

                    return h
                        .view(
                            'config/network',
                            {
                                menuConfig: true,
                                menuConfigNetwork: true,
                                smtpStrategies,
                                imapStrategies,

                                addresses: await listPublicInterfaces(request.payload.localAddresses),
                                addressListTemplate: cachedTemplates.addressList,

                                errors
                            },
                            {
                                layout: 'app'
                            }
                        )
                        .takeover();
                },
                payload: Joi.object({
                    imapStrategy: settingsSchema.imapStrategy.default('default'),
                    smtpStrategy: settingsSchema.smtpStrategy.default('default'),
                    localAddresses: settingsSchema.localAddresses.default([]),

                    proxyUrl: settingsSchema.proxyUrl,
                    proxyEnabled: settingsSchema.proxyEnabled
                })
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/config/network/delete',
        async handler(request, h) {
            try {
                let localAddress = request.payload.localAddress;
                let localAddresses = [].concat((await settings.get('localAddresses')) || []);
                if (localAddresses.includes(localAddress)) {
                    let list = new Set(localAddresses);
                    list.delete(localAddress);
                    localAddresses = Array.from(list);
                    await settings.set('localAddresses', localAddresses);
                }

                await redis.hdel(`${REDIS_PREFIX}interfaces`, localAddress);

                await request.flash({ type: 'info', message: `Address was removed from the list` });
                return h.redirect('/admin/config/network');
            } catch (err) {
                await request.flash({ type: 'danger', message: `Failed to delete address` });
                logger.error({ msg: 'Failed to delete address', err, localAddress: request.payload.localAddress, remoteAddress: request.app.ip });
                return h.redirect('/admin/config/network');
            }
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    await request.flash({ type: 'danger', message: `Failed to delete address` });
                    logger.error({ msg: 'Failed to delete address', err });

                    return h.redirect('/admin/config/network').takeover();
                },

                payload: Joi.object({
                    localAddress: Joi.string().ip({
                        version: ['ipv4', 'ipv6'],
                        cidr: 'forbidden'
                    })
                })
            }
        }
    });

    server.route({
        method: 'GET',
        path: '/admin/config/smtp',
        async handler(request, h) {
            let values = {
                smtpServerEnabled: await settings.get('smtpServerEnabled'),
                smtpServerPassword: await settings.get('smtpServerPassword'),
                smtpServerAuthEnabled: await settings.get('smtpServerAuthEnabled'),
                smtpServerPort: await settings.get('smtpServerPort'),
                smtpServerHost: await settings.get('smtpServerHost'),
                smtpServerProxy: await settings.get('smtpServerProxy')
            };

            let availableAddresses = new Set(
                Object.values(os.networkInterfaces())
                    .flatMap(entry => entry)
                    .map(entry => entry.address)
            );
            availableAddresses.add('0.0.0.0');

            return h.view(
                'config/smtp',
                {
                    menuConfig: true,
                    menuConfigSmtp: true,

                    values,

                    serverState: await getSmtpServerStatus(),
                    availableAddresses: Array.from(availableAddresses).join(',')
                },
                {
                    layout: 'app'
                }
            );
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/config/smtp',
        async handler(request, h) {
            try {
                let existingSetup = {};
                let hasServerChanges = false;

                const systemKeys = ['smtpServerEnabled', 'smtpServerPort', 'smtpServerHost'];
                for (let key of systemKeys) {
                    existingSetup[key] = await settings.get(key);
                }

                for (let key of Object.keys(request.payload)) {
                    await settings.set(key, request.payload[key]);
                    if (systemKeys.includes(key) && request.payload[key] !== existingSetup[key]) {
                        hasServerChanges = true;
                    }
                }

                await request.flash({ type: 'info', message: `Configuration updated` });

                if (hasServerChanges) {
                    // request server restart
                    try {
                        await call({ cmd: 'smtpReload' });
                    } catch (err) {
                        logger.error({ msg: 'Reload request failed', action: 'request_reload_smtp', err });
                    }
                }

                return h.redirect('/admin/config/smtp');
            } catch (err) {
                await request.flash({ type: 'danger', message: `Failed to update configuration` });
                logger.error({ msg: 'Failed to update configuration', err });

                let availableAddresses = new Set(
                    Object.values(os.networkInterfaces())
                        .flatMap(entry => entry)
                        .map(entry => entry.address)
                );
                availableAddresses.add('0.0.0.0');

                return h.view(
                    'config/smtp',
                    {
                        menuConfig: true,
                        menuConfigSmtp: true,

                        serverState: await getSmtpServerStatus(),
                        availableAddresses: Array.from(availableAddresses).join(',')
                    },
                    {
                        layout: 'app'
                    }
                );
            }
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                async failAction(request, h, err) {
                    let errors = {};

                    if (err.details) {
                        err.details.forEach(detail => {
                            if (!errors[detail.path]) {
                                errors[detail.path] = detail.message;
                            }
                        });
                    }

                    await request.flash({ type: 'danger', message: `Failed to update configuration` });
                    logger.error({ msg: 'Failed to update configuration', err });

                    let availableAddresses = new Set(
                        Object.values(os.networkInterfaces())
                            .flatMap(entry => entry)
                            .map(entry => entry.address)
                    );
                    availableAddresses.add('0.0.0.0');

                    return h
                        .view(
                            'config/smtp',
                            {
                                menuConfig: true,
                                menuConfigSmtp: true,

                                serverState: await getSmtpServerStatus(),
                                availableAddresses: Array.from(availableAddresses).join(','),

                                errors
                            },
                            {
                                layout: 'app'
                            }
                        )
                        .takeover();
                },

                payload: Joi.object(configSmtpSchema)
            }
        }
    });

    server.route({
        method: 'POST',
        path: '/admin/config/browser',
        async handler(request) {
            for (let key of ['serviceUrl', 'language', 'timezone']) {
                if (request.payload[key]) {
                    let existingValue = await settings.get(key);
                    if (existingValue === null) {
                        await settings.set(key, request.payload[key]);
                    }
                }
            }

            return { success: true };
        },
        options: {
            validate: {
                options: {
                    stripUnknown: true,
                    abortEarly: false,
                    convert: true
                },

                failAction,

                payload: Joi.object({
                    serviceUrl: Joi.string()
                        .empty('')
                        .uri({
                            scheme: ['http', 'https'],
                            allowRelative: false
                        })
                        .allow(false),

                    language: Joi.string()
                        .empty('')
                        .lowercase()
                        .regex(/^[a-z0-9]{1,5}([-_][a-z0-9]{1,15})?$/)
                        .allow(false),

                    timezone: Joi.string().empty('').allow(false).max(255)
                })
            }
        }
    });
}

module.exports = (...args) => {
    applyRoutes(...args);
};
