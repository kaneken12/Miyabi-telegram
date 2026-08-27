// ============================================================
//  src/core/gemini.js — Miyabi Telegram v2
//  Rotation automatique 5 clés + wallet RP
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

Actions MEDIA :
- DOWNLOAD_AUDIO : musique/audio. data = "artiste titre" ou URL
- DOWNLOAD_VIDEO : video. data = URL ou description anglais
- CONVERT_TO_AUDIO : convertir video en audio. data = "convert"
- WEB_SEARCH : recherche internet. data = "requête"

Actions GROUPE :
- GROUP_LOCK : verrouiller groupe. data = "lock"
- GROUP_UNLOCK : deverrouiller groupe. data = "unlock"
- GROUP_INFO : infos groupe. data = "info"
- RESET_CHAT : reinitialiser conversation. data = "reset"

Actions WALLET (fiches joueurs RP Lower Tower) :
- WALLET_CREATE : creer fiche. data = JSON {"nom":"X","pseudo":"Y","classe":"Z","gems":0,"abyssCoins":0}
- WALLET_ADD_GEMS : ajouter gems. data = JSON {"target":"pseudo","amount":50}
- WALLET_REMOVE_GEMS : retirer gems. data = JSON {"target":"pseudo","amount":50}
- WALLET_ADD_AC : ajouter abyss coins. data = JSON {"target":"pseudo","amount":50}
- WALLET_REMOVE_AC : retirer abyss coins. data = JSON {"target":"pseudo","amount":50}
- WALLET_SHOW : afficher fiche. data = "pseudo ou nom"
- WALLET_DELETE : supprimer fiche. data = "pseudo ou nom"
- WALLET_UPDATE_ALL : envoyer toutes les fiches. data = "all"

Exemples wallet :
"Cree une fiche pour Raizen pseudo ChronoVolt classe Silent 0 gems 0 AC"
-> {"intent":"WALLET_CREATE","data":"{\"nom\":\"Raizen\",\"pseudo\":\"ChronoVolt\",\"classe\":\"Silent\",\"gems\":0,\"abyssCoins\":0}","response":"*pose le stylo* Fiche créée, ChronoVolt est dans le système."}

"Ajoute 50 gems a ChronoVolt"
-> {"intent":"WALLET_ADD_GEMS","data":"{\"target\":\"ChronoVolt\",\"amount\":50}","response":"50 gems ajoutés. Mis à jour."}

"Retire 10 abyss coins a Raizen"
-> {"intent":"WALLET_REMOVE_AC","data":"{\"target\":\"Raizen\",\"amount\":10}","response":"10 AC retirés de la fiche de Raizen."}

"Montre la fiche de Raizen"
-> {"intent":"WALLET_SHOW","data":"Raizen","response":"Voilà la fiche."}

"Supprime la fiche de ChronoVolt"
-> {"intent":"WALLET_DELETE","data":"ChronoVolt","response":"Fiche supprimée."}

"Mise a jour generale" ou "envoie toutes les fiches"
-> {"intent":"WALLET_UPDATE_ALL","data":"all","response":"*soupir* Envoi de toutes les fiches."}

Exemples media :
"envoie Careless de Neffex"
-> {"intent":"DOWNLOAD_AUDIO","data":"Neffex Careless","response":"*soupir* Tiens."}

Conversation normale :
"bonjour" -> Bonjour. Qu'est-ce que tu veux ?

