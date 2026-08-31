// ============================================================
//  src/services/walletService.js — Miyabi Wallet Manager
//  Gestion des fiches joueurs RP — Lower Tower
// ============================================================

const fs   = require("fs");
const path = require("path");

const DATA_DIR    = path.join(__dirname, "../../data");
const WALLET_FILE = path.join(DATA_DIR, "wallets.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Vérification admin dynamique (après chargement .env) ────
function isAdmin(userId) {
    const admins = [
        process.env.OWNER_ID,
        "5912513979", // Lunafreya
    ].filter(Boolean);
    return admins.includes(String(userId));
}

function formatWallet(player, updatedBy) {
    const date = new Date().toLocaleDateString("fr-FR", {
        day: "2-digit", month: "2-digit", year: "numeric"
    });
    return (
        "↤♖︎𝗟𝗢𝗪𝗘𝗥 𝗧𝗢𝗪𝗘𝗥♖︎↦\n" +
        "-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --\n" +
        "> 𝘞𝘢𝘭𝘭𝘦𝘵 𝘱𝘭𝘢𝘺𝘦𝘳𝘴💳\n" +
        "══════════════════\n" +
        "|• ℕ𝕠𝕞: *" + player.nom + "*\n" +
        "|• ℙ𝕤𝕖𝕦𝕕𝕠: *" + player.pseudo + "*\n" +
        "|• ℂ𝕝𝕒𝕤𝕤𝕖: *" + player.classe + "*\n" +
        "-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --\n" +
        "|• 𝔾𝕖𝕞: *" + player.gems + "💎*\n" +
        "|• 𝔸𝕓𝕪𝕤𝕤 𝕔𝕠𝕚𝕟𝕤: *" + player.abyssCoins + "🪙*\n" +
        "══════════════════\n" +
        "𝕌𝕡𝕕𝕒𝕥𝕖 𝕓𝕪: _*" + (updatedBy || player.updatedBy || "L. Lycoris") + "*_\n\n" +
        "𝔻𝕒𝕥𝕖 𝕦𝕡𝕕𝕒𝕥𝕖: `" + date + "`\n" +
        "══════════════════\n" +
        "-                 𝙻𝙾𝚆𝙴𝚁 𝚃𝙾𝚆𝙴𝚁"
    );
}

class WalletService {
    constructor() {
        this.wallets = this._load();
        setInterval(() => this._save(), 2 * 60 * 1000);
    }

    _load() {
        try {
            if (fs.existsSync(WALLET_FILE))
                return JSON.parse(fs.readFileSync(WALLET_FILE, "utf8"));
        } catch (e) { console.warn("[WALLET] Erreur chargement:", e.message); }
        return {};
    }

    _save() {
        try { fs.writeFileSync(WALLET_FILE, JSON.stringify(this.wallets, null, 2)); }
        catch (e) { console.warn("[WALLET] Erreur sauvegarde:", e.message); }
    }

    isAdmin(userId) { return isAdmin(userId); }

    _key(nameOrPseudo) { return nameOrPseudo.toLowerCase().trim(); }

    findPlayer(nameOrPseudo) {
        const search = this._key(nameOrPseudo);
        for (const [key, player] of Object.entries(this.wallets)) {
            if (this._key(player.nom) === search || this._key(player.pseudo) === search)
                return { key, player };
        }
        return null;
    }

    createWallet(userId, { nom, pseudo, classe, gems = 0, abyssCoins = 0 }, updatedBy) {
        if (!isAdmin(userId)) return { success: false, error: "NOT_AUTHORIZED" };
        const key = this._key(pseudo);
        if (this.wallets[key]) return { success: false, error: "ALREADY_EXISTS", pseudo };
        this.wallets[key] = {
            nom, pseudo, classe,
            gems: parseInt(gems) || 0,
            abyssCoins: parseInt(abyssCoins) || 0,
            updatedBy,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        this._save();
        return { success: true, player: this.wallets[key] };
    }

    updateGems(userId, nameOrPseudo, amount, operation, updatedBy) {
        if (!isAdmin(userId)) return { success: false, error: "NOT_AUTHORIZED" };
        const found = this.findPlayer(nameOrPseudo);
        if (!found) return { success: false, error: "NOT_FOUND", nameOrPseudo };
        const { key, player } = found;
        const amt = parseInt(amount) || 0;
        if (operation === "add") player.gems += amt;
        else if (operation === "remove") player.gems = Math.max(0, player.gems - amt);
        else player.gems = amt;
        player.updatedBy = updatedBy;
        player.updatedAt = new Date().toISOString();
        this.wallets[key] = player;
        this._save();
        return { success: true, player };
    }

    updateAbyssCoins(userId, nameOrPseudo, amount, operation, updatedBy) {
        if (!isAdmin(userId)) return { success: false, error: "NOT_AUTHORIZED" };
        const found = this.findPlayer(nameOrPseudo);
        if (!found) return { success: false, error: "NOT_FOUND", nameOrPseudo };
        const { key, player } = found;
        const amt = parseInt(amount) || 0;
        if (operation === "add") player.abyssCoins += amt;
        else if (operation === "remove") player.abyssCoins = Math.max(0, player.abyssCoins - amt);
        else player.abyssCoins = amt;
        player.updatedBy = updatedBy;
        player.updatedAt = new Date().toISOString();
        this.wallets[key] = player;
        this._save();
        return { success: true, player };
    }

    getWallet(nameOrPseudo) {
        const found = this.findPlayer(nameOrPseudo);
        if (!found) return { success: false, error: "NOT_FOUND", nameOrPseudo };
        return { success: true, player: found.player };
    }

    deleteWallet(userId, nameOrPseudo) {
        if (!isAdmin(userId)) return { success: false, error: "NOT_AUTHORIZED" };
        const found = this.findPlayer(nameOrPseudo);
        if (!found) return { success: false, error: "NOT_FOUND", nameOrPseudo };
        const { key, player } = found;
        delete this.wallets[key];
        this._save();
        return { success: true, pseudo: player.pseudo };
    }

    getAllWallets() { return Object.values(this.wallets); }
    formatWallet(player, updatedBy) { return formatWallet(player, updatedBy); }
    count() { return Object.keys(this.wallets).length; }
}

module.exports = new WalletService();
