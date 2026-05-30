// ============================================================
//  src/services/groupService.js — Protection anti-purgeurs
// ============================================================

const logger = require('../utils/logger');

const removalTracker = new Map();
const quarantine     = new Map();
const PURGE_THRESHOLD = 5;
const PURGE_WINDOW_MS = 30000;
const QUARANTINE_MS   = 5 * 60 * 1000;

class GroupService {

    async handleNewMembers(bot, msg) {
        const chatId  = msg.chat.id;
        const members = msg.new_chat_members;
        if (!members?.length) return;

        for (const member of members) {
            if (member.is_bot) continue;
            const userId = member.id;
            const name   = member.first_name || `User${userId}`;

            if (!quarantine.has(chatId)) quarantine.set(chatId, new Map());
            quarantine.get(chatId).set(userId, Date.now());
            logger.info(`[GUARD] 🔒 Quarantaine : ${name} dans ${chatId}`);

            setTimeout(() => {
                quarantine.get(chatId)?.delete(userId);
                logger.info(`[GUARD] ✅ Quarantaine levée : ${name}`);
            }, QUARANTINE_MS);
        }
    }

    async handleMemberLeft(bot, msg, ownerChatId) {
        const chatId = msg.chat.id;
        if (!msg.left_chat_member || msg.left_chat_member.is_bot) return;

        const now = Date.now();
        if (!removalTracker.has(chatId)) removalTracker.set(chatId, []);
        const times  = removalTracker.get(chatId);
        times.push(now);
        const recent = times.filter(t => now - t < PURGE_WINDOW_MS);
        removalTracker.set(chatId, recent);

        if (recent.length >= PURGE_THRESHOLD) {
            logger.warn(`[GUARD] 🚨 PURGE DÉTECTÉE dans ${chatId}`);
            removalTracker.set(chatId, []);
            if (ownerChatId) {
                try {
                    await bot.sendMessage(ownerChatId,
                        `🚨 PURGE DÉTECTÉE !\n${recent.length} membres expulsés en 30s.\nVérifie tes admins.`
                    );
                } catch (e) { logger.error('[GUARD] Alerte échouée:', e.message); }
            }
        }
    }

    isInQuarantine(chatId, userId) {
        return quarantine.get(chatId)?.has(userId) || false;
    }

    async lockGroup(bot, chatId) {
        try {
            await bot.setChatPermissions(chatId, {
                can_send_messages: false, can_send_media_messages: false,
                can_send_polls: false, can_send_other_messages: false,
            });
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async unlockGroup(bot, chatId) {
        try {
            await bot.setChatPermissions(chatId, {
                can_send_messages: true, can_send_media_messages: true,
                can_send_polls: true, can_send_other_messages: true,
            });
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async getGroupInfo(bot, chatId) {
        try {
            const chat   = await bot.getChat(chatId);
            const count  = await bot.getChatMembersCount(chatId);
            const admins = await bot.getChatAdministrators(chatId);
            const inQ    = quarantine.get(chatId)?.size || 0;
            return { success: true, title: chat.title || 'Groupe', members: count, admins: admins.length, inQ };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async isUserAdmin(bot, chatId, userId) {
        try {
            const member = await bot.getChatMember(chatId, userId);
            return ['administrator', 'creator'].includes(member.status);
        } catch { return false; }
    }

    async isBotAdmin(bot, chatId) {
        try {
            const me     = await bot.getMe();
            const member = await bot.getChatMember(chatId, me.id);
            return ['administrator', 'creator'].includes(member.status);
        } catch { return false; }
    }
}

module.exports = new GroupService();
