// ============================================================
//  src/services/searchService.js — Miyabi Telegram
//  Recherche web via DuckDuckGo (sans clé API)
// ============================================================

const axios  = require('axios');
const logger = require('../utils/logger');

class SearchService {
    async search(query) {
        try {
            // DuckDuckGo Instant Answer API — gratuit, sans clé
            const res = await axios.get('https://api.duckduckgo.com/', {
                params: {
                    q:      query,
                    format: 'json',
                    no_html: 1,
                    skip_disambig: 1,
                },
                timeout: 8000,
            });

            const data = res.data;

            // Réponse directe (définition, calcul, etc.)
            if (data.AbstractText) {
                return {
                    success: true,
                    type:    'abstract',
                    title:   data.Heading || query,
                    text:    data.AbstractText,
                    url:     data.AbstractURL || '',
                };
            }

            // Réponse courte (Answer)
            if (data.Answer) {
                return {
                    success: true,
                    type:    'answer',
                    title:   query,
                    text:    data.Answer,
                    url:     '',
                };
            }

            // Résultats liés (RelatedTopics)
            if (data.RelatedTopics?.length > 0) {
                const topics = data.RelatedTopics
                    .filter(t => t.Text)
                    .slice(0, 3)
                    .map(t => `• ${t.Text}`)
                    .join('\n');

                return {
                    success: true,
                    type:    'related',
                    title:   query,
                    text:    topics,
                    url:     data.RelatedTopics[0]?.FirstURL || '',
                };
            }

            return { success: false, error: 'NO_RESULTS' };

        } catch (err) {
            logger.error('[SEARCH] Erreur:', err.message);
            return { success: false, error: 'SEARCH_FAILED' };
        }
    }
}

module.exports = new SearchService();
