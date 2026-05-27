// ============================================================
//  src/services/downloadService.js — Miyabi Telegram
//  Téléchargement YouTube, Facebook, Pinterest via yt-dlp
// ============================================================

const YTDlpWrap  = require('yt-dlp-wrap').default;
const path       = require('path');
const fs         = require('fs');
const logger     = require('../utils/logger');

const TMP_DIR    = path.join(__dirname, '../../tmp');
const MAX_SIZE_MB = 50; // Limite Telegram bots = 50 MB

// S'assurer que le dossier tmp existe
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Détecter la plateforme depuis l'URL
function detectPlatform(url) {
    if (/youtube\.com|youtu\.be/i.test(url))   return 'youtube';
    if (/facebook\.com|fb\.watch/i.test(url))  return 'facebook';
    if (/pinterest\.com|pin\.it/i.test(url))   return 'pinterest';
    if (/instagram\.com/i.test(url))            return 'instagram';
    if (/tiktok\.com/i.test(url))               return 'tiktok';
    if (/twitter\.com|x\.com/i.test(url))       return 'twitter';
    return 'unknown';
}

// Nettoyer un nom de fichier
function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9_\-\.]/g, '_').substring(0, 60);
}

class DownloadService {
    constructor() {
        this.ytdlp = new YTDlpWrap();
    }

    // ── Récupérer les infos sans télécharger ─────────────────
    async getInfo(url) {
        try {
            const info = await this.ytdlp.getVideoInfo(url);
            return {
                title:     info.title     || 'Vidéo',
                duration:  info.duration  || 0,
                uploader:  info.uploader  || '',
                thumbnail: info.thumbnail || '',
                filesize:  info.filesize_approx || 0,
                platform:  detectPlatform(url),
            };
        } catch (err) {
            logger.error('[DOWNLOAD] getInfo erreur:', err.message);
            return null;
        }
    }

    // ── Télécharger une vidéo ────────────────────────────────
    async downloadVideo(url) {
        const platform = detectPlatform(url);
        const outPath  = path.join(TMP_DIR, `miyabi_${Date.now()}.mp4`);

        logger.info(`[DOWNLOAD] 📥 Vidéo ${platform} : ${url}`);

        try {
            // Vérifier la taille avant téléchargement
            const info = await this.getInfo(url);
            if (info?.filesize && info.filesize / (1024*1024) > MAX_SIZE_MB) {
                return { success: false, error: 'FILE_TOO_LARGE', sizeMB: (info.filesize/1024/1024).toFixed(1) };
            }

            // Options selon la plateforme
            const args = this._buildArgs(url, outPath, platform, 'video');
            await this.ytdlp.execPromise(args);

            if (!fs.existsSync(outPath))
                return { success: false, error: 'FILE_NOT_FOUND' };

            const stat   = fs.statSync(outPath);
            const sizeMB = stat.size / (1024 * 1024);

            if (sizeMB > MAX_SIZE_MB) {
                fs.unlinkSync(outPath);
                return { success: false, error: 'FILE_TOO_LARGE', sizeMB: sizeMB.toFixed(1) };
            }

            return {
                success:  true,
                path:     outPath,
                title:    info?.title || 'Vidéo',
                platform,
                sizeMB:   sizeMB.toFixed(1),
            };

        } catch (err) {
            logger.error('[DOWNLOAD] downloadVideo erreur:', err.message);
            if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            return { success: false, error: 'DOWNLOAD_FAILED', detail: err.message };
        }
    }

    // ── Télécharger uniquement l'audio (YouTube) ─────────────
    async downloadAudio(url) {
        const platform = detectPlatform(url);
        const outPath  = path.join(TMP_DIR, `miyabi_${Date.now()}.mp3`);

        logger.info(`[DOWNLOAD] 🎵 Audio ${platform} : ${url}`);

        try {
            const args = this._buildArgs(url, outPath, platform, 'audio');
            await this.ytdlp.execPromise(args);

            if (!fs.existsSync(outPath))
                return { success: false, error: 'FILE_NOT_FOUND' };

            const stat   = fs.statSync(outPath);
            const sizeMB = stat.size / (1024 * 1024);

            const info = await this.getInfo(url).catch(() => null);

            return {
                success:  true,
                path:     outPath,
                title:    info?.title || 'Audio',
                platform,
                sizeMB:   sizeMB.toFixed(1),
            };

        } catch (err) {
            logger.error('[DOWNLOAD] downloadAudio erreur:', err.message);
            if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            return { success: false, error: 'DOWNLOAD_FAILED', detail: err.message };
        }
    }

    // ── Télécharger une image (Pinterest, etc.) ───────────────
    async downloadImage(url) {
        const platform = detectPlatform(url);
        const outPath  = path.join(TMP_DIR, `miyabi_${Date.now()}.jpg`);

        logger.info(`[DOWNLOAD] 🖼️  Image ${platform} : ${url}`);

        try {
            const args = [
                url,
                '--write-thumbnail',
                '--skip-download',
                '--convert-thumbnails', 'jpg',
                '-o', outPath.replace('.jpg', ''),
            ];
            await this.ytdlp.execPromise(args);

            // yt-dlp ajoute l'extension automatiquement
            const finalPath = outPath.replace('.jpg', '.jpg');
            if (!fs.existsSync(finalPath))
                return { success: false, error: 'FILE_NOT_FOUND' };

            return { success: true, path: finalPath, platform };

        } catch (err) {
            logger.error('[DOWNLOAD] downloadImage erreur:', err.message);
            return { success: false, error: 'DOWNLOAD_FAILED', detail: err.message };
        }
    }

    // ── Construire les arguments yt-dlp ──────────────────────
    _buildArgs(url, outPath, platform, type) {
        if (type === 'audio') {
            return [
                url,
                '-x', '--audio-format', 'mp3',
                '--audio-quality', '192K',
                '-o', outPath,
                '--no-playlist',
            ];
        }

        // Vidéo — qualité max 720p pour rester sous 50 MB
        const baseArgs = [
            url,
            '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]',
            '--merge-output-format', 'mp4',
            '-o', outPath,
            '--no-playlist',
        ];

        // Pinterest : récupérer directement la vidéo du pin
        if (platform === 'pinterest') {
            return [
                url,
                '-f', 'best',
                '-o', outPath,
            ];
        }

        // Facebook : forcer le format mp4
        if (platform === 'facebook') {
            return [
                url,
                '-f', 'best[ext=mp4]/best',
                '-o', outPath,
                '--no-playlist',
            ];
        }

        return baseArgs;
    }

    // ── Nettoyer les fichiers tmp anciens (> 10 min) ──────────
    cleanTmp() {
        const now = Date.now();
        try {
            fs.readdirSync(TMP_DIR).forEach(file => {
                const fp   = path.join(TMP_DIR, file);
                const stat = fs.statSync(fp);
                if (now - stat.mtimeMs > 10 * 60 * 1000) {
                    fs.unlinkSync(fp);
                    logger.info(`[DOWNLOAD] 🗑️  Tmp nettoyé : ${file}`);
                }
            });
        } catch (e) {
            logger.warn('[DOWNLOAD] cleanTmp erreur:', e.message);
        }
    }
}

module.exports = new DownloadService();
