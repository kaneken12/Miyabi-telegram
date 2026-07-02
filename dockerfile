# ============================================================
#  Dockerfile — Miyabi Telegram Bot
#  Node.js + yt-dlp + ffmpeg préinstallés
# ============================================================

FROM node:20-slim

# Installer les dépendances système
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    --no-install-recommends \
    && pip3 install yt-dlp --break-system-packages \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Vérifier les installations
RUN yt-dlp --version && ffmpeg -version | head -1

# Dossier de travail
WORKDIR /app

# Installer les dépendances Node
COPY package*.json ./
RUN npm install --production

# Copier le code
COPY . .

# Créer les dossiers nécessaires
RUN mkdir -p tmp data bin

# Exposer le port
EXPOSE 3000

# Lancer le bot
CMD ["node", "server.js"]