// ============================================================
//  src/services/downloadService.js
//  Compatible Termux + Render
//  Facebook et Pinterest corrigés
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
try {
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
    logger.info('[DL] ffmpeg via @ffmpeg-installer');
} catch (_) {
    logger.info('[DL] ffmpeg via système (Termux)');
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

// ── User-Agents par plateforme ───────────────────────────────
const USER_AGENTS = {
    facebook:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    pinterest: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    default:   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

class DownloadService {
    constructor() {
        this.ytdlp      = new YTDlpWrap();
        this.ytdlpReady = false;
        this._initYtdlp();
    }

    async _initYtdlp() {
        try {
            await this.ytdlp.execPromise(['--version']);
            this.ytdlpReady = true;
            logger.info('[DL] yt-dlp système détecté');
        } catch (_) {
            try {
                const binDir  = path.join(__dirname, '../../bin');
                if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
                const binPath = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
                logger.info('[DL] Téléchargement yt-dlp...');
                await YTDlpWrap.downloadFromGithub(binPath);
                this.ytdlp = new YTDlpWrap(binPath);
                if (process.platform !== 'win32') {
                    const { execSync } = require('child_process');
                    execSync(`chmod +x ${binPath}`);
                }
                this.ytdlpReady = true;
                logger.info('[DL] yt-dlp téléchargé avec succès');
            } catch (err) {
                logger.error('[DL] yt-dlp indisponible:', err.message);
                this.ytdlpReady = false;
            }
        }
    }

    // ── Source yt-dlp ────────────────────────────────────────
    _buildSource(urlOrQuery) {
        if (!urlOrQuery.startsWith('http')) return 'ytsearch1:' + urlOrQuery;
        return urlOrQuery;
    }

    // ── Args selon la plateforme ─────────────────────────────
    _buildVideoArgs(source, outPath) {
        const platform    = detectPlatform(source).toLowerCase();
        const isFacebook  = platform === 'facebook';
        const isPinterest = platform === 'pinterest';

        const baseArgs = [source, '-o', outPath, '--no-playlist'];

        if (isFacebook) {
            return [
                ...baseArgs,
                '-f', 'best[ext=mp4]/best',
                '--add-header', `User-Agent:${USER_AGENTS.facebook}`,
                '--add-header', 'Accept-Language:en-US,en;q=0.9',
                '--no-check-certificate',
            ];
        }

        if (isPinterest) {
            return [
                ...baseArgs,
                '-f', 'best',
                '--add-header', `User-Agent:${USER_AGENTS.pinterest}`,
                '--no-check-certificate',
            ];
        }

        // YouTube et autres
        return [
            ...baseArgs,
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

    // ── Infos sans télécharger ───────────────────────────────
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

    // ── Télécharger une vidéo ────────────────────────────────
    async downloadVideo(urlOrQuery) {
        const source   = this._buildSource(urlOrQuery);
        const platform = detectPlatform(source);
        const outPath  = path.join(TMP_DIR, `miyabi_${Date.now()}.mp4`);
        logger.info(`[DL] 📥 Vidéo ${platform} : ${urlOrQuery}`);

        try {
            await this.ytdlp.execPromise(this._buildVideoArgs(source, outPath));

            // Chercher le fichier (yt-dlp peut changer l'extension)
            let finalPath = outPath;
            if (!fs.existsSync(outPath)) {
                const base = outPath.replace('.mp4', '');
                const exts = ['.mp4', '.mkv', '.webm', '.mov'];
                for (const ext of exts) {
                    if (fs.existsSync(base + ext)) { finalPath = base + ext; break; }
                }
            }

            if (!fs.existsSync(finalPath)) return { success: false, error: 'FILE_NOT_FOUND' };

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

    // ── Télécharger uniquement l'audio ───────────────────────
    async downloadAudio(urlOrQuery) {
        const source  = this._buildSource(urlOrQuery);
        const outPath = path.join(TMP_DIR, `miyabi_${Date.now()}.mp3`);
        logger.info(`[DL] 🎵 Audio : ${urlOrQuery}`);

        try {
            await this.ytdlp.execPromise(this._buildAudioArgs(source, outPath));

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

    // ── Convertir vidéo → MP3 ────────────────────────────────
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