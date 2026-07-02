// ============================================================
//  src/services/downloadService.js
//  Compatible Termux + Render — ffmpeg path forcé
// ============================================================

const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpeg    = require('fluent-ffmpeg');
const path      = require('path');
const fs        = require('fs');
const logger    = require('../utils/logger');

const TMP_DIR     = path.join(__dirname, '../../tmp');
const BIN_DIR     = path.join(__dirname, '../../bin');
const MAX_SIZE_MB = 50;

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

// ── Configurer ffmpeg ────────────────────────────────────────
let ffmpegPath = null;
try {
    const installer = require('@ffmpeg-installer/ffmpeg');
    ffmpegPath = installer.path;
    ffmpeg.setFfmpegPath(ffmpegPath);
    logger.info('[DL] ffmpeg via @ffmpeg-installer : ' + ffmpegPath);
} catch (_) {
    logger.info('[DL] ffmpeg via système');
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
    pinterest: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    default:   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

class DownloadService {
    constructor() {
        this.ytdlp      = new YTDlpWrap();
        this.ytdlpReady = false;
        this.ytdlpPath  = null;
        this._initYtdlp();
    }

    async _initYtdlp() {
        // 1. Essayer yt-dlp système
        try {
            const { execSync } = require('child_process');
            execSync('yt-dlp --version', { stdio: 'ignore' });
            this.ytdlpReady = true;
            this.ytdlpPath  = 'yt-dlp';
            logger.info('[DL] yt-dlp système détecté');
            return;
        } catch (_) {}

        // 2. Essayer le binaire pré-téléchargé dans bin/
        const binPath = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
        if (fs.existsSync(binPath)) {
            this.ytdlp      = new YTDlpWrap(binPath);
            this.ytdlpReady = true;
            this.ytdlpPath  = binPath;
            logger.info('[DL] yt-dlp binaire trouvé : ' + binPath);
            return;
        }

        // 3. Télécharger le binaire
        try {
            logger.info('[DL] Téléchargement yt-dlp...');
            await YTDlpWrap.downloadFromGithub(binPath);
            if (process.platform !== 'win32') {
                const { execSync } = require('child_process');
                execSync(`chmod +x ${binPath}`);
            }
            this.ytdlp      = new YTDlpWrap(binPath);
            this.ytdlpReady = true;
            this.ytdlpPath  = binPath;
            logger.info('[DL] yt-dlp téléchargé : ' + binPath);
        } catch (err) {
            logger.error('[DL] yt-dlp indisponible:', err.message);
            this.ytdlpReady = false;
        }
    }

    _buildSource(urlOrQuery) {
        if (!urlOrQuery.startsWith('http')) return 'ytsearch1:' + urlOrQuery;
        return urlOrQuery;
    }

    // ── Args selon plateforme ────────────────────────────────
    _buildVideoArgs(source, outPath) {
        const platform    = detectPlatform(source).toLowerCase();
        const isFacebook  = platform === 'facebook';
        const isPinterest = platform === 'pinterest';
        const verbose     = process.env.YTDLP_VERBOSE === 'true' ? ['-v'] : [];

        // Ajouter le chemin ffmpeg si disponible
        const ffmpegArgs = ffmpegPath ? ['--ffmpeg-location', path.dirname(ffmpegPath)] : [];

        const base = [...verbose, source, '-o', outPath, '--no-playlist', ...ffmpegArgs];

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

        // YouTube et autres — format simplifié sans merge pour éviter le besoin de ffmpeg
        return [
            ...base,
            '-f', 'best[ext=mp4]/best[height<=720]/best',
            '--no-playlist',
        ];
    }

    _buildAudioArgs(source, outPath) {
        const ffmpegArgs = ffmpegPath ? ['--ffmpeg-location', path.dirname(ffmpegPath)] : [];
        const verbose    = process.env.YTDLP_VERBOSE === 'true' ? ['-v'] : [];
        return [
            ...verbose,
            source,
            '-x', '--audio-format', 'mp3',
            '--audio-quality', '192K',
            '-o', outPath,
            '--no-playlist',
            ...ffmpegArgs,
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
        if (!this.ytdlpReady) {
            logger.error('[DL] yt-dlp non disponible');
            return { success: false, error: 'DOWNLOAD_FAILED' };
        }

        const source   = this._buildSource(urlOrQuery);
        const platform = detectPlatform(source);
        const outPath  = path.join(TMP_DIR, `miyabi_${Date.now()}.mp4`);
        logger.info(`[DL] 📥 Vidéo ${platform} : ${urlOrQuery}`);

        try {
            const args = this._buildVideoArgs(source, outPath);
            logger.info('[DL] Args: ' + args.join(' '));
            await this.ytdlp.execPromise(args);

            // Chercher le fichier final (yt-dlp peut changer l'extension)
            let finalPath = outPath;
            if (!fs.existsSync(outPath)) {
                const base = outPath.replace('.mp4', '');
                for (const ext of ['.mp4', '.mkv', '.webm', '.mov', '.avi']) {
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

    // ── Télécharger uniquement l'audio ───────────────────────
    async downloadAudio(urlOrQuery) {
        if (!this.ytdlpReady) {
            logger.error('[DL] yt-dlp non disponible');
            return { success: false, error: 'DOWNLOAD_FAILED' };
        }

        const source  = this._buildSource(urlOrQuery);
        const outPath = path.join(TMP_DIR, `miyabi_${Date.now()}.mp3`);
        logger.info(`[DL] 🎵 Audio : ${urlOrQuery}`);

        try {
            const args = this._buildAudioArgs(source, outPath);
            logger.info('[DL] Args: ' + args.join(' '));
            await this.ytdlp.execPromise(args);

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
