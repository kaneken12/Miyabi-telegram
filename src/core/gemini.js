// ============================================================
//  src/core/gemini.js — Miyabi Telegram v2
//  gemini-2.0-flash — détection d'intention naturelle
// ============================================================

const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger      = require('../utils/logger');
const personality = require('./personality');

const INTENT_PROMPT = `
En plus de répondre normalement, si le message contient une demande d'action spécifique,
retourne ta réponse sous ce format JSON EXACT :

{"intent":"ACTION","data":"valeur","response":"ta réponse naturelle ici"}

Actions disponibles :

- DOWNLOAD_VIDEO : télécharger ou envoyer une vidéo.
  * Depuis un lien URL → data = l'URL complète
  * Depuis une description ("envoie-moi la vidéo de course de voiture", "montre-moi le clip de ...") → data = la requête de recherche en anglais de préférence
  
- DOWNLOAD_AUDIO : télécharger ou envoyer une musique / audio.
  * Depuis un lien URL → data = l'URL complète
  * Depuis une description ("envoie Careless de Neffex", "je veux écouter ...", "mets-moi la chanson ...") → data = "artiste - titre" en anglais de préférence

- CONVERT_TO_AUDIO : convertir une vidéo en audio. data = "convert"

- WEB_SEARCH : recherche sur internet. data = la requête

- GROUP_LOCK : verrouiller le groupe. data = "lock"
- GROUP_UNLOCK : déverrouiller le groupe. data = "unlock"
- GROUP_INFO : infos du groupe. data = "info"
- RESET_CHAT : réinitialiser la conversation. data = "reset"

IMPORTANT : Pour les demandes musicales ou vidéo sans lien, extrais toujours le nom de l'artiste
et le titre ou une description précise dans le champ data.
Exemples :
- "envoie Careless de Neffex" → data = "Neffex Careless"
- "je veux écouter Demons d'Imagine Dragons" → data = "Imagine Dragons Demons"  
- "envoie la vidéo du clip de Blinding Lights" → data = "The Weeknd Blinding Lights official video"
- "montre-moi une vidéo de course de voiture" → data = "car race video"

Si aucune action n'est détectée, réponds normalement en texte sans JSON.
`;

class GeminiService {
    constructor() {
        this.genAI     = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        this.model     = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        this.histories = new Map();
        this.userNames = new Map();
    }

    setUserName(userId, name) { this.userNames.set(userId, name); }
    getUserName(userId)       { return this.userNames.get(userId) || null; }
    isMother(userId)          { return String(userId) === String(process.env.MOTHER_ID); }

    async chat(userId, userText, userName = null) {
        try {
            if (userName && !this.userNames.has(userId))
                this.userNames.set(userId, userName);

            if (!this.histories.has(userId)) this.histories.set(userId, []);
            const history = this.histories.get(userId);

            const chat = this.model.startChat({
                history,
                generationConfig: { maxOutputTokens: 600 }
            });

            const fullPrompt = `${personality.getSystemPrompt()}\n${INTENT_PROMPT}\n\nUtilisateur (${userName || 'Inconnu'}): ${userText}`;
            const res        = await chat.sendMessage(fullPrompt);
            const raw        = res.response.text().trim();

            history.push({ role: 'user',  parts: [{ text: userText }] });
            history.push({ role: 'model', parts: [{ text: raw }] });
            if (history.length > 40) history.splice(0, 2);

            return this._parseResponse(raw);

        } catch (err) {
            logger.error('[GEMINI] Erreur chat:', err.message);
            return { intent: null, response: personality.getErrorMessage('UNKNOWN') };
        }
    }

    async quickReply(prompt) {
        try {
            const res = await this.model.generateContent(
                `${personality.getSystemPrompt()}\n\n${prompt}`
            );
            return res.response.text();
        } catch (err) {
            logger.error('[GEMINI] quickReply erreur:', err.message);
            return personality.getErrorMessage('UNKNOWN');
        }
    }

    _parseResponse(raw) {
        const jsonMatch = raw.match(/\{[\s\S]*"intent"[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.intent && parsed.response) {
                    return { intent: parsed.intent, data: parsed.data || null, response: parsed.response };
                }
            } catch (_) {}
        }
        return { intent: null, response: raw };
    }

    clearHistory(userId) { this.histories.delete(userId); }
}

module.exports = new GeminiService();
