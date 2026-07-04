// ============================================================
//  src/services/downloadService.js
//  Cobalt API + fallback — Compatible Render + Termux
// ============================================================

const axios  = require("axios");
const ffmpeg = require("fluent-ffmpeg");
const path   = require("path");
const fs     = require("fs");
const logger = require("../utils/logger");

const TMP_DIR     = path.join(__dirname, "../../tmp");
const MAX_SIZE_MB = 50;

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Configurer ffmpeg
try {
    require("child_process").execSync("ffmpeg -version", { stdio: "ignore" });
    logger.info("[DL] ffmpeg systeme");
} catch (_) {
    try {
        const i = require("@ffmpeg-installer/ffmpeg");
        ffmpeg.setFfmpegPath(i.path);
        logger.info("[DL] ffmpeg installer");
    } catch (_) {}
}

function detectPlatform(url) {
    if (/youtube\.com|youtu\.be/i.test(url))  return "YouTube";
    if (/facebook\.com|fb\.watch/i.test(url)) return "Facebook";
    if (/pinterest\.com|pin\.it/i.test(url))  return "Pinterest";
    if (/instagram\.com/i.test(url))            return "Instagram";
    if (/tiktok\.com/i.test(url))               return "TikTok";
    if (/twitter\.com|x\.com/i.test(url))      return "Twitter";
    return "YouTube";
}

class DownloadService {
    constructor() {
        this.isLocal = !process.env.RENDER;
        if (this.isLocal) {
            try {
                const YTDlpWrap = require("yt-dlp-wrap").default;
                this.ytdlp = new YTDlpWrap();
                logger.info("[DL] Mode Termux - yt-dlp actif");
            } catch (_) { this.ytdlp = null; }
        } else {
            logger.info("[DL] Mode Render - APIs externes");
        }
    }

    async _cobalt(url, type) {
        try {
            const res = await axios.post("https://api.cobalt.tools/", {
                url,
                downloadMode: type === "audio" ? "audio" : "auto",
                audioFormat:  "mp3",
                quality:      "720",
            }, {
                headers: { "Accept": "application/json", "Content-Type": "application/json" },
                timeout: 20000,
            });
            const d = res.data;
            if (d.status === "stream" || d.status === "redirect") return { success: true, downloadUrl: d.url };
            if (d.status === "picker") return { success: true, downloadUrl: d.picker?.[0]?.url };
            return { success: false };
        } catch (err) {
            logger.warn("[DL] Cobalt echec: " + err.message);
            return { success: false };
        }
    }

    async _fallback(url, type) {
        try {
            const base = "https://social-media-downloader-smoky.vercel.app";
            const endpoint = type === "audio"
                ? base + "/ytdl/mp3?url=" + encodeURIComponent(url)
                : base + "/ytdl/mp4?url=" + encodeURIComponent(url);
            const res = await axios.get(endpoint, { timeout: 20000 });
            const d   = res.data;
            const dlUrl = d.url || d.download_url || d.link || null;
            if (dlUrl) return { success: true, downloadUrl: dlUrl };
            return { success: false };
        } catch (err) {
            logger.warn("[DL] Fallback echec: " + err.message);
            return { success: false };
        }
    }

    async _downloadFile(dlUrl, outPath) {
        const res = await axios({
            url: dlUrl, method: "GET", responseType: "stream", timeout: 120000,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        });
        const writer = fs.createWriteStream(outPath);
        res.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on("finish", resolve);
            writer.on("error", reject);
        });
    }

    async _download(urlOrQuery, type) {
        const isUrl    = urlOrQuery.startsWith("http");
        const platform = isUrl ? detectPlatform(urlOrQuery) : "YouTube";
        const ext      = type === "audio" ? "mp3" : "mp4";
        const outPath  = path.join(TMP_DIR, "miyabi_" + Date.now() + "." + ext);

        // Mode Termux
        if (this.isLocal && this.ytdlp) {
            return this._ytdlp(urlOrQuery, type, outPath, platform);
        }

        // Mode Render - APIs externes
        const url = isUrl ? urlOrQuery : "https://www.youtube.com/results?search_query=" + encodeURIComponent(urlOrQuery);

        let result = await this._cobalt(url, type);
        if (!result.success) result = await this._fallback(url, type);
        if (!result.success || !result.downloadUrl) {
            logger.error("[DL] Toutes APIs echouees");
            return { success: false, error: "DOWNLOAD_FAILED" };
        }

        try {
            await this._downloadFile(result.downloadUrl, outPath);
            if (!fs.existsSync(outPath)) return { success: false, error: "FILE_NOT_FOUND" };
            const sizeMB = fs.statSync(outPath).size / (1024 * 1024);
            if (sizeMB > MAX_SIZE_MB) { fs.unlinkSync(outPath); return { success: false, error: "FILE_TOO_LARGE", sizeMB: sizeMB.toFixed(1) }; }
            return { success: true, path: outPath, title: platform + " media", platform, sizeMB: sizeMB.toFixed(1) };
        } catch (err) {
            logger.error("[DL] Download fichier echec: " + err.message);
            if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            return { success: false, error: "DOWNLOAD_FAILED" };
        }
    }

    async _ytdlp(urlOrQuery, type, outPath, platform) {
        const source = urlOrQuery.startsWith("http") ? urlOrQuery : "ytsearch1:" + urlOrQuery;
        logger.info("[DL] yt-dlp " + type + " : " + urlOrQuery);
        try {
            const args = type === "audio"
                ? [source, "-x", "--audio-format", "mp3", "--audio-quality", "192K", "-o", outPath, "--no-playlist"]
                : [source, "-f", "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best", "--merge-output-format", "mp4", "-o", outPath, "--no-playlist"];
            await this.ytdlp.execPromise(args);
            let finalPath = outPath;
            if (!fs.existsSync(outPath)) {
                for (const e of [".mp4", ".mp3", ".mkv", ".webm"]) {
                    const p = outPath.replace(/\.[^.]+$/, e);
                    if (fs.existsSync(p)) { finalPath = p; break; }
                }
            }
            if (!fs.existsSync(finalPath)) return { success: false, error: "FILE_NOT_FOUND" };
            const sizeMB = fs.statSync(finalPath).size / (1024 * 1024);
            if (sizeMB > MAX_SIZE_MB) { fs.unlinkSync(finalPath); return { success: false, error: "FILE_TOO_LARGE", sizeMB: sizeMB.toFixed(1) }; }
            return { success: true, path: finalPath, title: urlOrQuery, platform, sizeMB: sizeMB.toFixed(1) };
        } catch (err) {
            logger.error("[DL] yt-dlp erreur: " + err.message);
            if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            return { success: false, error: "DOWNLOAD_FAILED" };
        }
    }

    async downloadVideo(urlOrQuery) { return this._download(urlOrQuery, "video"); }
    async downloadAudio(urlOrQuery) { return this._download(urlOrQuery, "audio"); }

    async convertToAudio(inputPath) {
        const outPath = path.join(TMP_DIR, "miyabi_conv_" + Date.now() + ".mp3");
        return new Promise((resolve) => {
            ffmpeg(inputPath).noVideo().audioCodec("libmp3lame").audioBitrate("192k").output(outPath)
                .on("end", () => resolve({ success: true, path: outPath }))
                .on("error", (err) => { logger.error("[DL] Conv erreur: " + err.message); resolve({ success: false }); })
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
