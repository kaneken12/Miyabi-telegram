// ============================================================
//  src/core/bot.js — Miyabi Telegram Core
//  Connexion + Events + Protection anti-purgeurs
// ============================================================

const TelegramBot     = require('node-telegram-bot-api');
const logger          = require('../utils/logger');
const personality     = require('./personality');
const messageHandler  = require('../handlers/messageHandler');
const groupService    = require('../services/groupService');
const downloadService = require('../services/downloadService');

let bot = null;

async function setupBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        logger.error('❌ TELEGRAM_BOT_TOKEN manquant dans .env');
        process.exit(1);
    }

    bot = new TelegramBot(token, { polling: true });

    const me = await bot.getMe();
    logger.info(`✅ Miyabi connectée en tant que @${me.username}`);
    logger.info(`🎭 Humeur actuelle : ${personality.getCurrentEmotion().name}`);
    logger.info(`🛡️  Protection anti-purgeurs : ACTIVE`);

    // ── Message de démarrage à l'owner ───────────────────────
    const ownerChatId = process.env.OWNER_ID;
    if (ownerChatId) {
        setTimeout(async () => {
            try {
                await bot.sendMessage(ownerChatId,
                    `...Je suis en ligne\\. Protection des groupes activée\\.`,
                    { parse_mode: 'MarkdownV2' }
                );
            } catch (e) {
                logger.warn('Message démarrage owner échoué:', e.message);
            }
        }, 2000);
    }

    // ── Nettoyage tmp toutes les 15 minutes ──────────────────
    setInterval(() => downloadService.cleanTmp(), 15 * 60 * 1000);

    // ════════════════════════════════════════
    //  EVENTS
    // ════════════════════════════════════════

    // ── Messages texte + médias ──────────────────────────────
    bot.on('message', async (msg) => {
        try {
            // Nouveaux membres → quarantaine
            if (msg.new_chat_members) {
                await groupService.handleNewMembers(bot, msg);
                return;
            }

            // Membre qui part/est expulsé → détection purge
            if (msg.left_chat_member) {
                await groupService.handleMemberLeft(bot, msg, ownerChatId);
                return;
            }

            // Messages normaux
            await messageHandler.handle(bot, msg);

        } catch (err) {
            logger.error('[BOT] Erreur event message:', err.message);
        }
    });

    // ── Callback queries (boutons inline) ────────────────────
    bot.on('callback_query', async (query) => {
        try {
            const chatId = query.message?.chat?.id;
            const data   = query.data;

            await bot.answerCallbackQuery(query.id);

            if (data === 'dl_video') {
                await bot.sendMessage(chatId, 'Envoie le lien avec `/dl [url]`', { parse_mode: 'Markdown' });
            } else if (data === 'dl_audio') {
                await bot.sendMessage(chatId, 'Envoie le lien avec `/mp3 [url]`', { parse_mode: 'Markdown' });
            }
        } catch (err) {
            logger.error('[BOT] Erreur callback_query:', err.message);
        }
    });

    // ── Erreurs polling ──────────────────────────────────────
    bot.on('polling_error', (err) => {
        logger.error('[BOT] Polling erreur:', err.message);
    });

    bot.on('error', (err) => {
        logger.error('[BOT] Erreur générale:', err.message);
    });

    return bot;
}

function getBot() {
    return bot;
}

module.exports = { setupBot, getBot };
