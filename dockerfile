FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip ffmpeg curl ca-certificates \
    --no-install-recommends \
    && pip3 install yt-dlp --break-system-packages \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p tmp data bin

EXPOSE 3000
CMD ["node", "server.js"]
