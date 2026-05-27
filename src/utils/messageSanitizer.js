// ============================================================
//  src/utils/messageSanitizer.js — Miyabi Telegram
//  Détecte les messages suspects / crash-exploits
// ============================================================

const DANGEROUS_UNICODE = [
    { pattern: /[\u202E\u202D\u202C\u202B\u202A]/, label: 'RTL/LTR override' },
    { pattern: /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/, label: 'Caractère de contrôle nul' },
    { pattern: /[\uFFF0-\uFFFD]/, label: 'Caractère Unicode spécial' },
    { pattern: /\u200B{3,}/, label: 'Zero-width spaces répétés' },
    { pattern: /\u200F{5,}/, label: 'RTL marks répétés' },
    { pattern: /[\uD800-\uDFFF]/, label: 'Surrogate Unicode isolé' },
];

const LIMITS = {
    maxTextLength:   4096,  // Limite native Telegram
    maxRepeatedChar: 300,
    maxNewlines:     80,
    maxMentions:     15,
    maxMediaSizeMB:  50,
};

function _analyzeText(text) {
    if (!text || typeof text !== 'string') return null;

    if (text.length > LIMITS.maxTextLength)
        return `Texte trop long (${text.length} chars)`;
    if (/(.)\1{300,}/.test(text))
        return 'Répétition excessive d\'un caractère';
    const newlines = (text.match(/\n/g) || []).length;
    if (newlines > LIMITS.maxNewlines)
        return `Trop de sauts de ligne (${newlines})`;
    const mentions = (text.match(/@\w+/g) || []).length;
    if (mentions > LIMITS.maxMentions)
        return `Trop de mentions (${mentions})`;
    for (const { pattern, label } of DANGEROUS_UNICODE)
        if (pattern.test(text)) return `Unicode dangereux : ${label}`;

    return null;
}

function _analyzeMedia(msg) {
    // Fichier/document suspect
    if (msg.document) {
        const doc = msg.document;
        if (doc.file_size && doc.file_size / (1024 * 1024) > LIMITS.maxMediaSizeMB)
            return `Document trop lourd (${(doc.file_size/1024/1024).toFixed(1)} MB)`;
        if (!doc.mime_type)
            return 'Document sans mime_type';
    }
    // Photo
    if (msg.photo) {
        const largest = msg.photo[msg.photo.length - 1];
        if (largest?.file_size && largest.file_size / (1024*1024) > LIMITS.maxMediaSizeMB)
            return `Photo trop lourde (${(largest.file_size/1024/1024).toFixed(1)} MB)`;
    }
    // Vidéo
    if (msg.video) {
        if (msg.video.file_size && msg.video.file_size / (1024*1024) > LIMITS.maxMediaSizeMB)
            return `Vidéo trop lourde (${(msg.video.file_size/1024/1024).toFixed(1)} MB)`;
    }
    // Sticker sans mime_type
    if (msg.sticker && !msg.sticker.mime_type)
        return 'Sticker sans mime_type';

    return null;
}

function inspectMessage(msg) {
    try {
        if (!msg) return { suspicious: false };

        const text = msg.text || msg.caption || '';
        const reason = _analyzeText(text) || _analyzeMedia(msg);

        return reason ? { suspicious: true, reason } : { suspicious: false };
    } catch (err) {
        return { suspicious: true, reason: `Erreur parsing : ${err.message}` };
    }
}

module.exports = { inspectMessage };
