// ============================================================
//  src/handlers/messageHandler.js — Miyabi Telegram v2
//  - Répond aux replies en groupe sans mention
//  - Mémoire persistante
//  - Sanitizer corrigé
//  - Pinterest corrigé
// ============================================================

const gemini             = require('../core/gemini');
const personality        = require('../core/personality');
const downloadService    = require('../services/downloadService');
const searchService      = require('../services/searchService');
const groupService       = require('../services/groupService');
const memory             = require('../utils/memory');
const { inspectMessage } = require('../utils/messageSanitizer');
const logger             = require('../utils/logger');
const axios              = require('axios');
const path               = require('path');
const fs                 = require('fs');

function getStickerForMood(name) {
    try { return require('../core/bot').getStickerForMood(name); }
    catch (_) { return null; }
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

            // Mettre à jour la mémoire utilisateur
            memory.setUser(userId, { name: userName, chatId });

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

            // ── VIDÉO REÇUE ───────────────────────────────
            if (msg.video) {
                await this._handleReceivedVideo(bot, msg, chatId, userId, userName);
                return;
            }

            // ── AUDIO / VOCAL REÇU ────────────────────────
            if (msg.audio || msg.voice) {
                await this._handleReceivedAudio(bot, msg, chatId);
                return;
            }

            // ── DOCUMENT VIDÉO/AUDIO ──────────────────────
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

            const text = msg.text || msg.caption || '';
            if (!text) return;

            // ── LOGIQUE D'ACTIVATION EN GROUPE ────────────
            if (isGroup) {
                const botInfo    = await bot.getMe();
                const mentioned  = text.includes(`@${botInfo.username}`);
                // Répondre si : mentionné OU si c'est une réponse à un message du bot
                const isReplyToBot = msg.reply_to_message?.from?.id === botInfo.id;
                if (!mentioned && !isReplyToBot) return;
            }

            const botInfo   = await bot.getMe();
            const cleanText = text.replace(`@${botInfo.username}`, '').trim();

            await bot.sendChatAction(chatId, 'typing');

            // ── APPEL GEMINI ──────────────────────────────
            const result   = await gemini.chat(userId, cleanText, userName);
            const intent   = result.intent;
            const data     = result.data;
            const response = result.response;

            // ── ROUTER ────────────────────────────────────
            switch (intent) {

                case 'DOWNLOAD_VIDEO': {
                    const url = this._extractUrl(cleanText) || data;
                    await this._send(bot, chatId, msg, response);
                    if (url) await this._downloadAndSend(bot, chatId, url, 'video');
                    break;
                }

                case 'DOWNLOAD_AUDIO': {
                    const url = this._extractUrl(cleanText) || data;
                    await this._send(bot, chatId, msg, response);
                    if (url) await this._downloadAndSend(bot, chatId, url, 'audio');
                    break;
                }

                case 'CONVERT_TO_AUDIO':
                    await this._send(bot, chatId, msg, response);
                    await bot.sendMessage(chatId, 'Envoie-moi la vidéo à convertir.');
                    break;

                case 'WEB_SEARCH':
                    await this._send(bot, chatId, msg, response);
                    await this._doSearch(bot, chatId, data || cleanText);
                    break;

                case 'GROUP_LOCK': {
                    if (!isGroup) { await this._send(bot, chatId, msg, 'On est pas dans un groupe.'); return; }
                    const isAdmin = await groupService.isUserAdmin(bot, chatId, userId);
                    if (!isAdmin && !isOwner) { await this._send(bot, chatId, msg, personality.getErrorMessage('NOT_AUTHORIZED')); return; }
                    const r = await groupService.lockGroup(bot, chatId);
                    await this._send(bot, chatId, msg, r.success ? response : personality.getErrorMessage('GROUP_FORBIDDEN'));
                    break;
                }

                case 'GROUP_UNLOCK': {
                    if (!isGroup) { await this._send(bot, chatId, msg, 'On est pas dans un groupe.'); return; }
                    const isAdmin = await groupService.isUserAdmin(bot, chatId, userId);
                    if (!isAdmin && !isOwner) { await this._send(bot, chatId, msg, personality.getErrorMessage('NOT_AUTHORIZED')); return; }
                    const r = await groupService.unlockGroup(bot, chatId);
                    await this._send(bot, chatId, msg, r.success ? response : personality.getErrorMessage('GROUP_FORBIDDEN'));
                    break;
                }

                case 'GROUP_INFO': {
                    if (!isGroup) { await this._send(bot, chatId, msg, 'On est pas dans un groupe.'); return; }
                    const info = await groupService.getGroupInfo(bot, chatId);
                    if (!info.success) { await this._send(bot, chatId, msg, 'Impossible de récupérer les infos.'); return; }
                    const infoText = `${response}\n\n📊 *${info.title}*\n👥 ${info.members} membres\n🔑 ${info.admins} admins\n🔒 ${info.inQ} en quarantaine`;
                    await this._send(bot, chatId, msg, infoText, true);
                    break;
                }

                case 'RESET_CHAT':
                    gemini.clearHistory(userId);
                    await this._send(bot, chatId, msg, response);
                    break;

                default:
                    await this._send(bot, chatId, msg, response);
            }

        } catch (err) {
            logger.error('[HANDLER] Erreur:', err.message);
        }
    }

    // ── Vidéo reçue → boutons inline ─────────────────────────
    async _handleReceivedVideo(bot, msg, chatId, userId, userName) {
        try {
            const fileId = msg.video?.file_id || msg.document?.file_id;
            const sizeMB = ((msg.video?.file_size || msg.document?.file_size || 0) / (1024 * 1024)).toFixed(1);
            const reply  = await gemini.quickReply(
                `${userName} t'envoie une vidéo (${sizeMB} MB). Réponds brièvement et demande : garder en vidéo ou extraire l'audio MP3.`
            );
            await bot.sendMessage(chatId, reply, {
                reply_to_message_id: msg.message_id,
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🎬 Garder en vidéo', callback_data: `keep_video:${fileId}` },
                        { text: '🎵 Extraire en MP3',  callback_data: `to_audio:${fileId}` },
                    ]]
                }
            });
        } catch (err) {
            logger.error('[HANDLER] _handleReceivedVideo erreur:', err.message);
        }
    }

    // ── Audio/vocal reçu ─────────────────────────────────────
    async _handleReceivedAudio(bot, msg, chatId) {
        const waiting = await bot.sendMessage(chatId, '⏳ Traitement audio...', {
            reply_to_message_id: msg.message_id,
        });
        try {
            const fileId    = msg.audio?.file_id || msg.voice?.file_id;
            const title     = msg.audio?.title || msg.audio?.file_name || (msg.voice ? 'Message vocal' : 'Audio');
            const performer = msg.audio?.performer || '';
            const sizeMB    = ((msg.audio?.file_size || msg.voice?.file_size || 0) / (1024 * 1024)).toFixed(1);
            const fileLink  = await bot.getFileLink(fileId);
            const outPath   = path.join(TMP_DIR, `miyabi_audio_${Date.now()}.mp3`);
            const response  = await axios({ url: fileLink, responseType: 'stream', timeout: 60000 });
            const writer    = fs.createWriteStream(outPath);
            response.data.pipe(writer);
            await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });
            await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
            await bot.sendAudio(chatId, outPath, {
                caption: `🎵 ${title}${performer ? ' — ' + performer : ''}\n_${sizeMB} MB_`,
                parse_mode: 'Markdown', title, performer,
                reply_to_message_id: msg.message_id,
            });
            downloadService.cleanup(outPath);
        } catch (err) {
            logger.error('[HANDLER] _handleReceivedAudio erreur:', err.message);
            await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
        }
    }

    // ── Callbacks boutons inline ──────────────────────────────
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
                await bot.sendVideo(chatId, outPath, { caption: '🎬 Voilà.', supports_streaming: true });
                downloadService.cleanup(outPath);
            } catch (err) {
                logger.error('[CALLBACK] keep_video erreur:', err.message);
                await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
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
                if (!result.success) return;
                await bot.sendAudio(chatId, result.path, { caption: '🎵 Conversion terminée.' });
                downloadService.cleanup(result.path);
            } catch (err) {
                logger.error('[CALLBACK] to_audio erreur:', err.message);
                await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
            }
        }
    }

    // ── Télécharger depuis lien ou recherche ──────────────────
    async _downloadAndSend(bot, chatId, urlOrQuery, type) {
        const waiting = await bot.sendMessage(chatId,
            `⏳ ${type === 'audio' ? 'Extraction audio' : 'Téléchargement'}...`
        );
        try {
            const result = type === 'audio'
                ? await downloadService.downloadAudio(urlOrQuery)
                : await downloadService.downloadVideo(urlOrQuery);

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
        }
    }

    // ── Recherche web ─────────────────────────────────────────
    async _doSearch(bot, chatId, query) {
        try {
            const result = await searchService.search(query);
            if (!result.success) return;
            const text = `🔍 *${result.title}*\n\n${result.text}` +
                (result.url ? `\n\n[Source](${result.url})` : '');
            await bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown', disable_web_page_preview: false
            });
        } catch (err) {
            logger.error('[HANDLER] _doSearch erreur:', err.message);
        }
    }

    // ── Envoyer message + sticker ─────────────────────────────
    async _send(bot, chatId, msg, text, markdown = false) {
        try {
            const opts = { reply_to_message_id: msg.message_id };
            if (markdown) opts.parse_mode = 'Markdown';
            await bot.sendMessage(chatId, text, opts);
            // Sticker selon humeur (30% de chance)
            if (Math.random() < 0.30) {
                const sticker = getStickerForMood(personality.getCurrentMood().name);
                if (sticker) await bot.sendSticker(chatId, sticker);
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
