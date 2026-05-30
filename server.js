// ============================================================
//  server.js — Miyabi Telegram v2
// ============================================================

require('dotenv').config();
const express      = require('express');
const logger       = require('./src/utils/logger');
const { setupBot } = require('./src/core/bot');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/',       (_, res) => res.json({ status: 'online', bot: 'Miyabi Telegram', version: '2.0.0' }));
app.get('/health', (_, res) => res.json({ status: 'ok' }));

async function main() {
    logger.info('🚀 Démarrage Miyabi Telegram v2...');

    const required = ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY', 'OWNER_ID'];
    const missing  = required.filter(k => !process.env[k]);
    if (missing.length > 0) {
        logger.error(`❌ Variables manquantes : ${missing.join(', ')}`);
        process.exit(1);
    }

    await setupBot();

    app.listen(PORT, () => logger.info(`🌐 Serveur sur le port ${PORT}`));
}

process.on('uncaughtException',  (err) => logger.error('💥 uncaughtException:', err.message));
process.on('unhandledRejection', (r)   => logger.error('💥 unhandledRejection:', r));

main();
