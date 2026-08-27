// ============================================================
//  src/services/downloadService.js
//  Termux : yt-dlp | Render : worker Termux via ngrok
// ============================================================

const axios  = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const path   = require('path');
const fs     = require('fs');
const logger = require('../utils/logger');

const TMP_DIR     = path.join(__dirname, '../../tmp');
const MAX_SIZE_MB = 50;

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

try {
    require('child_process').execSync('ffmpeg -version', { stdio: 'ignore' });
    logger.info('[DL] ffmpeg système');
} catch (_) {
    try { const i = require('@ffmpeg-installer/ffmpeg'); ffmpeg.setFfmpegPath(i.path); logger.info('[DL] ffmpeg installer'); }
    catch (_) {}
}

function detectPlatform(url) {
    if (/youtube\.com|youtu\.be/i.test(url))  return 'YouTube';
    if (/facebook\.com|fb\.watch/i.test(url)) return 'Facebook';
    if (/pinterest\.com|pin\.it/i.test(url))  return 'Pinterest';
    if (/instagram\.com/i.test(url))           return 'Instagram';
    if (/tiktok\.com/i.test(url))              return 'TikTok';
    if (/twitter\.com|x\.com/i.test(url))      return 'Twitter';
    return 'YouTube';
}

class DownloadService {
    constructor() {
        this.isRender     = !!process.env.RENDER;
        this.workerUrl    = process.env.WORKER_URL || null;
        this.workerSecret = process.env.WORKER_SECRET || 'miyabi-secret-key';

        if (this.isRender) {
            logger.info('[DL] Mode Render — Worker: ' + (this.workerUrl || 'NON CONFIGURÉ'));
        } else {
            try {
                const YTDlpWrap = require('yt-dlp-wrap').default;
                this.ytdlp = new YTDlpWrap();
                logger.info('[DL] Mode Termux — yt-dlp actif');
            } catch (_) { this.ytdlp = null; }
        }
    }

    async _callWorker(type, query) {
        if (!this.workerUrl) return { success: false, error: 'WORKER_URL manquant' };
        const ext     = type === 'audio' ? 'mp3' : 'mp4';
        const outPath = path.join(TMP_DIR, 'miyabi_' + Date.now() + '.' + ext);
        try {
            const response = await axios({
                method: 'POST', url: this.workerUrl + '/download/' + type,
                data: { query }, headers: { 'x-worker-secret': this.workerSecret },
                responseType: 'stream', timeout: 180000,
            });
            const writer = fs.createWriteStream(outPath);
            response.data.pipe(writer);
            await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });
            if (!fs.existsSync(outPath)) return { success: false, error: 'FILE_NOT_FOUND' };
            const sizeMB = fs.statSync(outPath).size / (1024 * 1024);
            if (sizeMB > MAX_SIZE_MB) { fs.unlinkSync(outPath); return { success: false, error: 'FILE_TOO_LARGE', sizeMB: sizeMB.toFixed(1) }; }
            return { success: true, path: outPath, title: query, platform: detectPlatform(query.startsWith('http') ? query : 'youtube'), sizeMB: sizeMB.toFixed(1) };
        } catch (err) {
            logger.error('[DL] Worker erreur:', err.message);
            if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            return { success: false, error: 'DOWNLOAD_FAILED' };
        }
    }

    async _ytdlp(urlOrQuery, type) {
        const source   = urlOrQuery.startsWith('http') ? urlOrQuery : 'ytsearch1:' + urlOrQuery;
        const ext      = type === 'audio' ? 'mp3' : 'mp4';
        const outPath  = path.join(TMP_DIR, 'miyabi_' + Date.now() + '.' + ext);
        const platform = detectPlatform(urlOrQuery.startsWith('http') ? urlOrQuery : 'youtube');
        try {
            const args = type === 'audio'
                ? [source, '-x', '--audio-format', 'mp3', '--audio-quality', '192K', '-o', outPath, '--no-playlist']
                : [source, '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best', '--merge-output-format', 'mp4', '-o', outPath, '--no-playlist'];
            await this.ytdlp.execPromise(args);
            let finalPath = outPath;
            if (!fs.existsSync(outPath)) {
                for (const e of ['.mp4', '.mp3', '.mkv', '.webm']) {
                    const p = outPath.replace(/\.[^.]+$/, e);
                    if (fs.existsSync(p)) { finalPath = p; break; }
                }
            }
            if (!fs.existsSync(finalPath)) return { success: false, error: 'FILE_NOT_FOUND' };
            const sizeMB = fs.statSync(finalPath).size / (1024 * 1024);
            if (sizeMB > MAX_SIZE_MB) { fs.unlinkSync(finalPath); return { success: false, error: 'FILE_TOO_LARGE', sizeMB: sizeMB.toFixed(1) }; }
            return { success: true, path: finalPath, title: urlOrQuery, platform, sizeMB: sizeMB.toFixed(1) };
        } catch (err) {
            logger.error('[DL] yt-dlp erreur:', err.message);
            if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            return { success: false, error: 'DOWNLOAD_FAILED' };
        }
    }

    async downloadAudio(urlOrQuery) {
        if (this.isRender) return this._callWorker('audio', urlOrQuery);
        return this._ytdlp(urlOrQuery, 'audio');
    }

    async downloadVideo(urlOrQuery) {
        if (this.isRender) return this._callWorker('video', urlOrQuery);
        return this._ytdlp(urlOrQuery, 'video');
    }

    async convertToAudio(inputPath) {
        const outPath = path.join(TMP_DIR, 'miyabi_conv_' + Date.now() + '.mp3');
        return new Promise((resolve) => {
            ffmpeg(inputPath).noVideo().audioCodec('libmp3lame').audioBitrate('192k').output(outPath)
                .on('end', () => resolve({ success: true, path: outPath }))
                .on('error', (err) => { logger.error('[DL] Conv:', err.message); resolve({ success: false }); })
                .run();
        });
    }

    cleanTmp() {
        const now = Date.now();
        try {
            fs.readdirSync(TMP_DIR).forEach(f => {
                const fp = path.join(TMP_DIR, f);
                if (now - fs.statSync(fp).mtimeMs > 15 * 60 * 1000) fs.unlinkSync(fp);
            });
        } catch (_) {}
    }

    cleanup(fp) { try { if (fp && fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {} }
}

module.exports = new DownloadService();
