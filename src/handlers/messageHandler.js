// ============================================================
//  src/handlers/messageHandler.js — Miyabi Telegram v2
//  Tout en langage naturel — Gemini détecte les intentions
// ============================================================

const gemini             = require('../core/gemini');
const personality        = require('../core/personality');
const downloadService    = require('../services/downloadService');
const searchService      = require('../services/searchService');
const groupService       = require('../services/groupService');
const { inspectMessage } = require('../utils/messageSanitizer');
const logger             = require('../utils/logger');
const axios              = require('axios');
const path               = require('path');
const fs                 = require('fs');
// Import lazy pour eviter circular dependency
function getStickerForMood(name) {
    try { return require('../core/bot').getStickerForMood(name); }
    catch(_) { return null; }
}

const URL_REGEX = /(https?:\/\/[^\s]+)/i;
const TMP_DIR   = path.join(__dirname, '../../tmp');

class MessageHandler {

    async handle(bot, msg) {
        try {
            const chatId   = msg.chat.id;
            const userId   = msg.from?.id;
            const isGroup  = ['group', 'supergroup'].includes(msg.chat.type);
            const isOwner  = String(userId) === String(process.env.OWNER_ID);

            const firstName = msg.from?.first_name || '';
            const lastName  = msg.from?.last_name  || '';
            const userName  = `${firstName}${lastName ? ' ' + lastName : ''}`.trim() || `User${userId}`;
            gemini.setUserName(userId, userName);

            // ── SANITISATION ──────────────────────────────
            const check = inspectMessage(msg);
            if (check.suspicious) {
                logger.warn(`⚠️ [SANITIZER] ${check.reason}`);
                try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}
                return;
            }

            // ── QUARANTAINE ───────────────────────────────
            if (isGroup && userId && groupService.isInQuarantine(chatId, userId)) {
                try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}
                return;
            }

            // ════════════════════════════════════════════
            //  FICHIERS REÇUS DIRECTEMENT (sans lien)
            // ════════════════════════════════════════════

            // ── Vidéo reçue ───────────────────────────────
            if (msg.video) {
                await this._handleReceivedVideo(bot, msg, chatId, userId, userName);
                return;
            }

            // ── Audio / message vocal reçu ────────────────
            if (msg.audio || msg.voice) {
                await this._handleReceivedAudio(bot, msg, chatId);
                return;
            }

            // ── Document vidéo ou audio reçu ─────────────
            if (msg.document) {
                const mime = msg.document.mime_type || '';
                if (mime.startsWith('video/')) {
                    await this._handleReceivedVideo(bot, msg, chatId, userId, userName);
                    return;
                }
                if (mime.startsWith('audio/')) {
                    await this._handleReceivedAudio(bot, msg, chatId);
                    return;
                }
            }

            // ════════════════════════════════════════════
            //  MESSAGES TEXTE
            // ════════════════════════════════════════════
            const text = msg.text || msg.caption || '';
            if (!text) return;

            // En groupe : seulement si mentionné
            if (isGroup) {
                const botInfo = await bot.getMe();
                if (!text.includes(`@${botInfo.username}`)) return;
            }

            const botInfo   = await bot.getMe();
            const cleanText = text.replace(`@${botInfo.username}`, '').trim();

            await bot.sendChatAction(chatId, 'typing');

            const result = await gemini.chat(userId, cleanText, userName);

