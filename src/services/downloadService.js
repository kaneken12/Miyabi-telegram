// ============================================================
//  src/services/downloadService.js
//  Téléchargement depuis lien OU depuis recherche textuelle
// ============================================================

const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpeg    = require('fluent-ffmpeg');
const path      = require('path');
const fs        = require('fs');
const logger    = require('../utils/logger');

const TMP_DIR     = path.join(__dirname, '../../tmp');
const MAX_SIZE_MB = 50;

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

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
        this.ytdlp = new YTDlpWrap();
    }

    // ── Infos sans télécharger ───────────────────────────────
    async getInfo(urlOrQuery) {
        try {
            const source = this._buildSource(urlOrQuery);
            const info   = await this.ytdlp.getVideoInfo(source);
            return {
                title:    info.title    || 'Média',
                duration: info.duration || 0,
                uploader: info.uploader || '',
                filesize: info.filesize_approx || 0,
                platform: detectPlatform(info.webpage_url || urlOrQuery),
                url:      info.webpage_url || urlOrQuery,
            };
        } catch {
            return null;
        }
    }

    // ── Télécharger une vidéo (lien OU recherche textuelle) ──
    async downloadVideo(urlOrQuery) {
        const source   = this._buildSource(urlOrQuery);
        const outPath  = path.join(TMP_DIR, `miyabi_${Date.now()}.mp4`);
        const isSearch = !urlOrQuery.startsWith('http');

        logger.info(`[DL] 📥 Vidéo ${isSearch ? '🔍 ' + urlOrQuery : urlOrQuery}`);

        try {
            const args = [
                source,
                '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]',
                '--merge-output-format', 'mp4',
                '-o', outPath,
                '--no-playlist',
            ];
            await this.ytdlp.execPromise(args);

            if (!fs.existsSync(outPath)) return { success: false, error: 'FILE_NOT_FOUND' };

            const sizeMB = fs.statSync(outPath).size / (1024 * 1024);
            if (sizeMB > MAX_SIZE_MB) {
                fs.unlinkSync(outPath);
                return { success: false, error: 'FILE_TOO_LARGE', sizeMB: sizeMB.toFixed(1) };
            }

            const info = await this.getInfo(source).catch(() => null);
            return {
                success:  true,
                path:     outPath,
                title:    info?.title    || urlOrQuery,
                platform: info?.platform || 'YouTube',
                sizeMB:   sizeMB.toFixed(1),
            };

        } catch (err) {
            logger.error('[DL] downloadVideo erreur:', err.message);
            if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            return { success: false, error: 'DOWNLOAD_FAILED' };
        }
    }

    // ── Télécharger uniquement l'audio (lien OU recherche) ───
    async downloadAudio(urlOrQuery) {
        const source   = this._buildSource(urlOrQuery);
        const outPath  = path.join(TMP_DIR, `miyabi_${Date.now()}.mp3`);
        const isSearch = !urlOrQuery.startsWith('http');

        logger.info(`[DL] 🎵 Audio ${isSearch ? '🔍 ' + urlOrQuery : urlOrQuery}`);

        try {
            const args = [
                source,
                '-x', '--audio-format', 'mp3',
                '--audio-quality', '192K',
                '-o', outPath,
                '--no-playlist',
            ];
            await this.ytdlp.execPromise(args);

            if (!fs.existsSync(outPath)) return { success: false, error: 'FILE_NOT_FOUND' };

            const info   = await this.getInfo(source).catch(() => null);
            const sizeMB = fs.statSync(outPath).size / (1024 * 1024);
            return {
                success:  true,
                path:     outPath,
                title:    info?.title    || urlOrQuery,
                platform: info?.platform || 'YouTube',
                sizeMB:   sizeMB.toFixed(1),
            };

        } catch (err) {
            logger.error('[DL] downloadAudio erreur:', err.message);
            if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            return { success: false, error: 'DOWNLOAD_FAILED' };
        }
    }

    // ── Convertir vidéo reçue → MP3 ─────────────────────────
    async convertToAudio(inputPath) {
        const outPath = path.join(TMP_DIR, `miyabi_conv_${Date.now()}.mp3`);
        logger.info(`[DL] 🔄 Conversion : ${inputPath}`);

        return new Promise((resolve) => {
            ffmpeg(inputPath)
                .noVideo()
                .audioCodec('libmp3lame')
                .audioBitrate('192k')
                .output(outPath)
                .on('end', () => {
                    logger.info('[DL] ✅ Conversion terminée');
                    resolve({ success: true, path: outPath });
                })
                .on('error', (err) => {
                    logger.error('[DL] Conversion erreur:', err.message);
                    resolve({ success: false, error: 'CONVERT_FAILED' });
                })
                .run();
        });
    }

    // ── Construire la source yt-dlp ──────────────────────────
    // Si c'est une URL → on l'utilise directement
    // Si c'est une recherche → ytsearch1:"requête"
    _buildSource(urlOrQuery) {
        if (urlOrQuery.startsWith('http')) return urlOrQuery;
        return `ytsearch1:${urlOrQuery}`;
    }

    // ── Nettoyage tmp > 15 min ───────────────────────────────
    cleanTmp() {
        const now = Date.now();
        try {
            fs.readdirSync(TMP_DIR).forEach(file => {
                const fp = path.join(TMP_DIR, file);
                if (now - fs.statSync(fp).mtimeMs > 15 * 60 * 1000) {
                    fs.unlinkSync(fp);
                    logger.info(`[DL] 🗑️  Tmp nettoyé : ${file}`);
                }
            });
        } catch (e) {
            logger.warn('[DL] cleanTmp erreur:', e.message);
        }
    }

    cleanup(filePath) {
        try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); }
        catch (_) {}
    }
}

module.exports = new DownloadService();
