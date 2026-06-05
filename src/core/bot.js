const TelegramBot     = require('node-telegram-bot-api');
const logger          = require('../utils/logger');
const personality     = require('./personality');
const messageHandler  = require('../handlers/messageHandler');
const groupService    = require('../services/groupService');
const downloadService = require('../services/downloadService');

let bot = null;

// ── Stickers par humeur ──────────────────────────────────────
const MOOD_STICKERS = {
    indifferente: 'CAACAgQAAxkBAAIBMGoiS9myezRM_TPQuo1LbLBgjf88AAIqIgACCabgUNEa-TD7l9zZOwQ',
    sarcastique:  'CAACAgQAAxkBAAIBKGoiS8QfYgyJK6k9nFqa2wQCEu48AAIfIQACqxbhUFmPgh_QGVQ8OwQ',
    irritee:      'CAACAgQAAxkBAAIBImoiSP2CfjXs07BTz-LSZbvrB5fZAAL1HgACw-LgUPeuQqdctC91OwQ',
    froide:       'CAACAgQAAxkBAAIBMmoiS-T-PHrGEbG_cSnIw4Kc-Nx7AALiIgACY2ToUJXbTQtpfSIBOwQ',
    detendue:     'CAACAgQAAxkBAAIBKmoiS8zVj9Zb0T1ANzw0vHTWLwbmAAJEHgACCLvgUNIcNk161TvOOwQ',
    contente:     'CAACAgQAAxkBAAIBNGoiS-ntH0kdhG_tcERXX-Z0-lXVAAKbHgACzLnpUE5uM_mo_p-BOwQ',
    tsundere:     'CAACAgQAAxkBAAIBPmoiTTaFAmCaP-nrQO8XabyiXBorAAJhHgAC4doYUb4rTdl16DLQOwQ',
    fatiguee:     'CAACAgQAAxkBAAIBNmoiS--NbsUYcJojw0dpvrSxUCD1AAK9HAAC3IrpUCzhP1U7-X6TOwQ',
};

// Normaliser le nom d'humeur (supprimer accents)
function normalizeMood(name) {
    return name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z]/g, '');
}

function getStickerForMood(moodName) {
    const key = normalizeMood(moodName);
    return MOOD_STICKERS[key] || null;
}

async function setupBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) { logger.error('TELEGRAM_BOT_TOKEN manquant'); process.exit(1); }

    bot = new TelegramBot(token, { polling: true });

    const me = await bot.getMe();
    logger.info(`✅ Miyabi connectée : @${me.username}`);
    logger.info(`🎭 Humeur : ${personality.getCurrentMood().name}`);
    logger.info(`🛡️  Protection : ACTIVE`);

    const ownerChatId = process.env.OWNER_ID;
    if (ownerChatId) {
        setTimeout(async () => {
            try {
                await bot.sendMessage(ownerChatId, '...En ligne.');
                const sticker = getStickerForMood(personality.getCurrentMood().name);
                if (sticker) await bot.sendSticker(ownerChatId, sticker);
            } catch (e) { logger.warn('Message owner échoué:', e.message); }
        }, 2000);
    }

    setInterval(() => downloadService.cleanTmp(), 15 * 60 * 1000);

    bot.on('message', async (msg) => {
        try {
            if (msg.new_chat_members) { await groupService.handleNewMembers(bot, msg); return; }
            if (msg.left_chat_member) { await groupService.handleMemberLeft(bot, msg, ownerChatId); return; }
            await messageHandler.handle(bot, msg);
        } catch (err) { logger.error('[BOT] Erreur:', err.message); }
    });

    bot.on('callback_query', async (query) => {
        try { await messageHandler.handleCallback(bot, query); }
        catch (err) { logger.error('[BOT] callback_query:', err.message); }
    });

    bot.on('polling_error', (err) => logger.error('Polling erreur:', err.message));
    bot.on('error',         (err) => logger.error('Erreur:', err.message));

    return bot;
}

function getBot() { return bot; }

module.exports = { setupBot, getBot, getStickerForMood };
