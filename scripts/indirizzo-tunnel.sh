#!/bin/sh
# Mostra l'indirizzo attuale del quick tunnel (da copiare in Developer Portal → Activities → URL Mappings).
cd "$(dirname "$0")/.." || exit 1
host=$(docker compose logs tunnel 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -n 1 | sed 's#https://##')
if [ -z "$host" ]; then
  echo "Indirizzo non ancora pronto. Riprova tra qualche secondo (docker compose logs tunnel)."
  exit 1
fi
echo "$host"
