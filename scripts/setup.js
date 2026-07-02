// ============================================================
//  scripts/setup.js — Script de build pour Render
//  Télécharge yt-dlp au moment du build
// ============================================================

const YTDlpWrap = require('yt-dlp-wrap').default;
const path      = require('path');
const fs        = require('fs');
const { execSync } = require('child_process');

async function setup() {
    console.log('[SETUP] Démarrage de la configuration...');

    // Créer les dossiers nécessaires
    const dirs = [
        path.join(__dirname, '../bin'),
        path.join(__dirname, '../tmp'),
        path.join(__dirname, '../data'),
    ];
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`[SETUP] Dossier créé : ${dir}`);
        }
    }

    // Vérifier si yt-dlp est déjà disponible dans le système
    try {
        execSync('yt-dlp --version', { stdio: 'ignore' });
        console.log('[SETUP] yt-dlp système détecté — pas besoin de télécharger');
        return;
    } catch (_) {}

    // Télécharger le binaire yt-dlp
    const binPath = path.join(__dirname, '../bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

    if (fs.existsSync(binPath)) {
        console.log('[SETUP] Binaire yt-dlp déjà présent');
    } else {
        console.log('[SETUP] Téléchargement de yt-dlp...');
        try {
            await YTDlpWrap.downloadFromGithub(binPath);
            if (process.platform !== 'win32') {
                execSync(`chmod +x ${binPath}`);
            }
            console.log('[SETUP] yt-dlp téléchargé avec succès');
        } catch (err) {
            console.error('[SETUP] Echec téléchargement yt-dlp:', err.message);
            process.exit(1);
        }
    }

    console.log('[SETUP] Configuration terminée ✅');
}

setup().catch(err => {
    console.error('[SETUP] Erreur fatale:', err);
    process.exit(1);
});
