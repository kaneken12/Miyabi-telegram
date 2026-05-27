// ============================================================
//  src/core/gemini.js — Interface Gemini AI
// ============================================================

const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger      = require('../utils/logger');
const personality = require('./personality');

class GeminiService {
    constructor() {
        this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        this.model  = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
        // Historique par chat_id
        this.histories = new Map();
    }

    // ── Réponse principale avec mémoire de conversation ──────
    async chat(chatId, userText) {
        try {
            if (!this.histories.has(chatId)) {
                this.histories.set(chatId, []);
            }
            const history = this.histories.get(chatId);

            const chat = this.model.startChat({
                history,
                systemInstruction: personality.getSystemPrompt(),
                generationConfig: { maxOutputTokens: 512 }
            });

            const result  = await chat.sendMessage(userText);
            const response = result.response.text();

            // Sauvegarder dans l'historique
            history.push({ role: 'user',  parts: [{ text: userText }] });
            history.push({ role: 'model', parts: [{ text: response }] });

            // Limiter l'historique à 20 échanges
            if (history.length > 40) history.splice(0, 2);

            return response;

        } catch (err) {
            logger.error('[GEMINI] Erreur:', err.message);
            return personality.getErrorMessage('UNKNOWN');
        }
    }

    // ── Réponse rapide sans historique ───────────────────────
    async quickReply(prompt) {
        try {
            const result = await this.model.generateContent({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                systemInstruction: personality.getSystemPrompt(),
                generationConfig: { maxOutputTokens: 256 }
            });
            return result.response.text();
        } catch (err) {
            logger.error('[GEMINI] quickReply erreur:', err.message);
            return personality.getErrorMessage('UNKNOWN');
        }
    }

    // ── Réinitialiser l'historique d'un chat ─────────────────
    clearHistory(chatId) {
        this.histories.delete(chatId);
    }
}

module.exports = new GeminiService();
