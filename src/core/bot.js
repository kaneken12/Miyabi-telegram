// ============================================================
//  src/core/bot.js — Miyabi Telegram Core v2
//  Reconnexion automatique sur ECONNRESET
// ============================================================

const TelegramBot     = require("node-telegram-bot-api");
const logger          = require("../utils/logger");
const personality     = require("./personality");
const messageHandler  = require("../handlers/messageHandler");
const groupService    = require("../services/groupService");
const downloadService = require("../services/downloadService");

let bot = null;

const MOOD_STICKERS = {
    indifferente: "CAACAgQAAxkBAAIBMGoiS9myezRM_TPQuo1LbLBgjf88AAIqIgACCabgUNEa-TD7l9zZOwQ",
    sarcastique:  "CAACAgQAAxkBAAIBKGoiS8QfYgyJK6k9nFqa2wQCEu48AAIfIQACqxbhUFmPgh_QGVQ8OwQ",
    irritee:      "CAACAgQAAxkBAAIBImoiSP2CfjXs07BTz-LSZbvrB5fZAAL1HgACw-LgUPeuQqdctC91OwQ",
    froide:       "CAACAgQAAxkBAAIBMmoiS-T-PHrGEbG_cSnIw4Kc-Nx7AALiIgACY2ToUJXbTQtpfSIBOwQ",
    detendue:     "CAACAgQAAxkBAAIBKmoiS8zVj9Zb0T1ANzw0vHTWLwbmAAJEHgACCLvgUNIcNk161TvOOwQ",
    contente:     "CAACAgQAAxkBAAIBNGoiS-ntH0kdhG_tcERXX-Z0-lXVAAKbHgACzLnpUE5uM_mo_p-BOwQ",
    tsundere:     "CAACAgQAAxkBAAIBPmoiTTaFAmCaP-nrQO8XabyiXBorAAJhHgAC4doYUb4rTdl16DLQOwQ",
    fatiguee:     "CAACAgQAAxkBAAIBNmoiS--NbsUYcJojw0dpvrSxUCD1AAK9HAAC3IrpUCzhP1U7-X6TOwQ",
};

function normalizeMood(name) {
    return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
}

function getStickerForMood(moodName) {
    return MOOD_STICKERS[normalizeMood(moodName)] || null;
}

async function setupBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) { logger.error("TELEGRAM_BOT_TOKEN manquant"); process.exit(1); }

    // Arrêter l ancien bot si il existe
    if (bot) {
        try { await bot.stopPolling(); } catch (_) {}
        bot = null;
    }

    bot = new TelegramBot(token, {
        polling: {
            interval: 300,
            autoStart: true,
            params: { timeout: 10 }
        }
    });

    const me = await bot.getMe();
    logger.info("Miyabi connectee : @" + me.username);
    logger.info("Humeur : " + personality.getCurrentMood().name);
    logger.info("Protection : ACTIVE");

    const ownerChatId = process.env.OWNER_ID;
    if (ownerChatId) {
        setTimeout(async () => {
            try {
                await bot.sendMessage(ownerChatId, "...En ligne.");
                const sticker = getStickerForMood(personality.getCurrentMood().name);
                if (sticker) await bot.sendSticker(ownerChatId, sticker);
            } catch (_) {}
        }, 2000);
    }

    setInterval(() => downloadService.cleanTmp(), 15 * 60 * 1000);

    bot.on("message", async (msg) => {
        try {
            if (msg.new_chat_members) { await groupService.handleNewMembers(bot, msg); return; }
            if (msg.left_chat_member) { await groupService.handleMemberLeft(bot, msg, ownerChatId); return; }
            await messageHandler.handle(bot, msg);
        } catch (err) { logger.error("[BOT] Erreur:", err.message); }
    });

    bot.on("callback_query", async (query) => {
        try { await messageHandler.handleCallback(bot, query); }
        catch (err) { logger.error("[BOT] callback_query:", err.message); }
    });

    // Reconnexion automatique sur erreur réseau
    bot.on("polling_error", async (err) => {
        logger.error("[BOT] Polling:", err.message);
        const isNetworkError = err.message.includes("ECONNRESET") ||
                               err.message.includes("ENOTFOUND") ||
                               err.message.includes("ETIMEDOUT") ||
                               err.message.includes("ECONNREFUSED");
        if (isNetworkError) {
            logger.warn("[BOT] Erreur réseau — reconnexion dans 10s...");
            setTimeout(async () => {
                try {
                    // Corriger le DNS avant reconnexion
                    const { execSync } = require("child_process");
                    try { execSync("echo nameserver 8.8.8.8 > /data/data/com.termux/files/usr/etc/resolv.conf"); } catch (_) {}
                    await bot.stopPolling();
                    await new Promise(r => setTimeout(r, 2000));
                    await bot.startPolling();
                    logger.info("[BOT] Reconnecte avec succes");
                } catch (e) {
                    logger.error("[BOT] Echec reconnexion:", e.message);
                    // Relancer completement le bot
                    setTimeout(() => setupBot(), 5000);
                }
            }, 10000);
        }
    });

    bot.on("error", (err) => logger.error("[BOT] Erreur:", err.message));

    return bot;
}

function getBot() { return bot; }

module.exports = { setupBot, getBot, getStickerForMood };