            switch (result.intent) {

                case 'DOWNLOAD_VIDEO': {
                    const url = result.data || this._extractUrl(cleanText);
                    if (!url) { await this._send(bot, chatId, msg, result.response); return; }
                    await this._send(bot, chatId, msg, result.response);
                    await this._downloadAndSend(bot, chatId, url, 'video');
                    break;
                }

                case 'DOWNLOAD_AUDIO': {
                    const url = result.data || this._extractUrl(cleanText);
                    if (!url) { await this._send(bot, chatId, msg, result.response); return; }
                    await this._send(bot, chatId, msg, result.response);
                    await this._downloadAndSend(bot, chatId, url, 'audio');
                    break;
                }

                case 'CONVERT_TO_AUDIO':
                    await this._send(bot, chatId, msg, result.response);
                    await bot.sendMessage(chatId, 'Envoie-moi la vidéo à convertir.');
                    break;

                case 'WEB_SEARCH': {
                    const query = result.data || cleanText;
                    await this._send(bot, chatId, msg, result.response);
                    await this._doSearch(bot, chatId, query);
                    break;
                }

                case 'GROUP_LOCK': {
                    if (!isGroup) { await this._send(bot, chatId, msg, 'On est pas dans un groupe.'); return; }
                    const isAdmin = await groupService.isUserAdmin(bot, chatId, userId);
                    if (!isAdmin && !isOwner) { await this._send(bot, chatId, msg, personality.getErrorMessage('NOT_AUTHORIZED')); return; }
                    const r = await groupService.lockGroup(bot, chatId);
                    await this._send(bot, chatId, msg, r.success ? result.response : `Echec : ${r.error}`);
                    break;
                }

                case 'GROUP_UNLOCK': {
                    if (!isGroup) { await this._send(bot, chatId, msg, 'On est pas dans un groupe.'); return; }
                    const isAdmin = await groupService.isUserAdmin(bot, chatId, userId);
                    if (!isAdmin && !isOwner) { await this._send(bot, chatId, msg, personality.getErrorMessage('NOT_AUTHORIZED')); return; }
                    const r = await groupService.unlockGroup(bot, chatId);
                    await this._send(bot, chatId, msg, r.success ? result.response : `Echec : ${r.error}`);
                    break;
                }

                case 'GROUP_INFO': {
                    if (!isGroup) { await this._send(bot, chatId, msg, 'On est pas dans un groupe.'); return; }
                    const info = await groupService.getGroupInfo(bot, chatId);
                    if (!info.success) { await this._send(bot, chatId, msg, 'Impossible de récupérer les infos.'); return; }
                    const infoText = `${result.response}\n\n📊 *${info.title}*\n👥 ${info.members} membres\n🔑 ${info.admins} admins\n🔒 ${info.inQ} en quarantaine`;
                    await this._send(bot, chatId, msg, infoText, true);
                    break;
                }

                case 'RESET_CHAT':
                    gemini.clearHistory(userId);
                    await this._send(bot, chatId, msg, result.response);
                    break;

                default:
                    await this._send(bot, chatId, msg, result.response);
            }

        } catch (err) {
            logger.error('[HANDLER] Erreur:', err.message);
        }
    }

    // ════════════════════════════════════════════════════════
    //  VIDÉO REÇUE — Proposer : garder vidéo OU convertir MP3
    // ════════════════════════════════════════════════════════
    async _handleReceivedVideo(bot, msg, chatId, userId, userName) {
        try {
            const fileId   = msg.video?.file_id || msg.document?.file_id;
            const fileName = msg.document?.file_name || 'vidéo';
            const sizeMB   = ((msg.video?.file_size || msg.document?.file_size || 0) / (1024 * 1024)).toFixed(1);

            // Miyabi répond avec sa personnalité + boutons inline
            const reply = await gemini.quickReply(
                `${userName} t'envoie une vidéo (${sizeMB} MB). Réponds brièvement que tu l'as reçue et demande ce qu'il veut en faire : la garder en vidéo ou extraire l'audio en MP3.`
            );

            await bot.sendMessage(chatId, reply, {
                reply_to_message_id: msg.message_id,
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🎬 Garder en vidéo',  callback_data: `keep_video:${fileId}` },
                        { text: '🎵 Extraire en MP3',  callback_data: `to_audio:${fileId}` },
                    ]]
                }
            });

        } catch (err) {
            logger.error('[HANDLER] _handleReceivedVideo erreur:', err.message);
        }
    }

    // ════════════════════════════════════════════════════════
    //  AUDIO / VOCAL REÇU — Télécharger et renvoyer proprement
    // ════════════════════════════════════════════════════════
    async _handleReceivedAudio(bot, msg, chatId) {
        const waiting = await bot.sendMessage(chatId, '⏳ Traitement audio...', {
            reply_to_message_id: msg.message_id,
        });
        try {
            const isVoice  = !!msg.voice;
            const fileId   = msg.audio?.file_id || msg.voice?.file_id;
            const title    = msg.audio?.title    || msg.audio?.file_name || (isVoice ? 'Message vocal' : 'Audio');
            const performer = msg.audio?.performer || '';
            const sizeMB   = ((msg.audio?.file_size || msg.voice?.file_size || 0) / (1024 * 1024)).toFixed(1);

            // Télécharger depuis Telegram
            const fileLink = await bot.getFileLink(fileId);
            const outPath  = path.join(TMP_DIR, `miyabi_audio_${Date.now()}.mp3`);

            const response = await axios({ url: fileLink, responseType: 'stream', timeout: 60000 });
            const writer   = fs.createWriteStream(outPath);
            response.data.pipe(writer);
            await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });

            await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});

            // Renvoyer l'audio proprement formaté
            await bot.sendAudio(chatId, outPath, {
                caption:    `🎵 ${title}${performer ? ' — ' + performer : ''}\n_${sizeMB} MB_`,
                parse_mode: 'Markdown',
                title,
                performer,
                reply_to_message_id: msg.message_id,
            });

            downloadService.cleanup(outPath);

        } catch (err) {
            logger.error('[HANDLER] _handleReceivedAudio erreur:', err.message);
            await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
            await bot.sendMessage(chatId, personality.getErrorMessage('DOWNLOAD_FAILED'));
        }
    }

    // ════════════════════════════════════════════════════════
    //  CALLBACK — Boutons inline (garder vidéo / convertir)
    // ════════════════════════════════════════════════════════
    async handleCallback(bot, query) {
        const chatId = query.message?.chat?.id;
        const data   = query.data || '';
        await bot.answerCallbackQuery(query.id);

        if (data.startsWith('keep_video:')) {
            const fileId  = data.replace('keep_video:', '');
            const waiting = await bot.sendMessage(chatId, '⏳ Téléchargement...');
            try {
                const fileLink = await bot.getFileLink(fileId);
                const outPath  = path.join(TMP_DIR, `miyabi_vid_${Date.now()}.mp4`);

                const response = await axios({ url: fileLink, responseType: 'stream', timeout: 120000 });
                const writer   = fs.createWriteStream(outPath);
                response.data.pipe(writer);
                await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });

                await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
                await bot.sendVideo(chatId, outPath, {
                    caption: '🎬 Voilà.',
                    supports_streaming: true,
                });
                downloadService.cleanup(outPath);
            } catch (err) {
                logger.error('[CALLBACK] keep_video erreur:', err.message);
                await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
                await bot.sendMessage(chatId, personality.getErrorMessage('DOWNLOAD_FAILED'));
            }
        }

        if (data.startsWith('to_audio:')) {
            const fileId  = data.replace('to_audio:', '');
            const waiting = await bot.sendMessage(chatId, '🔄 Conversion en MP3...');
            try {
                const fileLink = await bot.getFileLink(fileId);
                const tmpVid   = path.join(TMP_DIR, `miyabi_conv_in_${Date.now()}.mp4`);

                const response = await axios({ url: fileLink, responseType: 'stream', timeout: 120000 });
                const writer   = fs.createWriteStream(tmpVid);
                response.data.pipe(writer);
                await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });

                const result = await downloadService.convertToAudio(tmpVid);
                await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
                downloadService.cleanup(tmpVid);

                if (!result.success) {
                    await bot.sendMessage(chatId, personality.getErrorMessage('DOWNLOAD_FAILED'));
                    return;
                }

                await bot.sendAudio(chatId, result.path, { caption: '🎵 Conversion terminée.' });
                downloadService.cleanup(result.path);

            } catch (err) {
                logger.error('[CALLBACK] to_audio erreur:', err.message);
                await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
                await bot.sendMessage(chatId, personality.getErrorMessage('DOWNLOAD_FAILED'));
            }
        }
    }

    // ── Télécharger depuis un lien ────────────────────────────
    async _downloadAndSend(bot, chatId, url, type) {
        const waiting = await bot.sendMessage(chatId, `⏳ ${type === 'audio' ? 'Extraction audio' : 'Téléchargement'}...`);
        try {
            const result = type === 'audio'
                ? await downloadService.downloadAudio(url)
                : await downloadService.downloadVideo(url);

            await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});

            if (!result.success) {
                const errMsg = result.error === 'FILE_TOO_LARGE'
                    ? `Trop lourd (${result.sizeMB} MB). Max 50 MB.`
                    : personality.getErrorMessage('DOWNLOAD_FAILED');
                await bot.sendMessage(chatId, errMsg);
                return;
            }

            const caption = `📥 *${result.title}*\n_${result.platform} • ${result.sizeMB} MB_`;
            if (type === 'audio') {
                await bot.sendAudio(chatId, result.path, { caption, parse_mode: 'Markdown', title: result.title });
            } else {
                await bot.sendVideo(chatId, result.path, { caption, parse_mode: 'Markdown', supports_streaming: true });
            }
            downloadService.cleanup(result.path);

        } catch (err) {
            logger.error('[HANDLER] _downloadAndSend erreur:', err.message);
            await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
            await bot.sendMessage(chatId, personality.getErrorMessage('DOWNLOAD_FAILED'));
        }
    }

    // ── Recherche web ─────────────────────────────────────────
    async _doSearch(bot, chatId, query) {
        const result = await searchService.search(query);
        if (!result.success) { await bot.sendMessage(chatId, personality.getErrorMessage('SEARCH_FAILED')); return; }
        const text = `🔍 *${result.title}*\n\n${result.text}` + (result.url ? `\n\n[Source](${result.url})` : '');
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', disable_web_page_preview: false });
    }

    async _send(bot, chatId, msg, text, markdown = false) {
        try {
            const opts = { reply_to_message_id: msg.message_id };
            if (markdown) opts.parse_mode = 'Markdown';
            await bot.sendMessage(chatId, text, opts);

            // Envoyer le sticker apres chaque reponse (30% de chance)
            // pour ne pas surcharger la conversation
            if (Math.random() < 0.30) {
                const mood    = personality.getCurrentMood().name;
                const sticker = getStickerForMood(mood);
                if (sticker) {
                    await bot.sendSticker(chatId, sticker);
                }
            }
        } catch (err) {
            logger.error('[HANDLER] _send erreur:', err.message);
        }
    }

    _extractUrl(text) {
        const match = text.match(URL_REGEX);
        return match ? match[0] : null;
    }
}

