// ============================================================
//  src/services/groupService.js — Miyabi Telegram
//  Protection anti-purge, quarantaine, surveillance admins
// ============================================================

const logger = require('../utils/logger');

// ── État interne ─────────────────────────────────────────────
const removalTracker = new Map(); // chatId -> [timestamps]
const quarantine     = new Map(); // chatId -> Map<userId, timestamp>

const PURGE_THRESHOLD  = 5;
const PURGE_WINDOW_MS  = 30000;
const QUARANTINE_MS    = 5 * 60 * 1000;

class GroupService {

    // ══════════════════════════════════════════════
    //  Surveillance — appelé depuis bot.js
    //  sur l'event new_chat_members / left_chat_member
    // ══════════════════════════════════════════════

    // ── Nouveau membre ───────────────────────────
    async handleNewMembers(bot, msg) {
        const chatId  = msg.chat.id;
        const members = msg.new_chat_members;
        if (!members?.length) return;

        for (const member of members) {
            // Ignorer les bots
            if (member.is_bot) continue;

            const userId   = member.id;
            const name     = member.first_name || `User${userId}`;

            // Mettre en quarantaine
            if (!quarantine.has(chatId)) quarantine.set(chatId, new Map());
            quarantine.get(chatId).set(userId, Date.now());

            logger.info(`[GUARD] 🔒 Quarantaine : ${name} (${userId}) dans ${chatId}`);

            try {
                await bot.sendMessage(chatId,
                    `👤 *${this._escape(name)}* a rejoint le groupe\\.\n_\\.\\.\\. Tu pourras écrire dans 5 minutes\\. Patience\\._`,
                    { parse_mode: 'MarkdownV2' }
                );
            } catch (e) {
                logger.warn('[GUARD] Erreur message quarantaine:', e.message);
            }

            // Lever la quarantaine après 5 min
            setTimeout(() => {
                const q = quarantine.get(chatId);
                if (q) {
                    q.delete(userId);
                    logger.info(`[GUARD] ✅ Quarantaine levée : ${name}`);
                }
            }, QUARANTINE_MS);
        }
    }

    // ── Membre parti / expulsé ───────────────────
    async handleMemberLeft(bot, msg, ownerChatId) {
        const chatId = msg.chat.id;
        const member = msg.left_chat_member;
        if (!member || member.is_bot) return;

        const now   = Date.now();
        if (!removalTracker.has(chatId)) removalTracker.set(chatId, []);
        const times = removalTracker.get(chatId);
        times.push(now);

        const recent = times.filter(t => now - t < PURGE_WINDOW_MS);
        removalTracker.set(chatId, recent);

        logger.warn(`[GUARD] ⚠️ ${recent.length} départ(s) en 30s dans ${chatId}`);

        if (recent.length >= PURGE_THRESHOLD) {
            logger.warn(`[GUARD] 🚨 PURGE DÉTECTÉE dans ${chatId} !`);
            removalTracker.set(chatId, []);

            if (ownerChatId) {
                try {
                    await bot.sendMessage(ownerChatId,
                        `🚨 *\\[MIYABI GUARD — URGENCE\\]*\n\n*PURGE DÉTECTÉE \\!*\n${recent.length} membres ont quitté/été expulsés en moins de 30 secondes dans un groupe\\.\n\nVérifie tes admins et verrouille si nécessaire\\.\n👉 Tape */lock* dans le groupe concerné\\.`,
                        { parse_mode: 'MarkdownV2' }
                    );
                } catch (e) {
                    logger.error('[GUARD] Alerte owner échouée:', e.message);
                }
            }
        }
    }

    // ── Vérifier si un utilisateur est en quarantaine ────────
    isInQuarantine(chatId, userId) {
        const q = quarantine.get(chatId);
        if (!q) return false;
        return q.has(userId);
    }

    // ── Verrouiller un groupe (seuls les admins écrivent) ────
    async lockGroup(bot, chatId) {
        try {
            await bot.setChatPermissions(chatId, {
                can_send_messages:        false,
                can_send_media_messages:  false,
                can_send_polls:           false,
                can_send_other_messages:  false,
                can_add_web_page_previews:false,
            });
            return { success: true };
        } catch (e) {
            logger.error('[GUARD] lockGroup erreur:', e.message);
            return { success: false, error: e.message };
        }
    }

    // ── Déverrouiller un groupe ──────────────────────────────
    async unlockGroup(bot, chatId) {
        try {
            await bot.setChatPermissions(chatId, {
                can_send_messages:         true,
                can_send_media_messages:   true,
                can_send_polls:            true,
                can_send_other_messages:   true,
                can_add_web_page_previews: true,
            });
            return { success: true };
        } catch (e) {
            logger.error('[GUARD] unlockGroup erreur:', e.message);
            return { success: false, error: e.message };
        }
    }

    // ── Infos du groupe ──────────────────────────────────────
    async getGroupInfo(bot, chatId) {
        try {
            const chat    = await bot.getChat(chatId);
            const count   = await bot.getChatMembersCount(chatId);
            const admins  = await bot.getChatAdministrators(chatId);
            const inQ     = quarantine.get(chatId)?.size || 0;

            return {
                success: true,
                title:   chat.title || 'Groupe',
                members: count,
                admins:  admins.length,
                inQ,
            };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // ── Vérifier si le bot est admin ─────────────────────────
    async isBotAdmin(bot, chatId) {
        try {
            const me     = await bot.getMe();
            const member = await bot.getChatMember(chatId, me.id);
            return ['administrator', 'creator'].includes(member.status);
        } catch {
            return false;
        }
    }

    // ── Vérifier si l'utilisateur est admin ──────────────────
    async isUserAdmin(bot, chatId, userId) {
        try {
            const member = await bot.getChatMember(chatId, userId);
            return ['administrator', 'creator'].includes(member.status);
        } catch {
            return false;
        }
    }

    // ── Escape MarkdownV2 ────────────────────────────────────
    _escape(text) {
        return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
    }
}

module.exports = new GroupService();
