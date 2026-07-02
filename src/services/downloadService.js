// ============================================================
//  src/services/downloadService.js
//  Docker : yt-dlp et ffmpeg disponibles en système
// ============================================================

const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpeg    = require('fluent-ffmpeg');
const path      = require('path');
const fs        = require('fs');
const logger    = require('../utils/logger');

const TMP_DIR     = path.join(__dirname, '../../tmp');
const MAX_SIZE_MB = 50;

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ── Configurer ffmpeg ────────────────────────────────────────
// Priorité : système (Docker/Termux) > @ffmpeg-installer
try {
    const { execSync } = require('child_process');
    execSync('ffmpeg -version', { stdio: 'ignore' });
    logger.info('[DL] ffmpeg système détecté');
} catch (_) {
    try {
        const installer = require('@ffmpeg-installer/ffmpeg');
        ffmpeg.setFfmpegPath(installer.path);
        logger.info('[DL] ffmpeg via @ffmpeg-installer');
    } catch (e) {
        logger.warn('[DL] ffmpeg indisponible');
    }
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

const USER_AGENTS = {
    facebook:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    pinterest: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    default:   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

class DownloadService {
    constructor() {
        // Utiliser yt-dlp système directement
        this.ytdlp = new YTDlpWrap();
        this._checkYtdlp();
    }

    async _checkYtdlp() {
        try {
            await this.ytdlp.execPromise(['--version']);
            logger.info('[DL] yt-dlp prêt');
        } catch (err) {
            logger.error('[DL] yt-dlp erreur:', err.message);
        }
    }

    _buildSource(urlOrQuery) {
        if (!urlOrQuery.startsWith('http')) return 'ytsearch1:' + urlOrQuery;
        return urlOrQuery;
    }

    _buildVideoArgs(source, outPath) {
        const platform   = detectPlatform(source).toLowerCase();
        const isFacebook = platform === 'facebook';
        const isPinterest = platform === 'pinterest';

        const base = [source, '-o', outPath, '--no-playlist'];

        if (isFacebook) {
            return [
                ...base,
                '-f', 'best[ext=mp4]/best',
                '--add-header', `User-Agent:${USER_AGENTS.facebook}`,
                '--add-header', 'Accept-Language:en-US,en;q=0.9',
                '--no-check-certificate',
            ];
        }

        if (isPinterest) {
            return [
                ...base,
                '-f', 'best',
                '--add-header', `User-Agent:${USER_AGENTS.pinterest}`,
                '--no-check-certificate',
            ];
        }

        // YouTube et autres
        return [
            ...base,
            '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]',
            '--merge-output-format', 'mp4',
        ];
    }

    _buildAudioArgs(source, outPath) {
        return [
            source,
            '-x', '--audio-format', 'mp3',
            '--audio-quality', '192K',
            '-o', outPath,
            '--no-playlist',
        ];
    }

    async getInfo(urlOrQuery) {
        try {
            const info = await this.ytdlp.getVideoInfo(this._buildSource(urlOrQuery));
            return {
                title:    info.title    || 'Média',
                duration: info.duration || 0,
                uploader: info.uploader || '',
                filesize: info.filesize_approx || 0,
                platform: detectPlatform(info.webpage_url || urlOrQuery),
            };
        } catch { return null; }
    }

    async downloadVideo(urlOrQuery) {
        const source   = this._buildSource(urlOrQuery);
        const platform = detectPlatform(source);
        const outPath  = path.join(TMP_DIR, `miyabi_${Date.now()}.mp4`);
        logger.info(`[DL] 📥 Vidéo ${platform} : ${urlOrQuery}`);

        try {
            await this.ytdlp.execPromise(this._buildVideoArgs(source, outPath));

            // Chercher le fichier final
            let finalPath = outPath;
            if (!fs.existsSync(outPath)) {
                const base = outPath.replace('.mp4', '');
                for (const ext of ['.mp4', '.mkv', '.webm', '.mov']) {
                    if (fs.existsSync(base + ext)) { finalPath = base + ext; break; }
                }
            }

            if (!fs.existsSync(finalPath)) {
                logger.error('[DL] Fichier introuvable après téléchargement');
                return { success: false, error: 'FILE_NOT_FOUND' };
            }

            const sizeMB = fs.statSync(finalPath).size / (1024 * 1024);
            if (sizeMB > MAX_SIZE_MB) {
                fs.unlinkSync(finalPath);
                return { success: false, error: 'FILE_TOO_LARGE', sizeMB: sizeMB.toFixed(1) };
            }

            const info = await this.getInfo(source).catch(() => null);
            return {
                success:  true,
                path:     finalPath,
                title:    info?.title    || urlOrQuery,
                platform: info?.platform || platform,
                sizeMB:   sizeMB.toFixed(1),
            };

        } catch (err) {
            logger.error('[DL] downloadVideo erreur:', err.message);
            if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            return { success: false, error: 'DOWNLOAD_FAILED' };
        }
    }

    async downloadAudio(urlOrQuery) {
        const source  = this._buildSource(urlOrQuery);
        const outPath = path.join(TMP_DIR, `miyabi_${Date.now()}.mp3`);
        logger.info(`[DL] 🎵 Audio : ${urlOrQuery}`);

        try {
            await this.ytdlp.execPromise(this._buildAudioArgs(source, outPath));

            if (!fs.existsSync(outPath)) {
                logger.error('[DL] Fichier audio introuvable');
                return { success: false, error: 'FILE_NOT_FOUND' };
            }

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

    cleanTmp() {
        const now = Date.now();
        try {
            fs.readdirSync(TMP_DIR).forEach(file => {
                const fp = path.join(TMP_DIR, file);
                if (now - fs.statSync(fp).mtimeMs > 15 * 60 * 1000) {
                    fs.unlinkSync(fp);
                }
            });
        } catch (_) {}
    }

    cleanup(filePath) {
        try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); }
        catch (_) {}
    }
}

module.exports = new DownloadService();
