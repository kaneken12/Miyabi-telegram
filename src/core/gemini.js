// ============================================================
//  src/core/gemini.js — Miyabi Telegram v2
//  Deux appels séparés : détection d'intention + réponse
// ============================================================

const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger      = require('../utils/logger');
const personality = require('./personality');

// ── Prompt de détection d'intention (appel 1) ────────────────
const INTENT_DETECTION_PROMPT = `Tu es un classificateur d'intentions. Analyse le message et retourne UNIQUEMENT un objet JSON valide sur une seule ligne. Aucun texte avant ou après. Aucun backtick. Aucune explication.

Format : {"intent":"ACTION","data":"valeur"}

Actions :
- DOWNLOAD_AUDIO : télécharger une musique/audio. data = "artiste titre" ex: "Sleep Token Damocles"
- DOWNLOAD_VIDEO : télécharger une vidéo. data = URL ou description courte en anglais
- CONVERT_TO_AUDIO : convertir une vidéo en audio. data = "convert"
- WEB_SEARCH : recherche sur internet. data = la requête de recherche
- GROUP_LOCK : verrouiller le groupe. data = "lock"
- GROUP_UNLOCK : déverrouiller le groupe. data = "unlock"
- GROUP_INFO : infos du groupe. data = "info"
- RESET_CHAT : réinitialiser la conversation. data = "reset"
- NONE : aucune action spécifique. data = ""

Exemples :
"envoie moi Careless de Neffex" → {"intent":"DOWNLOAD_AUDIO","data":"Neffex Careless"}
"je veux regarder le clip de Blinding Lights" → {"intent":"DOWNLOAD_VIDEO","data":"The Weeknd Blinding Lights official video"}
"cherche les news d'aujourd'hui" → {"intent":"WEB_SEARCH","data":"latest news today"}
"verrouille le groupe" → {"intent":"GROUP_LOCK","data":"lock"}
"bonjour comment tu vas" → {"intent":"NONE","data":""}
"c'est quoi la capitale de la France" → {"intent":"NONE","data":""}`;

class GeminiService {
    constructor() {
        this.genAI     = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        this.model     = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        this.histories = new Map();
        this.userNames = new Map();
    }

    setUserName(userId, name) { this.userNames.set(userId, name); }
    getUserName(userId)       { return this.userNames.get(userId) || null; }
    isMother(userId)          { return String(userId) === String(process.env.MOTHER_ID); }

    // ── Appel 1 : Détecter l'intention ───────────────────────
    async detectIntent(userText) {
        try {
            const res = await this.model.generateContent({
                contents: [{ role: 'user', parts: [{ text: `${INTENT_DETECTION_PROMPT}\n\nMessage: ${userText}` }] }],
                generationConfig: { maxOutputTokens: 100, temperature: 0.1 }
            });
            const raw = res.response.text().trim()
                .replace(/```json/g, '')
                .replace(/```/g, '')
                .trim();

            const parsed = JSON.parse(raw);
            if (parsed.intent) return parsed;
            return { intent: 'NONE', data: '' };
        } catch (err) {
            logger.warn('[GEMINI] detectIntent erreur:', err.message);
            return { intent: 'NONE', data: '' };
        }
    }

    // ── Appel 2 : Générer la réponse de Miyabi ───────────────
    async chat(userId, userText, userName) {
        try {
            if (userName && !this.userNames.has(userId))
                this.userNames.set(userId, userName);

            if (!this.histories.has(userId)) this.histories.set(userId, []);
            const history = this.histories.get(userId);

            const chat = this.model.startChat({
                history,
                generationConfig: {
                    maxOutputTokens: 500,
                    temperature:     1.3,
                    topK:            50,
                    topP:            0.92,
                }
            });

            const prompt = `${personality.getSystemPrompt()}\n\nUtilisateur (${userName || 'Inconnu'}): ${userText}`;
            const res    = await chat.sendMessage(prompt);
            const response = res.response.text().trim();

            history.push({ role: 'user',  parts: [{ text: userText }] });
            history.push({ role: 'model', parts: [{ text: response }] });
            if (history.length > 40) history.splice(0, 2);

            return response;
        } catch (err) {
            logger.error('[GEMINI] chat erreur:', err.message);
            return personality.getErrorMessage('UNKNOWN');
        }
    }

    // ── Réponse rapide sans historique ───────────────────────
    async quickReply(prompt) {
        try {
            const res = await this.model.generateContent(
                `${personality.getSystemPrompt()}\n\n${prompt}`
            );
            return res.response.text().trim();
        } catch (err) {
            logger.error('[GEMINI] quickReply erreur:', err.message);
            return personality.getErrorMessage('UNKNOWN');
        }
    }

    clearHistory(userId) { this.histories.delete(userId); }
}

module.exports = new GeminiService();
