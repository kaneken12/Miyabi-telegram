// ============================================================
//  src/services/searchService.js
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
            const d = res.data;
            if (d.AbstractText) return { success: true, title: d.Heading || query, text: d.AbstractText, url: d.AbstractURL || '' };
            if (d.Answer) return { success: true, title: query, text: d.Answer, url: '' };
            if (d.RelatedTopics?.length > 0) {
                const topics = d.RelatedTopics.filter(t => t.Text).slice(0, 3).map(t => `• ${t.Text}`).join('\n');
                return { success: true, title: query, text: topics, url: d.RelatedTopics[0]?.FirstURL || '' };
            }
            return { success: false, error: 'NO_RESULTS' };
        } catch (err) {
            logger.error('[SEARCH]:', err.message);
            return { success: false, error: 'SEARCH_FAILED' };
        }
    }
}

module.exports = new SearchService();
