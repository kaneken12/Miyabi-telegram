// ============================================================
//  src/handlers/messageHandler.js — Miyabi Telegram
//  Routage des commandes et messages
// ============================================================

const gemini          = require('../core/gemini');
const personality     = require('../core/personality');
const downloadService = require('../services/downloadService');
const searchService   = require('../services/searchService');
const groupService    = require('../services/groupService');
const { inspectMessage } = require('../utils/messageSanitizer');
const logger          = require('../utils/logger');

// Regex de détection de liens téléchargeables
const DL_REGEX = /(https?:\/\/(www\.)?(youtube\.com|youtu\.be|facebook\.com|fb\.watch|pinterest\.com|pin\.it|instagram\.com|tiktok\.com|twitter\.com|x\.com)[^\s]*)/i;

class MessageHandler {

    async handle(bot, msg) {
        try {
            const chatId   = msg.chat.id;
            const userId   = msg.from?.id;
            const text     = msg.text || msg.caption || '';
            const isGroup  = ['group', 'supergroup'].includes(msg.chat.type);
            const isOwner  = String(userId) === String(process.env.OWNER_ID);
            const botInfo  = await bot.getMe();
            const botUsername = `@${botInfo.username}`;

            // ── SANITISATION ──────────────────────────────
            const check = inspectMessage(msg);
            if (check.suspicious) {
                logger.warn(`⚠️  [SANITIZER] Message suspect — chat:${chatId} user:${userId} — ${check.reason}`);
                try {
                    await bot.deleteMessage(chatId, msg.message_id);
                    logger.info(`🗑️  [SANITIZER] Message supprimé.`);
                } catch (e) {
                    logger.warn('[SANITIZER] Suppression impossible:', e.message);
                }
                return;
            }

            // ── QUARANTAINE ───────────────────────────────
            if (isGroup && userId && groupService.isInQuarantine(chatId, userId)) {
                logger.info(`[GUARD] 🔒 Message bloqué (quarantaine) userId:${userId}`);
                try {
                    await bot.deleteMessage(chatId, msg.message_id);
                } catch (e) { /* silencieux */ }
                return;
            }

            if (!text) return;

            // ── En groupe : répondre seulement si mentionné
            //    ou si commande slash
            if (isGroup && !text.startsWith('/') && !text.includes(botUsername)) return;

            // Nettoyer la mention du bot du texte
            const cleanText = text.replace(botUsername, '').trim();

            // ── ROUTAGE DES COMMANDES ─────────────────────
            if (cleanText.startsWith('/')) {
                await this._handleCommand(bot, msg, cleanText, chatId, userId, isGroup, isOwner);
                return;
            }

            // ── DÉTECTION DE LIEN DE TÉLÉCHARGEMENT ──────
            const dlMatch = cleanText.match(DL_REGEX);
            if (dlMatch) {
                await this._handleDownload(bot, msg, dlMatch[0], chatId);
                return;
            }

            // ── RÉPONSE GEMINI ────────────────────────────
            await this._handleChat(bot, msg, cleanText, chatId);

        } catch (err) {
            logger.error('[HANDLER] Erreur:', err.message);
        }
    }