module.exports = new MessageHandler();
// ============================================================
//  src/handlers/messageHandler.js — Miyabi Telegram v2
//  Tout en langage naturel — Gemini détecte les intentions
// ============================================================

const gemini             = require('../core/gemini');
const personality        = require('../core/personality');
const downloadService    = require('../services/downloadService');
const searchService      = require('../services/searchService');
const groupService       = require('../services/groupService');
const { inspectMessage } = require('../utils/messageSanitizer');
const logger             = require('../utils/logger');
const axios              = require('axios');
const path               = require('path');
const fs                 = require('fs');

const URL_REGEX = /(https?:\/\/[^\s]+)/i;
const TMP_DIR   = path.join(__dirname, '../../tmp');

class MessageHandler {

    async handle(bot, msg) {
        try {
            const chatId   = msg.chat.id;
            const userId   = msg.from?.id;
            const isGroup  = ['group', 'supergroup'].includes(msg.chat.type);
            const isOwner  = String(userId) === String(process.env.OWNER_ID);

            const firstName = msg.from?.first_name || '';
            const lastName  = msg.from?.last_name  || '';
            const userName  = `${firstName}${lastName ? ' ' + lastName : ''}`.trim() || `User${userId}`;
            gemini.setUserName(userId, userName);

            // ── SANITISATION ──────────────────────────────
            const check = inspectMessage(msg);
            if (check.suspicious) {
                logger.warn(`⚠️ [SANITIZER] ${check.reason}`);
                try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}
                return;
            }

            // ── QUARANTAINE ───────────────────────────────
            if (isGroup && userId && groupService.isInQuarantine(chatId, userId)) {
                try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}
                return;
            }

