// ============================================================
//  src/core/bot.js — Miyabi Telegram Core v2
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
    if (!token) { logger.error('❌ TELEGRAM_BOT_TOKEN manquant'); process.exit(1); }

    bot = new TelegramBot(token, { polling: true });

    const me = await bot.getMe();
    logger.info(`✅ Miyabi connectée : @${me.username}`);
    logger.info(`🎭 Humeur : ${personality.getCurrentMood().name}`);
    logger.info(`🛡️  Protection : ACTIVE`);

    const ownerChatId = process.env.OWNER_ID;
    if (ownerChatId) {
        setTimeout(async () => {
            try { await bot.sendMessage(ownerChatId, `...En ligne.`); }
            catch (e) { logger.warn('Message owner échoué:', e.message); }
        }, 2000);
    }

    // Nettoyage tmp toutes les 15 min
    setInterval(() => downloadService.cleanTmp(), 15 * 60 * 1000);

    // ── Messages ─────────────────────────────────────────────
    bot.on('message', async (msg) => {
        try {
            if (msg.new_chat_members) {
                await groupService.handleNewMembers(bot, msg);
                return;
            }
            if (msg.left_chat_member) {
                await groupService.handleMemberLeft(bot, msg, ownerChatId);
                return;
            }
            await messageHandler.handle(bot, msg);
        } catch (err) {
            logger.error('[BOT] Erreur message:', err.message);
        }
    });

    // ── Boutons inline (garder vidéo / convertir en audio) ───
    bot.on('callback_query', async (query) => {
        try {
            await messageHandler.handleCallback(bot, query);
        } catch (err) {
            logger.error('[BOT] Erreur callback_query:', err.message);
        }
    });

    bot.on('polling_error', (err) => logger.error('[BOT] Polling erreur:', err.message));
    bot.on('error',         (err) => logger.error('[BOT] Erreur:', err.message));

    return bot;
}

function getBot() { return bot; }
module.exports = { setupBot, getBot };
