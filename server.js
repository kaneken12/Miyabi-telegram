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
    console.log('=== MIYABI TELEGRAM STARTING ===');
    console.log('Node version:', process.version);

    // Vérifier yt-dlp
    try {
        const v = require('child_process').execSync('yt-dlp --version').toString().trim();
        console.log('yt-dlp:', v);
    } catch (_) { console.log('yt-dlp: non disponible (mode Render)'); }

    // Vérifier ffmpeg
    try {
        const v = require('child_process').execSync('ffmpeg -version').toString().split('\n')[0];
        console.log('ffmpeg:', v);
    } catch (_) { console.log('ffmpeg: non disponible'); }

    const hasGemini = process.env.GEMINI_API_KEY_1 || process.env.GEMINI_API_KEY;
    if (!process.env.TELEGRAM_BOT_TOKEN) { console.error('FATAL: TELEGRAM_BOT_TOKEN manquant'); process.exit(1); }
    if (!hasGemini)                       { console.error('FATAL: Clé Gemini manquante');         process.exit(1); }
    if (!process.env.OWNER_ID)            { console.error('FATAL: OWNER_ID manquant');            process.exit(1); }

    await setupBot();
    console.log('=== BOT STARTED ===');

    app.listen(PORT, () => console.log('Server on port', PORT));
}

process.on('uncaughtException',  (err) => console.error('uncaughtException:', err.message));
process.on('unhandledRejection', (r)   => console.error('unhandledRejection:', r));

main();
