// ============================================================
//  src/core/gemini.js — Miyabi Telegram v2
//  Rotation automatique de 5 clés API Gemini
//  Mémoire persistante JSON
// ============================================================

const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger      = require('../utils/logger');
const personality = require('./personality');
const memory      = require('../utils/memory');

const INTENT_PROMPT = `
INSTRUCTIONS STRICTES :
Si le message contient une demande d'action, réponds UNIQUEMENT avec ce JSON sur une ligne :
{"intent":"ACTION","data":"valeur","response":"ta réponse naturelle"}

Si c'est une conversation normale, réponds UNIQUEMENT avec du texte normal, sans JSON.

Actions reconnues :
- DOWNLOAD_AUDIO : musique/audio demandé. data = "artiste titre"
- DOWNLOAD_VIDEO : vidéo demandée. data = URL ou "description en anglais"
- CONVERT_TO_AUDIO : convertir vidéo en audio. data = "convert"
- WEB_SEARCH : recherche internet. data = "requête"
- GROUP_LOCK : verrouiller groupe. data = "lock"
- GROUP_UNLOCK : déverrouiller groupe. data = "unlock"
- GROUP_INFO : infos du groupe. data = "info"
- RESET_CHAT : réinitialiser conversation. data = "reset"

Exemples :
Message: "envoie Careless de Neffex"
Réponse: {"intent":"DOWNLOAD_AUDIO","data":"Neffex Careless","response":"*soupir* Tiens."}

Message: "bonjour comment tu vas"
Réponse: Bien. Qu'est-ce que tu veux ?

RAPPEL : JSON = action. Texte pur = conversation. Jamais les deux mélangés.
`;

// ── Gestionnaire de clés API avec rotation ───────────────────
class KeyManager {
    constructor() {
        // Charger toutes les clés depuis .env
        // GEMINI_API_KEY_1, GEMINI_API_KEY_2, ... GEMINI_API_KEY_5
        // Si une seule clé : GEMINI_API_KEY
        this.keys = this._loadKeys();
        this.current = 0;
        // Cooldown par clé : timestamp où elle sera à nouveau disponible
        this.cooldowns = new Array(this.keys.length).fill(0);

        logger.info(`[GEMINI] ${this.keys.length} clé(s) API chargée(s)`);
    }

    _loadKeys() {
        const keys = [];

        // Essayer les clés numérotées d'abord
        for (let i = 1; i <= 5; i++) {
            const key = process.env[`GEMINI_API_KEY_${i}`];
            if (key && key.trim()) keys.push(key.trim());
        }

        // Fallback sur la clé principale
        if (keys.length === 0 && process.env.GEMINI_API_KEY) {
            keys.push(process.env.GEMINI_API_KEY.trim());
        }

        if (keys.length === 0) {
            logger.error('[GEMINI] Aucune clé API trouvée !');
            process.exit(1);
        }

        return keys;
    }

    // Obtenir la prochaine clé disponible
    getKey() {
        const now = Date.now();

        // Chercher une clé dont le cooldown est terminé
        for (let i = 0; i < this.keys.length; i++) {
            const idx = (this.current + i) % this.keys.length;
            if (this.cooldowns[idx] <= now) {
                this.current = idx;
                return { key: this.keys[idx], idx };
            }
        }

        // Toutes les clés sont en cooldown — prendre celle qui se libère le plus tôt
        let minCooldown = Infinity;
        let minIdx = 0;
        for (let i = 0; i < this.cooldowns.length; i++) {
            if (this.cooldowns[i] < minCooldown) {
                minCooldown = this.cooldowns[i];
                minIdx = i;
            }
        }

        const waitMs = minCooldown - now;
        logger.warn(`[GEMINI] Toutes les clés en cooldown. Attente ${(waitMs/1000).toFixed(1)}s`);
        return { key: this.keys[minIdx], idx: minIdx, waitMs };
    }

    // Mettre une clé en cooldown après erreur 429
    setCooldown(idx, durationMs = 65000) {
        this.cooldowns[idx] = Date.now() + durationMs;
        // Passer à la clé suivante
        this.current = (idx + 1) % this.keys.length;
        logger.warn(`[GEMINI] Clé ${idx + 1} en cooldown 65s — passage à la clé ${this.current + 1}`);
    }

