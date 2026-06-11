// ============================================================
//  src/utils/memory.js — Mémoire persistante JSON
//  Sauvegarde les historiques de conversation sur disque
// ============================================================

const fs   = require('fs');
const path = require('path');

const MEMORY_DIR  = path.join(__dirname, '../../data');
const MEMORY_FILE = path.join(MEMORY_DIR, 'memory.json');
const MAX_HISTORY = 30; // messages max par utilisateur

// S'assurer que le dossier data existe
if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });

class Memory {
    constructor() {
        this.data = this._load();
        // Sauvegarder toutes les 2 minutes
        setInterval(() => this._save(), 2 * 60 * 1000);
    }

    // ── Charger depuis le fichier ────────────────────────────
    _load() {
        try {
            if (fs.existsSync(MEMORY_FILE)) {
                const raw = fs.readFileSync(MEMORY_FILE, 'utf8');
                return JSON.parse(raw);
            }
        } catch (e) {
            console.warn('[MEMORY] Erreur chargement:', e.message);
        }
        return { users: {}, histories: {} };
    }

    // ── Sauvegarder sur disque ───────────────────────────────
    _save() {
        try {
            fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.data, null, 2));
        } catch (e) {
            console.warn('[MEMORY] Erreur sauvegarde:', e.message);
        }
    }

    // ── Sauvegarder immédiatement ────────────────────────────
    saveNow() { this._save(); }

    // ── Utilisateurs ─────────────────────────────────────────
    setUser(userId, info) {
        this.data.users[userId] = { ...this.data.users[userId], ...info, lastSeen: Date.now() };
    }

    getUser(userId) {
        return this.data.users[userId] || null;
    }

    getUserName(userId) {
        return this.data.users[userId]?.name || null;
    }

    // ── Historique de conversation ────────────────────────────
    getHistory(userId) {
        return this.data.histories[userId] || [];
    }

    addToHistory(userId, role, text) {
        if (!this.data.histories[userId]) this.data.histories[userId] = [];
        const history = this.data.histories[userId];
        history.push({ role, parts: [{ text }] });
        // Limiter la taille
        if (history.length > MAX_HISTORY * 2) history.splice(0, 2);
        return history;
    }

    clearHistory(userId) {
        this.data.histories[userId] = [];
        this._save();
    }

    // ── Stats ─────────────────────────────────────────────────
    getUserCount() { return Object.keys(this.data.users).length; }
}

module.exports = new Memory();
