// ============================================================
//  src/handlers/messageHandler.js — Miyabi Telegram v2
//  Wallet RP intégré
// ============================================================

const gemini             = require('../core/gemini');
const personality        = require('../core/personality');
const downloadService    = require('../services/downloadService');
const searchService      = require('../services/searchService');
const groupService       = require('../services/groupService');
const walletService      = require('../services/walletService');
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

// Nom d'affichage de l'admin selon son ID
function getAdminName(userId) {
    if (String(userId) === String(process.env.OWNER_ID)) return 'L. Lycoris';
    if (String(userId) === '5912513979') return 'Lunafreya';
    return 'Admin';
}

class MessageHandler {

    async handle(bot, msg) {
        try {
            const chatId   = msg.chat.id;
            const userId   = msg.from?.id;
            const isGroup  = ['group', 'supergroup'].includes(msg.chat.type);
            const isOwner  = String(userId) === String(process.env.OWNER_ID);
            const isAdmin  = walletService.isAdmin(userId);

            const firstName = msg.from?.first_name || '';
            const lastName  = msg.from?.last_name  || '';
            const userName  = `${firstName}${lastName ? ' ' + lastName : ''}`.trim() || `User${userId}`;

            memory.setUser(userId, { name: userName, chatId });

            // ── SANITISATION ──────────────────────────────
            const check = inspectMessage(msg);
            if (check.suspicious) {
                logger.warn(`[SANITIZER] ${check.reason}`);
                try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}
                return;
            }

            // ── QUARANTAINE ───────────────────────────────
            if (isGroup && userId && groupService.isInQuarantine(chatId, userId)) {
                try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}
                return;
            }

            // ── FICHIERS REÇUS ────────────────────────────
            if (msg.video) { await this._handleReceivedVideo(bot, msg, chatId, userId, userName); return; }
            if (msg.audio || msg.voice) { await this._handleReceivedAudio(bot, msg, chatId); return; }
            if (msg.document) {
                const mime = msg.document.mime_type || '';
                if (mime.startsWith('video/')) { await this._handleReceivedVideo(bot, msg, chatId, userId, userName); return; }
                if (mime.startsWith('audio/')) { await this._handleReceivedAudio(bot, msg, chatId); return; }
            }

            const text = msg.text || msg.caption || '';
            if (!text) return;

            // ── EN GROUPE : répondre si mentionné ou reply ─
            if (isGroup) {
                const botInfo      = await bot.getMe();
                const mentioned    = text.includes(`@${botInfo.username}`);
                const isReplyToBot = msg.reply_to_message?.from?.id === botInfo.id;
                if (!mentioned && !isReplyToBot) return;
            }

            const botInfo   = await bot.getMe();
            const cleanText = text.replace(`@${botInfo.username}`, '').trim();

            await bot.sendChatAction(chatId, 'typing');

            const result   = await gemini.chat(userId, cleanText, userName);
            const intent   = result.intent;
            const data     = result.data;
            const response = result.response;