    // ══════════════════════════════════════════════
    //  COMMANDES
    // ══════════════════════════════════════════════
    async _handleCommand(bot, msg, text, chatId, userId, isGroup, isOwner) {
        const args    = text.split(' ');
        const command = args[0].toLowerCase().split('@')[0]; // /cmd@bot → /cmd
        const params  = args.slice(1).join(' ').trim();

        switch (command) {

            // ── Info & aide ───────────────────────────────
            case '/start':
            case '/help':
                await bot.sendMessage(chatId,
                    `*Miyabi Bot*\n\n` +
                    `*Téléchargement*\n` +
                    `\`/dl [lien]\` — Télécharger une vidéo \\(YouTube, Facebook, Pinterest\\)\n` +
                    `\`/mp3 [lien]\` — Télécharger l'audio \\(YouTube\\)\n\n` +
                    `*Recherche*\n` +
                    `\`/search [requête]\` — Recherche web\n\n` +
                    `*Groupe \\(admins\\)*\n` +
                    `\`/lock\` — Verrouiller le groupe\n` +
                    `\`/unlock\` — Déverrouiller le groupe\n` +
                    `\`/info\` — Infos du groupe\n` +
                    `\`/guard\` — Activer la protection\n\n` +
                    `*Conversation*\n` +
                    `\`/reset\` — Réinitialiser la conversation\n` +
                    `Ou mentionne\\-moi simplement dans un groupe\\.`,
                    { parse_mode: 'MarkdownV2' }
                );
                break;

            // ── Téléchargement vidéo ──────────────────────
            case '/dl':
            case '/video': {
                const url = params || this._extractUrl(text);
                if (!url) {
                    await bot.sendMessage(chatId, 'Donne-moi un lien. Usage : `/dl [url]`', { parse_mode: 'Markdown' });
                    return;
                }
                await this._handleDownload(bot, msg, url, chatId, 'video');
                break;
            }

            // ── Téléchargement audio ──────────────────────
            case '/mp3':
            case '/audio': {
                const url = params || this._extractUrl(text);
                if (!url) {
                    await bot.sendMessage(chatId, 'Donne-moi un lien YouTube. Usage : `/mp3 [url]`', { parse_mode: 'Markdown' });
                    return;
                }
                await this._handleDownload(bot, msg, url, chatId, 'audio');
                break;
            }

            // ── Recherche web ─────────────────────────────
            case '/search':
            case '/s': {
                if (!params) {
                    await bot.sendMessage(chatId, 'Quoi chercher ? Usage : `/search [requête]`', { parse_mode: 'Markdown' });
                    return;
                }
                await this._handleSearch(bot, chatId, params);
                break;
            }

            // ── Verrouiller groupe ────────────────────────
            case '/lock': {
                if (!isGroup) { await bot.sendMessage(chatId, 'Commande réservée aux groupes.'); return; }
                const isAdmin = await groupService.isUserAdmin(bot, chatId, userId);
                if (!isAdmin && !isOwner) { await bot.sendMessage(chatId, personality.getErrorMessage('NOT_AUTHORIZED')); return; }
                const result = await groupService.lockGroup(bot, chatId);
                await bot.sendMessage(chatId, result.success
                    ? '🔒 Groupe verrouillé. Seuls les admins peuvent écrire.'
                    : `Echec : ${result.error}`
                );
                break;
            }

            // ── Déverrouiller groupe ──────────────────────
            case '/unlock': {
                if (!isGroup) { await bot.sendMessage(chatId, 'Commande réservée aux groupes.'); return; }
                const isAdmin = await groupService.isUserAdmin(bot, chatId, userId);
                if (!isAdmin && !isOwner) { await bot.sendMessage(chatId, personality.getErrorMessage('NOT_AUTHORIZED')); return; }
                const result = await groupService.unlockGroup(bot, chatId);
                await bot.sendMessage(chatId, result.success
                    ? '🔓 Groupe ouvert. Tout le monde peut écrire.'
                    : `Echec : ${result.error}`
                );
                break;
            }

            // ── Infos groupe ──────────────────────────────
            case '/info': {
                if (!isGroup) { await bot.sendMessage(chatId, 'Commande réservée aux groupes.'); return; }
                const info = await groupService.getGroupInfo(bot, chatId);
                if (!info.success) { await bot.sendMessage(chatId, 'Impossible de récupérer les infos.'); return; }
                await bot.sendMessage(chatId,
                    `📊 *${info.title}*\n` +
                    `👥 Membres : ${info.members}\n` +
                    `🔑 Admins : ${info.admins}\n` +
                    `🔒 En quarantaine : ${info.inQ}`,
                    { parse_mode: 'Markdown' }
                );
                break;
            }

            // ── Activer la protection ─────────────────────
            case '/guard': {
                if (!isGroup) { await bot.sendMessage(chatId, 'Commande réservée aux groupes.'); return; }
                const isAdmin = await groupService.isUserAdmin(bot, chatId, userId);
                if (!isAdmin && !isOwner) { await bot.sendMessage(chatId, personality.getErrorMessage('NOT_AUTHORIZED')); return; }
                await bot.sendMessage(chatId,
                    '🛡️ Protection activée.\nJe surveille les expulsions, les nouveaux membres et les messages suspects.'
                );
                break;
            }

            // ── Reset conversation Gemini ─────────────────
            case '/reset':
                gemini.clearHistory(chatId);
                await bot.sendMessage(chatId, '...Conversation réinitialisée. Comme si on ne s\'était jamais parlé.');
                break;

            // ── Humeur actuelle ───────────────────────────
            case '/mood':
                await bot.sendMessage(chatId, `Humeur actuelle : *${personality.getCurrentEmotion().name}*`, { parse_mode: 'Markdown' });
                break;

            default:
                // Commande inconnue → Gemini
                await this._handleChat(bot, msg, text, chatId);
        }
    }

