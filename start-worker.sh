#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
#  start-worker.sh — Lancer le worker Miyabi sur Termux
# ============================================================

echo "🚀 Démarrage du worker Miyabi..."

termux-wake-lock
echo "🔒 Wake lock activé"

cd ~/miyabi-telegram || { echo "❌ Dossier miyabi-telegram introuvable"; exit 1; }

echo "nameserver 8.8.8.8" > $PREFIX/etc/resolv.conf

if ! command -v ngrok &> /dev/null; then
    echo "📦 Installation de ngrok..."
    pkg install ngrok -y
fi

source .env 2>/dev/null || true

if [ -z "$NGROK_TOKEN" ]; then
    echo "⚠️  NGROK_TOKEN manquant dans .env"
    exit 1
fi

ngrok config add-authtoken $NGROK_TOKEN 2>/dev/null

echo "🌐 Lancement de ngrok..."
ngrok http 4000 --log=stdout > /tmp/ngrok.log 2>&1 &
NGROK_PID=$!

sleep 4

NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for t in data.get('tunnels', []):
        if t.get('proto') == 'https':
            print(t['public_url'])
            break
except: pass
" 2>/dev/null)

if [ -z "$NGROK_URL" ]; then
    echo "❌ Impossible de récupérer l'URL ngrok"
    kill $NGROK_PID 2>/dev/null
    exit 1
fi

echo ""
echo "════════════════════════════════════════"
echo "✅ Worker accessible sur :"
echo "   $NGROK_URL"
echo ""
echo "📋 Mets à jour sur Render :"
echo "   WORKER_URL=$NGROK_URL"
echo "════════════════════════════════════════"
echo ""

node worker.js

kill $NGROK_PID 2>/dev/null
termux-wake-unlock
echo "🛑 Worker arrêté"