            // ── ROUTER ────────────────────────────────────
            switch (intent) {

                // ── MEDIA ─────────────────────────────────
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

                // ── GROUPE ────────────────────────────────
                case 'GROUP_LOCK': {
                    if (!isGroup) { await this._send(bot, chatId, msg, 'On est pas dans un groupe.'); return; }
                    const isAdm = await groupService.isUserAdmin(bot, chatId, userId);
                    if (!isAdm && !isOwner) { await this._send(bot, chatId, msg, personality.getErrorMessage('NOT_AUTHORIZED')); return; }
                    const r = await groupService.lockGroup(bot, chatId);
                    await this._send(bot, chatId, msg, r.success ? response : personality.getErrorMessage('GROUP_FORBIDDEN'));
                    break;
                }
                case 'GROUP_UNLOCK': {
                    if (!isGroup) { await this._send(bot, chatId, msg, 'On est pas dans un groupe.'); return; }
                    const isAdm = await groupService.isUserAdmin(bot, chatId, userId);
                    if (!isAdm && !isOwner) { await this._send(bot, chatId, msg, personality.getErrorMessage('NOT_AUTHORIZED')); return; }
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

                // ── WALLET ────────────────────────────────
                case 'WALLET_CREATE': {
                    if (!isAdmin) { await this._send(bot, chatId, msg, personality.getErrorMessage('NOT_AUTHORIZED')); return; }
                    try {
                        const playerData = typeof data === 'string' ? JSON.parse(data) : data;
                        const adminName  = getAdminName(userId);
                        const r = walletService.createWallet(userId, playerData, adminName);
                        if (!r.success) {
                            const errMsg = r.error === 'ALREADY_EXISTS'
                                ? `La fiche de *${r.pseudo}* existe déjà.`
                                : personality.getErrorMessage('NOT_AUTHORIZED');
                            await this._send(bot, chatId, msg, errMsg, true);
                            return;
                        }
                        await this._send(bot, chatId, msg, response);
                        await bot.sendMessage(chatId, walletService.formatWallet(r.player, adminName), { parse_mode: 'Markdown' });
                    } catch (e) {
                        await this._send(bot, chatId, msg, 'Données invalides pour créer la fiche.');
                    }
                    break;
                }

                case 'WALLET_ADD_GEMS': {
                    if (!isAdmin) { await this._send(bot, chatId, msg, personality.getErrorMessage('NOT_AUTHORIZED')); return; }
                    try {
                        const { target, amount } = typeof data === 'string' ? JSON.parse(data) : data;
                        const adminName = getAdminName(userId);
                        const r = walletService.updateGems(userId, target, amount, 'add', adminName);
                        if (!r.success) {
                            await this._send(bot, chatId, msg, r.error === 'NOT_FOUND' ? `Joueur *${target}* introuvable.` : personality.getErrorMessage('NOT_AUTHORIZED'), true);
                            return;
                        }
                        await this._send(bot, chatId, msg, response);
                        await bot.sendMessage(chatId, walletService.formatWallet(r.player, adminName), { parse_mode: 'Markdown' });
                    } catch (e) {
                        await this._send(bot, chatId, msg, 'Données invalides.');
                    }
                    break;
                }

                case 'WALLET_REMOVE_GEMS': {
                    if (!isAdmin) { await this._send(bot, chatId, msg, personality.getErrorMessage('NOT_AUTHORIZED')); return; }
                    try {
                        const { target, amount } = typeof data === 'string' ? JSON.parse(data) : data;
                        const adminName = getAdminName(userId);
                        const r = walletService.updateGems(userId, target, amount, 'remove', adminName);
                        if (!r.success) {
                            await this._send(bot, chatId, msg, r.error === 'NOT_FOUND' ? `Joueur *${target}* introuvable.` : personality.getErrorMessage('NOT_AUTHORIZED'), true);
                            return;
                        }
                        await this._send(bot, chatId, msg, response);
                        await bot.sendMessage(chatId, walletService.formatWallet(r.player, adminName), { parse_mode: 'Markdown' });
                    } catch (e) {
                        await this._send(bot, chatId, msg, 'Données invalides.');
                    }
                    break;
                }

                case 'WALLET_ADD_AC': {
                    if (!isAdmin) { await this._send(bot, chatId, msg, personality.getErrorMessage('NOT_AUTHORIZED')); return; }
                    try {
                        const { target, amount } = typeof data === 'string' ? JSON.parse(data) : data;
                        const adminName = getAdminName(userId);
                        const r = walletService.updateAbyssCoins(userId, target, amount, 'add', adminName);
                        if (!r.success) {
                            await this._send(bot, chatId, msg, r.error === 'NOT_FOUND' ? `Joueur *${target}* introuvable.` : personality.getErrorMessage('NOT_AUTHORIZED'), true);
                            return;
                        }
                        await this._send(bot, chatId, msg, response);
                        await bot.sendMessage(chatId, walletService.formatWallet(r.player, adminName), { parse_mode: 'Markdown' });
                    } catch (e) {
                        await this._send(bot, chatId, msg, 'Données invalides.');
                    }
                    break;
                }

                case 'WALLET_REMOVE_AC': {
                    if (!isAdmin) { await this._send(bot, chatId, msg, personality.getErrorMessage('NOT_AUTHORIZED')); return; }
                    try {
                        const { target, amount } = typeof data === 'string' ? JSON.parse(data) : data;
                        const adminName = getAdminName(userId);
                        const r = walletService.updateAbyssCoins(userId, target, amount, 'remove', adminName);
                        if (!r.success) {
                            await this._send(bot, chatId, msg, r.error === 'NOT_FOUND' ? `Joueur *${target}* introuvable.` : personality.getErrorMessage('NOT_AUTHORIZED'), true);
                            return;
                        }
                        await this._send(bot, chatId, msg, response);
                        await bot.sendMessage(chatId, walletService.formatWallet(r.player, adminName), { parse_mode: 'Markdown' });
                    } catch (e) {
                        await this._send(bot, chatId, msg, 'Données invalides.');
                    }
                    break;
                }

                case 'WALLET_SHOW': {
                    const target = typeof data === 'string' ? data : data?.target || '';
                    const r = walletService.getWallet(target);
                    if (!r.success) {
                        await this._send(bot, chatId, msg, `Joueur *${target}* introuvable.`, true);
                        return;
                    }
                    await this._send(bot, chatId, msg, response);
                    await bot.sendMessage(chatId, walletService.formatWallet(r.player), { parse_mode: 'Markdown' });
                    break;
                }

                case 'WALLET_DELETE': {
                    if (!isAdmin) { await this._send(bot, chatId, msg, personality.getErrorMessage('NOT_AUTHORIZED')); return; }
                    const target = typeof data === 'string' ? data : data?.target || '';
                    const r = walletService.deleteWallet(userId, target);
                    if (!r.success) {
                        await this._send(bot, chatId, msg, r.error === 'NOT_FOUND' ? `Joueur *${target}* introuvable.` : personality.getErrorMessage('NOT_AUTHORIZED'), true);
                        return;
                    }
                    await this._send(bot, chatId, msg, `Fiche de *${r.pseudo}* supprimée.`, true);
                    break;
                }

                case 'WALLET_UPDATE_ALL': {
                    if (!isAdmin) { await this._send(bot, chatId, msg, personality.getErrorMessage('NOT_AUTHORIZED')); return; }
                    const allPlayers = walletService.getAllWallets();
                    if (allPlayers.length === 0) {
                        await this._send(bot, chatId, msg, 'Aucune fiche enregistrée.');
                        return;
                    }
                    await this._send(bot, chatId, msg, response);
                    // Envoyer toutes les fiches une par une
                    for (const player of allPlayers) {
                        await bot.sendMessage(chatId, walletService.formatWallet(player), { parse_mode: 'Markdown' });
                        await new Promise(res => setTimeout(res, 500)); // éviter le flood
                    }
                    break;
                }

                default:
                    await this._send(bot, chatId, msg, response);
            }

        } catch (err) {
            logger.error('[HANDLER] Erreur:', err.message);
        }
    }

    // ── Vidéo reçue ───────────────────────────────────────────
    async _handleReceivedVideo(bot, msg, chatId, userId, userName) {
        try {
            const fileId = msg.video?.file_id || msg.document?.file_id;
            const sizeMB = ((msg.video?.file_size || msg.document?.file_size || 0) / (1024 * 1024)).toFixed(1);
            const reply  = await gemini.quickReply(
                `${userName} t'envoie une vidéo (${sizeMB} MB). Demande ce qu'il veut : garder en vidéo ou extraire l'audio MP3.`
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
        } catch (err) { logger.error('[HANDLER] _handleReceivedVideo:', err.message); }
    }

    // ── Audio reçu ────────────────────────────────────────────
    async _handleReceivedAudio(bot, msg, chatId) {
        const waiting = await bot.sendMessage(chatId, '⏳ Traitement...', { reply_to_message_id: msg.message_id });
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
            await bot.sendAudio(chatId, outPath, { caption: `🎵 ${title}${performer ? ' — ' + performer : ''}\n_${sizeMB} MB_`, parse_mode: 'Markdown', title, performer, reply_to_message_id: msg.message_id });
            downloadService.cleanup(outPath);
        } catch (err) {
            logger.error('[HANDLER] _handleReceivedAudio:', err.message);
            await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
        }
    }

    // ── Callbacks inline ──────────────────────────────────────
    async handleCallback(bot, query) {
        const chatId = query.message?.chat?.id;
        const data   = query.data || '';
        await bot.answerCallbackQuery(query.id);

        if (data.startsWith('keep_video:') || data.startsWith('to_audio:')) {
            const isVideo = data.startsWith('keep_video:');
            const fileId  = data.replace(isVideo ? 'keep_video:' : 'to_audio:', '');
            const waiting = await bot.sendMessage(chatId, isVideo ? '⏳ Téléchargement...' : '🔄 Conversion en MP3...');
            try {
                const fileLink = await bot.getFileLink(fileId);
                const ext      = isVideo ? 'mp4' : 'mp4';
                const tmpPath  = path.join(TMP_DIR, `miyabi_cb_${Date.now()}.${ext}`);
                const response = await axios({ url: fileLink, responseType: 'stream', timeout: 120000 });
                const writer   = fs.createWriteStream(tmpPath);
                response.data.pipe(writer);
                await new Promise((res, rej) => { writer.on('finish', res); writer.on('error', rej); });
                await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});

                if (isVideo) {
                    await bot.sendVideo(chatId, tmpPath, { caption: '🎬 Voilà.', supports_streaming: true });
                    downloadService.cleanup(tmpPath);
                } else {
                    const result = await downloadService.convertToAudio(tmpPath);
                    downloadService.cleanup(tmpPath);
                    if (!result.success) { await bot.sendMessage(chatId, personality.getErrorMessage('DOWNLOAD_FAILED')); return; }
                    await bot.sendAudio(chatId, result.path, { caption: '🎵 Conversion terminée.' });
                    downloadService.cleanup(result.path);
                }
            } catch (err) {
                logger.error('[CALLBACK]:', err.message);
                await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
            }
        }
    }

    // ── Téléchargement ────────────────────────────────────────
    async _downloadAndSend(bot, chatId, urlOrQuery, type) {
        const waiting = await bot.sendMessage(chatId, `⏳ ${type === 'audio' ? 'Extraction audio' : 'Téléchargement'}...`);
        try {
            const result = type === 'audio'
                ? await downloadService.downloadAudio(urlOrQuery)
                : await downloadService.downloadVideo(urlOrQuery);
            await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
            if (!result.success) {
                await bot.sendMessage(chatId, result.error === 'FILE_TOO_LARGE' ? `Trop lourd (${result.sizeMB} MB). Max 50 MB.` : personality.getErrorMessage('DOWNLOAD_FAILED'));
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
            logger.error('[HANDLER] _downloadAndSend:', err.message);
            await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
        }
    }

    // ── Recherche ─────────────────────────────────────────────
    async _doSearch(bot, chatId, query) {
        try {
            const result = await searchService.search(query);
            if (!result.success) return;
            const text = `🔍 *${result.title}*\n\n${result.text}` + (result.url ? `\n\n[Source](${result.url})` : '');
            await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', disable_web_page_preview: false });
        } catch (err) { logger.error('[HANDLER] _doSearch:', err.message); }
    }

    // ── Envoyer + sticker ─────────────────────────────────────
    async _send(bot, chatId, msg, text, markdown = false) {
        try {
            const opts = { reply_to_message_id: msg.message_id };
            if (markdown) opts.parse_mode = 'Markdown';
            await bot.sendMessage(chatId, text, opts);
            if (Math.random() < 0.30) {
                const sticker = getStickerForMood(personality.getCurrentMood().name);
                if (sticker) await bot.sendSticker(chatId, sticker);
            }
        } catch (err) { logger.error('[HANDLER] _send:', err.message); }
    }

    _extractUrl(text) {
        const match = text.match(URL_REGEX);
        return match ? match[0] : null;
    }
}

module.exports = new MessageHandler();