    // ══════════════════════════════════════════════
    //  TÉLÉCHARGEMENT
    // ══════════════════════════════════════════════
    async _handleDownload(bot, msg, url, chatId, forceType = null) {
        const platform = this._detectPlatform(url);
        const type     = forceType || (platform === 'pinterest' ? 'video' : 'video');

        const waiting = await bot.sendMessage(chatId, `⏳ Téléchargement en cours...`);

        try {
            let result;

            if (type === 'audio') {
                result = await downloadService.downloadAudio(url);
            } else {
                result = await downloadService.downloadVideo(url);
            }

            // Supprimer le message d'attente
            await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});

            if (!result.success) {
                const errorMsg = result.error === 'FILE_TOO_LARGE'
                    ? `Fichier trop lourd (${result.sizeMB} MB). Limite Telegram : 50 MB.`
                    : personality.getErrorMessage('DOWNLOAD_FAILED');
                await bot.sendMessage(chatId, errorMsg);
                return;
            }

            // Envoyer le fichier
            const caption = `📥 *${result.title}*\n_${result.platform} • ${result.sizeMB} MB_`;

            if (type === 'audio') {
                await bot.sendAudio(chatId, result.path, {
                    caption,
                    parse_mode: 'Markdown',
                    title: result.title,
                });
            } else {
                await bot.sendVideo(chatId, result.path, {
                    caption,
                    parse_mode: 'Markdown',
                    supports_streaming: true,
                });
            }

            // Nettoyer le fichier tmp
            const fs = require('fs');
            if (fs.existsSync(result.path)) fs.unlinkSync(result.path);

        } catch (err) {
            logger.error('[HANDLER] _handleDownload erreur:', err.message);
            await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});
            await bot.sendMessage(chatId, personality.getErrorMessage('DOWNLOAD_FAILED'));
        }
    }

    // ══════════════════════════════════════════════
    //  RECHERCHE
    // ══════════════════════════════════════════════
    async _handleSearch(bot, chatId, query) {
        const waiting = await bot.sendMessage(chatId, `🔍 Recherche en cours...`);

        const result = await searchService.search(query);
        await bot.deleteMessage(chatId, waiting.message_id).catch(() => {});

        if (!result.success) {
            await bot.sendMessage(chatId, personality.getErrorMessage('SEARCH_FAILED'));
            return;
        }

        const text = `🔍 *${result.title}*\n\n${result.text}` +
            (result.url ? `\n\n[Source](${result.url})` : '');

        await bot.sendMessage(chatId, text, {
            parse_mode: 'Markdown',
            disable_web_page_preview: false,
        });
    }

    // ══════════════════════════════════════════════
    //  GEMINI CHAT
    // ══════════════════════════════════════════════
    async _handleChat(bot, msg, text, chatId) {
        try {
            await bot.sendChatAction(chatId, 'typing');
            const response = await gemini.chat(chatId, text);
            await bot.sendMessage(chatId, response, {
                reply_to_message_id: msg.message_id,
            });
        } catch (err) {
            logger.error('[HANDLER] _handleChat erreur:', err.message);
            await bot.sendMessage(chatId, personality.getErrorMessage('UNKNOWN'));
        }
    }

    // ── Utils ────────────────────────────────────
    _extractUrl(text) {
        const match = text.match(/https?:\/\/[^\s]+/);
        return match ? match[0] : null;
    }

    _detectPlatform(url) {
        if (/youtube\.com|youtu\.be/i.test(url))   return 'youtube';
        if (/facebook\.com|fb\.watch/i.test(url))  return 'facebook';
        if (/pinterest\.com|pin\.it/i.test(url))   return 'pinterest';
        return 'other';
    }
}

module.exports = new MessageHandler();
