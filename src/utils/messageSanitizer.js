// ============================================================
//  src/utils/messageSanitizer.js — Version corrigée
//  Ne bloque plus les stickers ni les emojis normaux
// ============================================================

// Seulement les vrais caractères de contrôle dangereux
// (pas les surrogates qui sont dans les emojis normaux)
const DANGEROUS_PATTERNS = [
    { pattern: /[\u202E\u202D]/,                    label: 'RTL override malveillant' },
    { pattern: /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/, label: 'Caractère de contrôle nul' },
    { pattern: /\u200B{5,}/,                         label: 'Zero-width spaces excessifs' },
];

const LIMITS = {
    maxTextLength:   4096,
    maxRepeatedChar: 500,
    maxNewlines:     100,
    maxMediaSizeMB:  50,
};

function _analyzeText(text) {
    if (!text || typeof text !== 'string') return null;
    if (text.length > LIMITS.maxTextLength)
        return `Texte trop long (${text.length})`;
    if (/(.)\1{500,}/.test(text))
        return 'Répétition excessive d\'un caractère';
    const nl = (text.match(/\n/g) || []).length;
    if (nl > LIMITS.maxNewlines)
        return `Trop de sauts de ligne (${nl})`;
    for (const { pattern, label } of DANGEROUS_PATTERNS)
        if (pattern.test(text)) return label;
    return null;
}

function _analyzeMedia(msg) {
    // Vérifier seulement les documents et vidéos — pas les stickers/audio/photo
    if (msg.document) {
        const doc = msg.document;
        if (doc.file_size && doc.file_size / (1024 * 1024) > LIMITS.maxMediaSizeMB)
            return `Document trop lourd`;
    }
    if (msg.video) {
        if (msg.video.file_size && msg.video.file_size / (1024 * 1024) > LIMITS.maxMediaSizeMB)
            return `Vidéo trop lourde`;
    }
    return null;
}

function inspectMessage(msg) {
    try {
        if (!msg) return { suspicious: false };

        // Ignorer complètement les stickers — jamais suspects
        if (msg.sticker) return { suspicious: false };

        // Ignorer les emojis et réactions — jamais suspects
        if (msg.animation) return { suspicious: false };

        const text = msg.text || msg.caption || '';
        const reason = _analyzeText(text) || _analyzeMedia(msg);
        return reason ? { suspicious: true, reason } : { suspicious: false };
    } catch (err) {
        return { suspicious: false }; // En cas de doute, ne pas bloquer
    }
}

module.exports = { inspectMessage };