    getStatus() {
        const now = Date.now();
        return this.keys.map((_, i) => ({
            key:       i + 1,
            available: this.cooldowns[i] <= now,
            cooldownMs: Math.max(0, this.cooldowns[i] - now),
        }));
    }
}

class GeminiService {
    constructor() {
        this.keyManager = new KeyManager();
        this._buildModel();
    }

    _buildModel() {
        const { key } = this.keyManager.getKey();
        this.genAI = new GoogleGenerativeAI(key);
        this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    }

    isMother(userId) { return String(userId) === String(process.env.MOTHER_ID); }
    getUserName(userId) { return memory.getUserName(userId); }
    setUserName(userId, name) { memory.setUser(userId, { name }); }

    // ── Appel Gemini avec retry sur quota épuisé ─────────────
    async _callWithRotation(fn, retries = 0) {
        const { key, idx, waitMs } = this.keyManager.getKey();

        // Si toutes les clés sont en cooldown, attendre la moins restrictive
        if (waitMs && retries === 0) {
            await new Promise(res => setTimeout(res, Math.min(waitMs, 5000)));
        }

        // Reconstruire le modèle avec la clé actuelle
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash',
        });

        try {
            return await fn(model);
        } catch (err) {
            const is429 = err.message?.includes('429') || err.message?.includes('quota');
            if (is429 && retries < this.keyManager.keys.length) {
                // Mettre la clé en cooldown et réessayer avec une autre
                this.keyManager.setCooldown(idx);
                logger.warn(`[GEMINI] Quota épuisé clé ${idx + 1}, rotation... (retry ${retries + 1})`);
                return this._callWithRotation(fn, retries + 1);
            }
            throw err;
        }
    }

    // ── Chat principal avec mémoire persistante ───────────────
    async chat(userId, userText, userName) {
        try {
            if (userName) memory.setUser(userId, { name: userName });
            const history = memory.getHistory(userId);

            const result = await this._callWithRotation(async (model) => {
                const chat = model.startChat({
                    history,
                    generationConfig: {
                        maxOutputTokens: 1024,
                        temperature:     1.3,
                        topK:            50,
                        topP:            0.92,
                    }
                });
                const prompt = `${personality.getSystemPrompt()}\n${INTENT_PROMPT}\n\nUtilisateur (${userName || 'Inconnu'}): ${userText}`;
                return await chat.sendMessage(prompt);
            });

            const raw = result.response.text().trim();

            memory.addToHistory(userId, 'user',  userText);
            memory.addToHistory(userId, 'model', raw);

            return this._parse(raw);

        } catch (err) {
            logger.error('[GEMINI] chat erreur finale:', err.message);
            return { intent: null, data: null, response: personality.getErrorMessage('UNKNOWN') };
        }
    }

    // ── Réponse rapide sans historique ───────────────────────
    async quickReply(prompt) {
        try {
            const result = await this._callWithRotation(async (model) => {
                return await model.generateContent(
                    `${personality.getSystemPrompt()}\n\n${prompt}`
                );
            });
            return result.response.text().trim();
        } catch (err) {
            logger.error('[GEMINI] quickReply erreur:', err.message);
            return personality.getErrorMessage('UNKNOWN');
        }
    }

    // ── Parser robuste ───────────────────────────────────────
    _parse(raw) {
        const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();

        const start = cleaned.indexOf('{"intent"');
        if (start !== -1) {
            let depth = 0, end = -1;
            for (let i = start; i < cleaned.length; i++) {
                if (cleaned[i] === '{') depth++;
                if (cleaned[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
            }
            if (end > start) {
                try {
                    const parsed = JSON.parse(cleaned.slice(start, end));
                    if (parsed.intent && parsed.response)
                        return { intent: parsed.intent, data: parsed.data || null, response: parsed.response };
                } catch (_) {}
            }
        }

        try {
            const parsed = JSON.parse(cleaned);
            if (parsed.intent && parsed.response)
                return { intent: parsed.intent, data: parsed.data || null, response: parsed.response };
        } catch (_) {}

        return { intent: null, data: null, response: raw };
    }

    clearHistory(userId) { memory.clearHistory(userId); }

    // ── Statut des clés (pour debug) ─────────────────────────
    getKeyStatus() { return this.keyManager.getStatus(); }
}

module.exports = new GeminiService();