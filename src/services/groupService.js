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
        const chatId = msg.chat.id;
        if (!msg.new_chat_members?.length) return;
        for (const member of msg.new_chat_members) {
            if (member.is_bot) continue;
            if (!quarantine.has(chatId)) quarantine.set(chatId, new Map());
            quarantine.get(chatId).set(member.id, Date.now());
            setTimeout(() => quarantine.get(chatId)?.delete(member.id), QUARANTINE_MS);
        }
    }

    async handleMemberLeft(bot, msg, ownerChatId) {
        const chatId = msg.chat.id;
        if (!msg.left_chat_member || msg.left_chat_member.is_bot) return;
        const now = Date.now();
        if (!removalTracker.has(chatId)) removalTracker.set(chatId, []);
        const times = removalTracker.get(chatId);
        times.push(now);
        const recent = times.filter(t => now - t < PURGE_WINDOW_MS);
        removalTracker.set(chatId, recent);
        if (recent.length >= PURGE_THRESHOLD) {
            removalTracker.set(chatId, []);
            if (ownerChatId) {
                try { await bot.sendMessage(ownerChatId, `🚨 PURGE DÉTECTÉE ! ${recent.length} membres expulsés en 30s.`); }
                catch (_) {}
            }
        }
    }

    isInQuarantine(chatId, userId) { return quarantine.get(chatId)?.has(userId) || false; }

    async lockGroup(bot, chatId) {
        try {
            await bot.setChatPermissions(chatId, { can_send_messages: false, can_send_media_messages: false, can_send_polls: false, can_send_other_messages: false });
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    }

    async unlockGroup(bot, chatId) {
        try {
            await bot.setChatPermissions(chatId, { can_send_messages: true, can_send_media_messages: true, can_send_polls: true, can_send_other_messages: true });
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    }

    async getGroupInfo(bot, chatId) {
        try {
            const chat   = await bot.getChat(chatId);
            const count  = await bot.getChatMembersCount(chatId);
            const admins = await bot.getChatAdministrators(chatId);
            const inQ    = quarantine.get(chatId)?.size || 0;
            return { success: true, title: chat.title || 'Groupe', members: count, admins: admins.length, inQ };
        } catch (e) { return { success: false, error: e.message }; }
    }

    async isUserAdmin(bot, chatId, userId) {
        try {
            const m = await bot.getChatMember(chatId, userId);
            return ['administrator', 'creator'].includes(m.status);
        } catch { return false; }
    }
}

module.exports = new GroupService();
