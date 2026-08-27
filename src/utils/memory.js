// ============================================================
//  src/utils/memory.js — Mémoire persistante JSON
// ============================================================

const fs   = require('fs');
const path = require('path');

const DATA_DIR    = path.join(__dirname, '../../data');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const MAX_HISTORY = 30;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

class Memory {
    constructor() {
        this.data = this._load();
        setInterval(() => this._save(), 2 * 60 * 1000);
    }

    _load() {
        try {
            if (fs.existsSync(MEMORY_FILE))
                return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
        } catch (e) { console.warn('[MEMORY] Erreur chargement:', e.message); }
        return { users: {}, histories: {} };
    }

    _save() {
        try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.data, null, 2)); }
        catch (e) { console.warn('[MEMORY] Erreur sauvegarde:', e.message); }
    }

    saveNow() { this._save(); }

    setUser(userId, info) {
        this.data.users[userId] = { ...this.data.users[userId], ...info, lastSeen: Date.now() };
    }

    getUser(userId)     { return this.data.users[userId] || null; }
    getUserName(userId) { return this.data.users[userId]?.name || null; }

    getHistory(userId)  { return this.data.histories[userId] || []; }

    addToHistory(userId, role, text) {
        if (!this.data.histories[userId]) this.data.histories[userId] = [];
        const h = this.data.histories[userId];
        h.push({ role, parts: [{ text }] });
        if (h.length > MAX_HISTORY * 2) h.splice(0, 2);
        return h;
    }

    clearHistory(userId) { this.data.histories[userId] = []; this._save(); }
    getUserCount()       { return Object.keys(this.data.users).length; }
}

module.exports = new Memory();