            // ════════════════════════════════════════════
            //  FICHIERS REÇUS DIRECTEMENT (sans lien)
            // ════════════════════════════════════════════

            // ── Vidéo reçue ───────────────────────────────
            if (msg.video) {
                await this._handleReceivedVideo(bot, msg, chatId, userId, userName);
                return;
            }

            // ── Audio / message vocal reçu ────────────────
            if (msg.audio || msg.voice) {
                await this._handleReceivedAudio(bot, msg, chatId);
                return;
            }

            // ── Document vidéo ou audio reçu ─────────────
            if (msg.document) {
                const mime = msg.document.mime_type || '';
                if (mime.startsWith('video/')) {
                    await this._handleReceivedVideo(bot, msg, chatId, userId, userName);
                    return;
                }
                if (mime.startsWith('audio/')) {
                    await this._handleReceivedAudio(bot, msg, chatId);
                    return;
                }
            }

            // ════════════════════════════════════════════
            //  MESSAGES TEXTE
            // ════════════════════════════════════════════
            const text = msg.text || msg.caption || '';
            if (!text) return;

            // En groupe : seulement si mentionné
            if (isGroup) {
                const botInfo = await bot.getMe();
                if (!text.includes(`@${botInfo.username}`)) return;
            }

            const botInfo   = await bot.getMe();
            const cleanText = text.replace(`@${botInfo.username}`, '').trim();