RAPPEL ABSOLU : JSON valide sur UNE LIGNE = action. Texte pur = conversation. JAMAIS les deux mélangés.
`;

class KeyManager {
    constructor() {
        this.keys = this._loadKeys();
        this.current = 0;
        this.cooldowns = new Array(this.keys.length).fill(0);
        logger.info(`[GEMINI] ${this.keys.length} clé(s) API chargée(s)`);
    }

    _loadKeys() {
        const keys = [];
        for (let i = 1; i <= 5; i++) {
            const key = process.env[`GEMINI_API_KEY_${i}`];
            if (key && key.trim()) keys.push(key.trim());
        }
        if (keys.length === 0 && process.env.GEMINI_API_KEY) {
            keys.push(process.env.GEMINI_API_KEY.trim());
        }
        if (keys.length === 0) { logger.error('[GEMINI] Aucune clé API!'); process.exit(1); }
        return keys;
    }

    getKey() {
        const now = Date.now();
        for (let i = 0; i < this.keys.length; i++) {
            const idx = (this.current + i) % this.keys.length;
            if (this.cooldowns[idx] <= now) { this.current = idx; return { key: this.keys[idx], idx }; }
        }
        let min = Infinity, minIdx = 0;
        for (let i = 0; i < this.cooldowns.length; i++) {
            if (this.cooldowns[i] < min) { min = this.cooldowns[i]; minIdx = i; }
        }
        return { key: this.keys[minIdx], idx: minIdx, waitMs: min - now };
    }

    setCooldown(idx, ms = 65000) {
        this.cooldowns[idx] = Date.now() + ms;
        this.current = (idx + 1) % this.keys.length;
        logger.warn(`[GEMINI] Clé ${idx + 1} cooldown 65s → clé ${this.current + 1}`);
    }
}

class GeminiService {
    constructor() {
        this.keyManager = new KeyManager();
    }

    isMother(userId)          { return String(userId) === String(process.env.MOTHER_ID); }
    getUserName(userId)        { return memory.getUserName(userId); }
    setUserName(userId, name)  { memory.setUser(userId, { name }); }

    async _call(fn, retries = 0) {
        const { key, idx, waitMs } = this.keyManager.getKey();
        if (waitMs && retries === 0) await new Promise(r => setTimeout(r, Math.min(waitMs, 5000)));
        const model = new GoogleGenerativeAI(key).getGenerativeModel({ model: 'gemini-2.5-flash' });
        try {
            return await fn(model);
        } catch (err) {
            const is429 = err.message?.includes('429') || err.message?.includes('quota');
            if (is429 && retries < this.keyManager.keys.length) {
                this.keyManager.setCooldown(idx);
                return this._call(fn, retries + 1);
            }
            throw err;
        }
    }

    async chat(userId, userText, userName) {
        try {
            if (userName) memory.setUser(userId, { name: userName });
            const history = memory.getHistory(userId);

            const result = await this._call(async (model) => {
                const chat = model.startChat({
                    history,
                    generationConfig: { maxOutputTokens: 1024, temperature: 1.3, topK: 50, topP: 0.92 }
                });
                const prompt = `${personality.getSystemPrompt()}\n${INTENT_PROMPT}\n\nUtilisateur (${userName || 'Inconnu'}): ${userText}`;
                return await chat.sendMessage(prompt);
            });

            const raw = result.response.text().trim();
            memory.addToHistory(userId, 'user', userText);
            memory.addToHistory(userId, 'model', raw);
            return this._parse(raw);

        } catch (err) {
            logger.error('[GEMINI] chat erreur:', err.message);
            return { intent: null, data: null, response: personality.getErrorMessage('UNKNOWN') };
        }
    }

    async quickReply(prompt) {
        try {
            const result = await this._call(async (model) =>
                await model.generateContent(`${personality.getSystemPrompt()}\n\n${prompt}`)
            );
            return result.response.text().trim();
        } catch (err) {
            logger.error('[GEMINI] quickReply erreur:', err.message);
            return personality.getErrorMessage('UNKNOWN');
        }
    }

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
                    const p = JSON.parse(cleaned.slice(start, end));
                    if (p.intent && p.response) return { intent: p.intent, data: p.data || null, response: p.response };
                } catch (_) {}
            }
        }
        try {
            const p = JSON.parse(cleaned);
            if (p.intent && p.response) return { intent: p.intent, data: p.data || null, response: p.response };
        } catch (_) {}
        return { intent: null, data: null, response: raw };
    }

    clearHistory(userId) { memory.clearHistory(userId); }
}

module.exports = new GeminiService();
