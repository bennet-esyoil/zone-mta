'use strict';

// NB! This script is ran as a separate process

const config = require('config');
const log = require('npmlog');
const crypto = require('crypto');

log.level = config.log.level;
require('./lib/logger');

// initialize plugin system
const plugins = require('./lib/plugins');
plugins.init('receiver');

const SMTPInterface = require('./lib/smtp-interface');

const QueueClient = require('./lib/transport/client');
const queueClient = new QueueClient(config.queueServer);
const RemoteQueue = require('./lib/remote-queue');

let currentInterface = (process.argv[2] || '').toString().trim().toLowerCase();
let clientId = (process.argv[3] || '').toString().trim().toLowerCase() || crypto.randomBytes(10).toString('hex');
let smtpServer = false;

let cmdId = 0;
let responseHandlers = new Map();
let closing = false;

process.title = config.ident + ': receiver/' + currentInterface;

let sendCommand = (cmd, callback) => {
    let id = ++cmdId;
    let data = {
        req: id
    };

    if (typeof cmd === 'string') {
        cmd = {
            cmd
        };
    }

    Object.keys(cmd).forEach(key => (data[key] = cmd[key]));
    responseHandlers.set(id, callback);
    queueClient.send(data);
};

let startSMTPInterface = (key, done) => {
    let smtp = new SMTPInterface(key, config.smtpInterfaces[key], sendCommand);
    smtp.setup(err => {
        if (err) {
            log.error(smtp.logName, 'Could not start ' + key + ' MTA server');
            log.error(smtp.logName, err);
            return done(err);
        }
        log.info(smtp.logName, 'SMTP ' + key + ' MTA server started');
        return done(null, smtp);
    });
};

queueClient.connect(err => {
    if (err) {
        log.error('SMTP/' + currentInterface + '/' + process.pid, 'Could not connect to Queue server');
        log.error('SMTP/' + currentInterface + '/' + process.pid, err.message);
        process.exit(1);
    }

    queueClient.on('close', () => {
        if (!closing) {
            log.error('SMTP/' + currentInterface + '/' + process.pid, 'Connection to Queue server closed unexpectedly');
            process.exit(1);
        }
    });

    queueClient.on('error', err => {
        if (!closing) {
            log.error('SMTP/' + currentInterface + '/' + process.pid, 'Connection to Queue server ended with error %s', err.message);
            process.exit(1);
        }
    });

    queueClient.onData = (data, next) => {
        let callback;
        if (responseHandlers.has(data.req)) {
            callback = responseHandlers.get(data.req);
            responseHandlers.delete(data.req);
            setImmediate(() => callback(data.error ? data.error : null, !data.error && data.response));
        }
        next();
    };

    // Notify the server about the details of this client
    queueClient.send({
        cmd: 'HELLO',
        smtp: currentInterface,
        id: clientId
    });

    let queue = new RemoteQueue();
    queue.init(sendCommand, err => {
        if (err) {
            log.error('SMTP/' + currentInterface + '/' + process.pid, 'Queue error %s', err.message);
            return process.exit(1);
        }

        plugins.handler.queue = queue;

        plugins.handler.load(() => {
            log.info('SMTP/' + currentInterface + '/' + process.pid, '%s plugins loaded', plugins.handler.loaded.length);
        });

        startSMTPInterface(currentInterface, (err, smtp) => {
            if (err) {
                log.error('SMTP/' + currentInterface + '/' + process.pid, 'SMTP error %s', err.message);
                return process.exit(1);
            }
            smtpServer = smtp;
        });
    });
});

// start accepting sockets
process.on('message', (m, socket) => {
    if (m === 'socket') {
        if (!smtpServer || !smtpServer.server) {
            let tryCount = 0;
            let nextTry = () => {
                if (smtpServer && smtpServer.server) {
                    return smtpServer.server.connect(socket);
                }
                if (tryCount++ > 5) {
                    try {
                        return socket.end('421 Process not yet initialized\r\n');
                    } catch (E) {
                        // ignore
                    }
                } else {
                    return setTimeout(nextTry, 100 * tryCount).unref();
                }
            };
            return setTimeout(nextTry, 100).unref();
        }
        smtpServer.server.connect(socket);
    }
});
