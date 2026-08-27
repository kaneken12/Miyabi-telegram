// ============================================================
//  worker.js — Miyabi Download Worker (Termux)
//  Lance avec : node worker.js
// ============================================================

require('dotenv').config();
const express   = require('express');
const YTDlpWrap = require('yt-dlp-wrap').default;
const path      = require('path');
const fs        = require('fs');

const app     = express();
const PORT    = process.env.WORKER_PORT || 4000;
const TMP_DIR = path.join(__dirname, 'tmp');
const SECRET  = process.env.WORKER_SECRET || 'miyabi-secret-key';

app.use(express.json());
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const ytdlp = new YTDlpWrap();

function auth(req, res, next) {
    if (req.headers['x-worker-secret'] !== SECRET)
        return res.status(401).json({ error: 'Unauthorized' });
    next();
}

app.get('/health', (_, res) => res.json({ status: 'ok', worker: 'Miyabi Termux Worker' }));

app.post('/download/audio', auth, async (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'query manquant' });
    console.log('[WORKER] Audio:', query);

    const source  = query.startsWith('http') ? query : 'ytsearch1:' + query;
    const outPath = path.join(TMP_DIR, 'audio_' + Date.now() + '.mp3');

    try {
        await ytdlp.execPromise([source, '-x', '--audio-format', 'mp3', '--audio-quality', '192K', '-o', outPath, '--no-playlist']);
        if (!fs.existsSync(outPath)) return res.status(500).json({ error: 'Fichier introuvable' });
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
        const stream = fs.createReadStream(outPath);
        stream.pipe(res);
        stream.on('end', () => { try { fs.unlinkSync(outPath); } catch (_) {} });
        stream.on('error', (err) => { console.error('[WORKER] Stream:', err.message); });
    } catch (err) {
        console.error('[WORKER] Audio erreur:', err.message);
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
        res.status(500).json({ error: err.message });
    }
});

app.post('/download/video', auth, async (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'query manquant' });
    console.log('[WORKER] Video:', query);

    const source  = query.startsWith('http') ? query : 'ytsearch1:' + query;
    const outPath = path.join(TMP_DIR, 'video_' + Date.now() + '.mp4');

    try {
        await ytdlp.execPromise([
            source,
            '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best',
            '--merge-output-format', 'mp4',
            '-o', outPath, '--no-playlist',
        ]);

        let finalPath = outPath;
        if (!fs.existsSync(outPath)) {
            for (const ext of ['.mp4', '.mkv', '.webm']) {
                const p = outPath.replace('.mp4', ext);
                if (fs.existsSync(p)) { finalPath = p; break; }
            }
        }

        if (!fs.existsSync(finalPath)) return res.status(500).json({ error: 'Fichier introuvable' });
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');
        const stream = fs.createReadStream(finalPath);
        stream.pipe(res);
        stream.on('end', () => { try { fs.unlinkSync(finalPath); } catch (_) {} });
        stream.on('error', (err) => { console.error('[WORKER] Stream:', err.message); });
    } catch (err) {
        console.error('[WORKER] Video erreur:', err.message);
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log('[WORKER] Miyabi Download Worker actif sur le port', PORT);
    console.log('[WORKER] En attente de requêtes de Render...');
});

process.on('uncaughtException',  (err) => console.error('[WORKER] uncaughtException:', err.message));
process.on('unhandledRejection', (r)   => console.error('[WORKER] unhandledRejection:', r));
