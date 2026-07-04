// ============================================================
//  src/services/downloadService.js
//  Cobalt API + fallback API externe
//  Pas de dépendance yt-dlp sur Render
// ============================================================

const axios   = require('axios');
const ffmpeg  = require('fluent-ffmpeg');
const path    = require('path');
const fs      = require('fs');
const logger  = require('../utils/logger');

const TMP_DIR     = path.join(__dirname, '../../tmp');
const MAX_SIZE_MB = 50;

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ── Configurer ffmpeg ────────────────────────────────────────
try {
    const { execSync } = require('child_process');
    execSync('ffmpeg -version', { stdio: 'ignore' });
    logger.info('[DL] ffmpeg système');
} catch (_) {
    try {
        const installer = require('@ffmpeg-installer/ffmpeg');
        ffmpeg.setFfmpegPath(installer.path);
        logger.info('[DL] ffmpeg installer');
    } catch (_) {}
}

// ── APIs de téléchargement ───────────────────────────────────
const COBALT_API     = 'https://api.cobalt.tools';
const FALLBACK_API   = 'https://social-media-downloader-smoky.vercel.app';

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
        // yt-dlp pour Termux uniquement
        this.isLocal = !process.env.RENDER;
        if (this.isLocal) {
            try {
                const YTDlpWrap = require('yt-dlp-wrap').default;
                this.ytdlp = new YTDlpWrap();
                logger.info('[DL] Mode Termux — yt-dlp actif');
            } catch (_) {
                this.ytdlp = null;
            }
        } else {
            logger.info('[DL] Mode Render — APIs externes actives');
        }
    }

    // ── Télécharger via Cobalt API ───────────────────────────
    async _downloadViaCobalt(url, type) {
        try {
            logger.info('[DL] Cobalt API : ' + url);
            const res = await axios.post(`${COBALT_API}/`, {
                url,
                downloadMode: type === 'audio' ? 'audio' : 'auto',
                audioFormat:  'mp3',
                quality:      '720',
            }, {
                headers: {
                    'Accept':       'application/json',
                    'Content-Type': 'application/json',
                },
                timeout: 15000,
            });

            const data = res.data;

            if (data.status === 'stream' || data.status === 'redirect') {
                return { success: true, downloadUrl: data.url };
            }
            if (data.status === 'picker') {
                return { success: true, downloadUrl: data.picker[0]?.url };
            }
            return { success: false, error: 'COBALT_NO_URL' };

        } catch (err) {
            logger.warn('[DL] Cobalt échoué:', err.message);
            return { success: false, error: err.message };
        }
    }

    // ── Télécharger via API fallback ─────────────────────────
    async _downloadViaFallback(url, type) {
        try {
            logger.info('[DL] Fallback API : ' + url);
            const endpoint = type === 'audio'
                ? `${FALLBACK_API}/ytdl/mp3?url=${encodeURIComponent(url)}`
                : `${FALLBACK_API}/ytdl/mp4?url=${encodeURIComponent(url)}`;

            const res = await axios.get(endpoint, { timeout: 15000 });
            const data = res.data;

            // Selon le format de réponse de l'API
            const downloadUrl = data.url || data.download_url || data.link || null;
            if (downloadUrl) return { success: true, downloadUrl };

            return { success: false, error: 'FALLBACK_NO_URL' };

        } catch (err) {
            logger.warn('[DL] Fallback échoué:', err.message);
            return { success: false, error: err.message };
        }
    }

    // ── Télécharger un fichier depuis une URL ────────────────
    async _downloadFile(downloadUrl, outPath) {
        const response = await axios({
            url:          downloadUrl,
            method:       'GET',
            responseType: 'stream',
            timeout:      120000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        });

        const writer = fs.createWriteStream(outPath);
        response.data.pipe(writer);
        await new Promise((res, rej) => {
            writer.on('finish', res);
            writer.on('error', rej);
        });
        return true;
    }

    // ── Téléchargement principal ─────────────────────────────
    async _download(urlOrQuery, type) {
        const isUrl    = urlOrQuery.startsWith('http');
        const platform = isUrl ? detectPlatform(urlOrQuery) : 'YouTube';
        const ext      = type === 'audio' ? 'mp3' : 'mp4';
        const outPath  = path.join(TMP_DIR, `miyabi_${Date.now()}.${ext}`);

        // ── Mode Termux : yt-dlp direct ──────────────────────
        if (this.isLocal && this.ytdlp) {
            return this._downloadViaYtdlp(urlOrQuery, type, outPath, platform);
        }

        // ── Mode Render : APIs externes ──────────────────────
        if (!isUrl) {
            // Pour les recherches textuelles, on construit une URL YouTube
            urlOrQuery = `https://www.youtube.com/results?search_query=${encodeURIComponent(urlOrQuery)}`;
            // On utilise la recherche ytsearch via l'API fallback directement
        }

        // Essayer Cobalt d'abord
        let result = await this._downloadViaCobalt(urlOrQuery, type);

        // Fallback si Cobalt échoue
        if (!result.success) {
            result = await this._downloadViaFallback(urlOrQuery, type);
        }

        if (!result.success || !result.downloadUrl) {
            logger.error('[DL] Toutes les APIs ont échoué');
            return { success: false, error: 'DOWNLOAD_FAILED' };
        }

        // Télécharger le fichier
        try {
            await this._downloadFile(result.downloadUrl, outPath);

            if (!fs.existsSync(outPath)) return { success: false, error: 'FILE_NOT_FOUND' };

            const sizeMB = fs.statSync(outPath).size / (1024 * 1024);
            if (sizeMB > MAX_SIZE_MB) {
                fs.unlinkSync(outPath);
                return { success: false, error: 'FILE_TOO_LARGE', sizeMB: sizeMB.toFixed(1) };
            }

            return {
                success:  true,
                path:     outPath,
                title:    platform + ' media',
                platform,
                sizeMB:   sizeMB.toFixed(1),
            };

        } catch (err) {
            logger.error('[DL] Téléchargement fichier échoué:', err.message);
            if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            return { success: false, error: 'DOWNLOAD_FAILED' };
        }
    }

    // ── yt-dlp pour Termux ───────────────────────────────────
    async _downloadViaYtdlp(urlOrQuery, type, outPath, platform) {
        const source = urlOrQuery.startsWith('http')
            ? urlOrQuery
            : 'ytsearch1:' + urlOrQuery;

        logger.info(`[DL] yt-dlp ${type} : ${urlOrQuery}`);

        try {
            const args = type === 'audio'
                ? [source, '-x', '--audio-format', 'mp3', '--audio-quality', '192K', '-o', outPath, '--no-playlist']
                : [source, '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best', '--merge-output-format', 'mp4', '-o', outPath, '--no-playlist'];

            await this.ytdlp.execPromise(args);

            let finalPath = outPath;
            if (!fs.existsSync(outPath)) {
                for (const ext of ['.mp4', '.mp3', '.mkv', '.webm']) {
                    const p = outPath.replace(/\.[^.]+$/, ext);
                    if (fs.existsSync(p)) { finalPath = p; break; }
                }
            }

            if (!fs.existsSync(finalPath)) return { success: false, error: 'FILE_NOT_FOUND' };

            const sizeMB = fs.statSync(finalPath).size / (1024 * 1024);
            if (sizeMB > MAX_SIZE_MB) {
                fs.unlinkSync(finalPath);
                return { success: false, error: 'FILE_TOO_LARGE', sizeMB: sizeMB.toFixed(1) };
            }

            return { success: true, path: finalPath, title: urlOrQuery, platform, sizeMB: sizeMB.toFixed(1) };

        } catch (err) {
            logger.error('[DL] yt-dlp erreur:', err.message);
            if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            return { success: false, error: 'DOWNLOAD_FAILED' };
        }
    }

    // ── API publique ─────────────────────────────────────────
    async downloadVideo(urlOrQuery) { return this._download(urlOrQuery, 'video'); }
    async downloadAudio(urlOrQuery) { return this._download(urlOrQuery, 'audio'); }

    // ── Conversion vidéo → MP3 ───────────────────────────────
    async convertToAudio(inputPath) {
        const outPath = path.join(TMP_DIR, `miyabi_conv_${Date.now()}.mp3`);
        return new Promise((resolve) => {
            ffmpeg(inputPath)
                .noVideo().audioCodec('libmp3lame').audioBitrate('192k')
                .output(outPath)
                .on('end', () => resolve({ success: true, path: outPath }))
                .on('error', (err) => { logger.error('[DL] Conv erreur:', err.message); resolve({ success: false }); })
                .run();
        });
    }

    cleanTmp() {
        const now = Date.now();
        try {
            fs.readdirSync(TMP_DIR).forEach(file => {
                const fp = path.join(TMP_DIR, file);
                if (now - fs.statSync(fp).mtimeMs > 15 * 60 * 1000) fs.unlinkSync(fp);
            });
        } catch (_) {}
    }

    cleanup(filePath) {
        try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
    }
}

module.exports = new DownloadService();
ENDOFFILE
echo "OK"