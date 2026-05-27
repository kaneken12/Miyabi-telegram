// ============================================================
//  server.js — Miyabi Telegram — Point d'entrée
// ============================================================

require('dotenv').config();
const express    = require('express');
const logger     = require('./src/utils/logger');
const { setupBot } = require('./src/core/bot');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── Route de statut ──────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        status:    'online',
        bot:       'Miyabi Telegram',
        version:   '1.0.0',
        timestamp: new Date().toISOString(),
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// ── Démarrage ────────────────────────────────────────────────
async function main() {
    logger.info('🚀 Démarrage de Miyabi Telegram...');

    // Vérification des variables d'environnement
    const required = ['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY', 'OWNER_ID'];
    const missing  = required.filter(k => !process.env[k]);

    if (missing.length > 0) {
        logger.error(`❌ Variables manquantes dans .env : ${missing.join(', ')}`);
        process.exit(1);
    }

    // Démarrer le bot Telegram
    await setupBot();

    // Démarrer le serveur Express (pour Render keep-alive)
    app.listen(PORT, () => {
        logger.info(`🌐 Serveur actif sur le port ${PORT}`);
    });
}

// ── Gestion des erreurs non catchées ────────────────────────
process.on('uncaughtException', (err) => {
    logger.error('💥 uncaughtException:', err.message);
});

process.on('unhandledRejection', (reason) => {
    logger.error('💥 unhandledRejection:', reason);
});

main();
