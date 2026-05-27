# 🌸 Miyabi Telegram Bot

Bot Telegram avec personnalité froide et sarcastique, propulsé par Gemini AI.

---

## ✨ Fonctionnalités

- 🎭 **Personnalité Miyabi** — IA froide, sarcastique, humeurs variables
- 📥 **Téléchargement** — YouTube, Facebook, Pinterest (vidéo + audio MP3)
- 🔍 **Recherche web** — Via DuckDuckGo sans clé API
- 🛡️ **Protection groupes** — Anti-purge, quarantaine, surveillance admins
- 🔒 **Sanitisation** — Suppression automatique des messages suspects

---

## 🚀 Installation

### 1. Créer le bot via BotFather

1. Ouvre Telegram et cherche **@BotFather**
2. Tape `/newbot`
3. Choisis un nom (ex: `Miyabi`)
4. Choisis un username (ex: `MiyabiAssistBot`)
5. **Copie le token** que BotFather te donne

### 2. Obtenir ton ID Telegram

1. Cherche **@userinfobot** sur Telegram
2. Tape `/start`
3. **Copie ton ID** (nombre entier)

### 3. Clé Gemini

1. Va sur [https://aistudio.google.com](https://aistudio.google.com)
2. Clique sur **Get API Key**
3. **Copie la clé**

### 4. Configurer le .env

```bash
cp .env.example .env
```

Remplis le fichier `.env` :
```
TELEGRAM_BOT_TOKEN=123456:ABC-ton-token-ici
GEMINI_API_KEY=ta-cle-gemini-ici
OWNER_ID=ton-id-telegram-ici
PORT=3000
```

### 5. Installer et lancer

```bash
# Installer les dépendances
npm install

# Installer yt-dlp (requis pour les téléchargements)
# Sur Windows (PowerShell) :
winget install yt-dlp

# Sur Termux :
pkg install yt-dlp

# Lancer le bot
npm start
```

---

## 📱 Sur Termux (Android)

```bash
# Installer les dépendances système
pkg update && pkg install -y nodejs python yt-dlp ffmpeg

# Cloner / copier le projet
cd ~
# (copie le dossier miyabi-telegram ici)

# Installer les modules npm
cd miyabi-telegram
npm install

# Configurer
cp .env.example .env
nano .env   # remplis les valeurs

# Lancer
npm start
```

---

## 💬 Commandes disponibles

| Commande | Description |
|----------|-------------|
| `/start` ou `/help` | Afficher l'aide |
| `/dl [lien]` | Télécharger une vidéo |
| `/mp3 [lien]` | Télécharger l'audio (YouTube) |
| `/search [requête]` | Recherche web |
| `/lock` | Verrouiller le groupe (admins) |
| `/unlock` | Déverrouiller le groupe (admins) |
| `/info` | Infos du groupe |
| `/guard` | Activer la protection |
| `/reset` | Réinitialiser la conversation |
| `/mood` | Voir l'humeur actuelle de Miyabi |

---

## 🛡️ Protection des groupes

Pour activer la protection, **ajoute Miyabi comme admin** dans ton groupe, puis tape `/guard`.

Ce que Miyabi surveille :
- **Quarantaine** — Nouveaux membres muets pendant 5 minutes
- **Détection de purge** — Alerte si 5+ expulsions en 30 secondes
- **Messages suspects** — Suppression automatique des messages crashants
- **Verrouillage** — `/lock` pour couper l'écriture à tous sauf admins

---

## 🎭 Utilisation en groupe

En groupe, Miyabi répond uniquement si :
- Tu la **mentionnes** : `@MiyabiBot ta question`
- Tu utilises une **commande** : `/dl`, `/search`, etc.

En **message privé**, elle répond à tout.

---

## 📦 Structure du projet

```
miyabi-telegram/
├── src/
│   ├── core/
│   │   ├── bot.js              ← Connexion Telegram + events
│   │   ├── gemini.js           ← Interface Gemini AI
│   │   └── personality.js      ← Humeurs et personnalité
│   ├── handlers/
│   │   └── messageHandler.js   ← Routage des commandes
│   ├── services/
│   │   ├── downloadService.js  ← YouTube / Facebook / Pinterest
│   │   ├── groupService.js     ← Protection anti-purgeurs
│   │   └── searchService.js    ← Recherche DuckDuckGo
│   └── utils/
│       ├── logger.js           ← Logs pino
│       └── messageSanitizer.js ← Détection messages suspects
├── tmp/                        ← Fichiers téléchargés (auto-nettoyé)
├── server.js                   ← Point d'entrée
├── package.json
└── .env.example
```

---

## ☁️ Déploiement sur Render

1. Pousse le projet sur GitHub
2. Crée un **Web Service** sur [render.com](https://render.com)
3. Build command : `npm install`
4. Start command : `npm start`
5. Ajoute les variables d'environnement dans Render Dashboard
6. Deploy !