            await bot.sendChatAction(chatId, 'typing');

            const result = await gemini.chat(userId, cleanText, userName);

            switch (result.intent) {

                case 'DOWNLOAD_VIDEO': {
                    const url = result.data || this._extractUrl(cleanText);
                    if (!url) { await this._send(bot, chatId, msg, result.response); return; }
                    await this._send(bot, chatId, msg, result.response);
                    await this._downloadAndSend(bot, chatId, url, 'video');
                    break;
                }

                case 'DOWNLOAD_AUDIO': {
                    const url = result.data || this._extractUrl(cleanText);
                    if (!url) { await this._send(bot, chatId, msg, result.response); return; }
                    await this._send(bot, chatId, msg, result.response);
                    await this._downloadAndSend(bot, chatId, url, 'audio');
                    break;
                }

                case 'CONVERT_TO_AUDIO':
                    await this._send(bot, chatId, msg, result.response);
                    await bot.sendMessage(chatId, 'Envoie-moi la vidéo à convertir.');
                    break;

                case 'WEB_SEARCH': {
                    const query = result.data || cleanText;
                    await this._send(bot, chatId, msg, result.response);
                    await this._doSearch(bot, chatId, query);
                    break;
                }

                case 'GROUP_LOCK': {
                    if (!isGroup) { await this._send(bot, chatId, msg, 'On est pas dans un groupe.'); return; }
                    const isAdmin = await groupService.isUserAdmin(bot, chatId, userId);
                    if (!isAdmin && !isOwner) { await this._send(bot, chatId, msg, personality.getErrorMessage('NOT_AUTHORIZED')); return; }
                    const r = await groupService.lockGroup(bot, chatId);
                    await this._send(bot, chatId, msg, r.success ? result.response : `Echec : ${r.error}`);
                    break;
                }

                case 'GROUP_UNLOCK': {
                    if (!isGroup) { await this._send(bot, chatId, msg, 'On est pas dans un groupe.'); return; }
                    const isAdmin = await groupService.isUserAdmin(bot, chatId, userId);
                    if (!isAdmin && !isOwner) { await this._send(bot, chatId, msg, personality.getErrorMessage('NOT_AUTHORIZED')); return; }
                    const r = await groupService.unlockGroup(bot, chatId);
                    await this._send(bot, chatId, msg, r.success ? result.response : `Echec : ${r.error}`);
                    break;
                }

                case 'GROUP_INFO': {
                    if (!isGroup) { await this._send(bot, chatId, msg, 'On est pas dans un groupe.'); return; }
                    const info = await groupService.getGroupInfo(bot, chatId);
                    if (!info.success) { await this._send(bot, chatId, msg, 'Impossible de récupérer les infos.'); return; }
                    const infoText = `${result.response}\n\n📊 *${info.title}*\n👥 ${info.members} membres\n🔑 ${info.admins} admins\n🔒 ${info.inQ} en quarantaine`;
                    await this._send(bot, chatId, msg, infoText, true);
                    break;
                }

                case 'RESET_CHAT':
                    gemini.clearHistory(userId);
                    await this._send(bot, chatId, msg, result.response);
                    break;

                default:
                    await this._send(bot, chatId, msg, result.response);
            }

        } catch (err) {
            logger.error('[HANDLER] Erreur:', err.message);
        }
    }

    // ════════════════════════════════════════════════════════
    //  VIDÉO REÇUE — Proposer : garder vidéo OU convertir MP3
    // ════════════════════════════════════════════════════════
    async _handleReceivedVideo(bot, msg, chatId, userId, userName) {
        try {
            const fileId   = msg.video?.file_id || msg.document?.file_id;
            const fileName = msg.document?.file_name || 'vidéo';
            const sizeMB   = ((msg.video?.file_size || msg.document?.file_size || 0) / (1024 * 1024)).toFixed(1);

            // Miyabi répond avec sa personnalité + boutons inline
            const reply = await gemini.quickReply(
                `${userName} t'envoie une vidéo (${sizeMB} MB). Réponds brièvement que tu l'as reçue et demande ce qu'il veut en faire : la garder en vidéo ou extraire l'audio en MP3.`
            );

            await bot.sendMessage(chatId, reply, {
                reply_to_message_id: msg.message_id,
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🎬 Garder en vidéo',  callback_data: `keep_video:${fileId}` },
                        { text: '🎵 Extraire en MP3',  callback_data: `to_audio:${fileId}` },
                    ]]
                }
            });

        } catch (err) {
            logger.error('[HANDLER] _handleReceivedVideo erreur:', err.message);
        }
    }

    // ════════════════════════════════════════════════════════
    //  AUDIO / VOCAL REÇU — Télécharger et renvoyer proprement
    // ════════════════════════════════════════════════════════
    async _handleReceivedAudio(bot, msg, chatId) {
        const waiting = await bot.sendMessage(chatId, '⏳ Traitement audio...', {
            reply_to_message_id: msg.message_id,
        });
        try {
            const isVoice  = !!msg.voice;
            const fileId   = msg.audio?.file_id || msg.voice?.file_id;
            const title    = msg.audio?.title    || msg.audio?.file_name || (isVoice ? 'Message vocal' : 'Audio');
            const performer = msg.audio?.performer || '';
            const sizeMB   = ((msg.audio?.file_size || msg.voice?.file_size || 0) / (1024 * 1024)).toFixed(1);

            // Télécharger depuis Telegram
            const fileLink = await bot.getFileLink(fileId);
            const outPath  = path.join(TMP_DIR, `miyabi_audio_${Date.now()}.mp3`);

            const response = await axios({ url: fileLink, responseType: 'stream', timeout: 60000 });
            const writer   = fs.createWriteStream(outPath);
            response.data.pipe(writer);
            await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });

            await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});

            // Renvoyer l'audio proprement formaté
            await bot.sendAudio(chatId, outPath, {
                caption:    `🎵 ${title}${performer ? ' — ' + performer : ''}\n_${sizeMB} MB_`,
                parse_mode: 'Markdown',
                title,
                performer,
                reply_to_message_id: msg.message_id,
            });

            downloadService.cleanup(outPath);

        } catch (err) {
            logger.error('[HANDLER] _handleReceivedAudio erreur:', err.message);
            await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
            await bot.sendMessage(chatId, personality.getErrorMessage('DOWNLOAD_FAILED'));
        }
    }

    // ════════════════════════════════════════════════════════
    //  CALLBACK — Boutons inline (garder vidéo / convertir)
    // ════════════════════════════════════════════════════════
    async handleCallback(bot, query) {
        const chatId = query.message?.chat?.id;
        const data   = query.data || '';
        await bot.answerCallbackQuery(query.id);

        if (data.startsWith('keep_video:')) {
            const fileId  = data.replace('keep_video:', '');
            const waiting = await bot.sendMessage(chatId, '⏳ Téléchargement...');
            try {
                const fileLink = await bot.getFileLink(fileId);
                const outPath  = path.join(TMP_DIR, `miyabi_vid_${Date.now()}.mp4`);

                const response = await axios({ url: fileLink, responseType: 'stream', timeout: 120000 });
                const writer   = fs.createWriteStream(outPath);
                response.data.pipe(writer);
                await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });

                await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
                await bot.sendVideo(chatId, outPath, {
                    caption: '🎬 Voilà.',
                    supports_streaming: true,
                });
                downloadService.cleanup(outPath);
            } catch (err) {
                logger.error('[CALLBACK] keep_video erreur:', err.message);
                await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
                await bot.sendMessage(chatId, personality.getErrorMessage('DOWNLOAD_FAILED'));
            }
        }

        if (data.startsWith('to_audio:')) {
            const fileId  = data.replace('to_audio:', '');
            const waiting = await bot.sendMessage(chatId, '🔄 Conversion en MP3...');
            try {
                const fileLink = await bot.getFileLink(fileId);
                const tmpVid   = path.join(TMP_DIR, `miyabi_conv_in_${Date.now()}.mp4`);

                const response = await axios({ url: fileLink, responseType: 'stream', timeout: 120000 });
                const writer   = fs.createWriteStream(tmpVid);
                response.data.pipe(writer);
                await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });

                const result = await downloadService.convertToAudio(tmpVid);
                await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
                downloadService.cleanup(tmpVid);

                if (!result.success) {
                    await bot.sendMessage(chatId, personality.getErrorMessage('DOWNLOAD_FAILED'));
                    return;
                }

                await bot.sendAudio(chatId, result.path, { caption: '🎵 Conversion terminée.' });
                downloadService.cleanup(result.path);

            } catch (err) {
                logger.error('[CALLBACK] to_audio erreur:', err.message);
                await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
                await bot.sendMessage(chatId, personality.getErrorMessage('DOWNLOAD_FAILED'));
            }
        }
    }

    // ── Télécharger depuis un lien ────────────────────────────
    async _downloadAndSend(bot, chatId, url, type) {
        const waiting = await bot.sendMessage(chatId, `⏳ ${type === 'audio' ? 'Extraction audio' : 'Téléchargement'}...`);
        try {
            const result = type === 'audio'
                ? await downloadService.downloadAudio(url)
                : await downloadService.downloadVideo(url);

            await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});

            if (!result.success) {
                const errMsg = result.error === 'FILE_TOO_LARGE'
                    ? `Trop lourd (${result.sizeMB} MB). Max 50 MB.`
                    : personality.getErrorMessage('DOWNLOAD_FAILED');
                await bot.sendMessage(chatId, errMsg);
                return;
            }

            const caption = `📥 *${result.title}*\n_${result.platform} • ${result.sizeMB} MB_`;
            if (type === 'audio') {
                await bot.sendAudio(chatId, result.path, { caption, parse_mode: 'Markdown', title: result.title });
            } else {
                await bot.sendVideo(chatId, result.path, { caption, parse_mode: 'Markdown', supports_streaming: true });
            }
            downloadService.cleanup(result.path);

        } catch (err) {
            logger.error('[HANDLER] _downloadAndSend erreur:', err.message);
            await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
            await bot.sendMessage(chatId, personality.getErrorMessage('DOWNLOAD_FAILED'));
        }
    }

    // ── Recherche web ─────────────────────────────────────────
    async _doSearch(bot, chatId, query) {
        const result = await searchService.search(query);
        if (!result.success) { await bot.sendMessage(chatId, personality.getErrorMessage('SEARCH_FAILED')); return; }
        const text = `🔍 *${result.title}*\n\n${result.text}` + (result.url ? `\n\n[Source](${result.url})` : '');
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', disable_web_page_preview: false });
    }

    async _send(bot, chatId, msg, text, markdown = false) {
        try {
            const opts = { reply_to_message_id: msg.message_id };
            if (markdown) opts.parse_mode = 'Markdown';
            await bot.sendMessage(chatId, text, opts);
        } catch (err) {
            logger.error('[HANDLER] _send erreur:', err.message);
        }
    }

    _extractUrl(text) {
        const match = text.match(URL_REGEX);
        return match ? match[0] : null;
    }
}

module.exports = new MessageHandler();
