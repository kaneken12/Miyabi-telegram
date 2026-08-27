// ============================================================
//  src/utils/logger.js — Compatible Render + Termux
// ============================================================

const isRender = !!process.env.RENDER;

let logger;
if (isRender) {
    logger = {
        info:  (...a) => console.log('[INFO]',  ...a),
        warn:  (...a) => console.warn('[WARN]',  ...a),
        error: (...a) => console.error('[ERROR]', ...a),
        debug: (...a) => console.log('[DEBUG]', ...a),
    };
} else {
    const pino = require('pino');
    logger = pino({
        level: 'info',
        transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:dd-mm-yyyy HH:MM:ss', ignore: 'pid,hostname' },
        },
    });
}

module.exports = logger;
