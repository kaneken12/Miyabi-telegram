// ============================================================
//  src/utils/logger.js
//  Compatible Render (JSON) et Termux (pretty)
// ============================================================

const pino = require('pino');

// Sur Render : pas de TTY → logs JSON bruts
// Sur Termux : TTY → logs colorisés
const isRender  = !!process.env.RENDER;
const isPretty  = process.stdout.isTTY || !isRender;

const logger = pino(
    { level: 'info' },
    isPretty
        ? pino.transport({
              target: 'pino-pretty',
              options: {
                  colorize:      true,
                  translateTime: 'SYS:dd-mm-yyyy HH:MM:ss',
                  ignore:        'pid,hostname',
              },
          })
        : process.stdout
);

module.exports = logger;
