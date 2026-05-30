// ============================================================
//  src/services/searchService.js — Recherche web temps réel
// ============================================================

const axios  = require('axios');
const logger = require('../utils/logger');

class SearchService {
    async search(query) {
        try {
            const res = await axios.get('https://api.duckduckgo.com/', {
                params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
                timeout: 8000,
            });
            const data = res.data;

            if (data.AbstractText)
                return { success: true, title: data.Heading || query, text: data.AbstractText, url: data.AbstractURL || '' };

            if (data.Answer)
                return { success: true, title: query, text: data.Answer, url: '' };

            if (data.RelatedTopics?.length > 0) {
                const topics = data.RelatedTopics.filter(t => t.Text).slice(0, 3).map(t => `• ${t.Text}`).join('\n');
                return { success: true, title: query, text: topics, url: data.RelatedTopics[0]?.FirstURL || '' };
            }

            return { success: false, error: 'NO_RESULTS' };

        } catch (err) {
            logger.error('[SEARCH] Erreur:', err.message);
            return { success: false, error: 'SEARCH_FAILED' };
        }
    }
}

module.exports = new SearchService();
