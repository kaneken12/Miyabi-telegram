cat > src/core/gemini.js << 'EOF'
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger      = require('../utils/logger');
const personality = require('./personality');

class GeminiService {
    constructor() {
        this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        this.model  = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        this.histories = new Map();
    }

    async chat(chatId, userText) {
        try {
            if (!this.histories.has(chatId)) this.histories.set(chatId, []);
            const history = this.histories.get(chatId);

            const chat = this.model.startChat({
                history,
                generationConfig: { maxOutputTokens: 512 }
            });

            const fullText = `${personality.getSystemPrompt()}\n\nUtilisateur: ${userText}`;
            const res = await chat.sendMessage(fullText);
            const response = res.response.text();

            history.push({ role: 'user',  parts: [{ text: userText }] });
            history.push({ role: 'model', parts: [{ text: response }] });
            if (history.length > 40) history.splice(0, 2);

            return response;
        } catch (err) {
            logger.error('[GEMINI] Erreur:', err.message);
            return personality.getErrorMessage('UNKNOWN');
        }
    }

    async quickReply(prompt) {
        try {
            const res = await this.model.generateContent(prompt);
            return res.response.text();
        } catch (err) {
            logger.error('[GEMINI] quickReply erreur:', err.message);
            return personality.getErrorMessage('UNKNOWN');
        }
    }

    clearHistory(chatId) {
        this.histories.delete(chatId);
    }
}

module.exports = new GeminiService();
EOF