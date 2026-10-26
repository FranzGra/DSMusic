# syntax=docker/dockerfile:1
# Bot musicale Discord: server Node + interfaccia compilata + yt-dlp + ffmpeg.
# Multi-architettura: funziona su amd64 e arm64 (anche schede ARM con poca RAM).

# ---------- 1) Build dell'interfaccia ----------
# Sulla piattaforma di build (niente emulazione): il risultato sono file statici uguali per tutti.
FROM --platform=$BUILDPLATFORM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY client/ client/
RUN npm run build

# ---------- 2) Dipendenze di produzione del server ----------
# Sulla piattaforma di destinazione: @snazzah/davey è un modulo nativo (amd64 o arm64).
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --no-audit --no-fund -w @discord-music/server

# ---------- 3) yt-dlp (versione «cartella», non il file unico) ----------
# Il file unico (yt-dlp_linux) a OGNI avvio estrae ~83 MB in /tmp: su macchine piccole vuol dire
# scritture continue sul disco e ~0,3 s di CPU in più per brano.
# La versione «cartella» (yt-dlp_linux.zip) parte già estratta. Si scarica sulla piattaforma di
# build (niente emulazione): sono solo file.
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS ytdlp
# TARGETARCH lo imposta Docker: amd64 oppure arm64
ARG TARGETARCH
# Cambia questo valore (o usa --build-arg) per forzare il download di un yt-dlp nuovo
ARG YTDLP_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) f=yt-dlp_linux.zip ;; \
      arm64) f=yt-dlp_linux_aarch64.zip ;; \
      *) echo "Architettura non supportata: $TARGETARCH"; exit 1 ;; \
    esac; \
    if [ "$YTDLP_VERSION" = latest ]; then u="https://github.com/yt-dlp/yt-dlp/releases/latest/download/$f"; \
    else u="https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/$f"; fi; \
    curl -fsSL "$u" -o /tmp/yt-dlp.zip; \
    mkdir -p /opt/yt-dlp; \
    unzip -q /tmp/yt-dlp.zip -d /opt/yt-dlp; \
    exe=$(find /opt/yt-dlp -maxdepth 1 -type f -name 'yt-dlp_linux*' | head -n 1); \
    test -n "$exe"; \
    mv "$exe" /opt/yt-dlp/yt-dlp.bin; \
    chmod -R a+rX /opt/yt-dlp; \
    chmod 755 /opt/yt-dlp/yt-dlp.bin

# ---------- 4) Immagine finale ----------
FROM node:24-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

# Il wrapper aggiunge "--js-runtimes node" (YouTube richiede un runtime JS; Node c'è già).
# Serve un wrapper perché il server avvia yt-dlp con --ignore-config.
# Controlli: yt-dlp parte e ffmpeg ha libopus (l'audio per Discord lo codifica ffmpeg).
COPY --from=ytdlp /opt/yt-dlp /opt/yt-dlp
RUN printf '#!/bin/sh\nexec /opt/yt-dlp/yt-dlp.bin --js-runtimes node "$@"\n' > /usr/local/bin/yt-dlp \
 && chmod 755 /usr/local/bin/yt-dlp \
 && yt-dlp --version \
 && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libopus

ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=/app/data
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node server/package.json server/
COPY --chown=node:node server/src server/src
COPY --chown=node:node --from=build /app/client/dist client/dist
# Cartella dei dati (coda salvata): il volume la eredita con proprietario node
RUN mkdir -p /app/data && chown node:node /app/data

# Utente non root (già presente nell'immagine node, uid 1000)
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
# --expose-gc: a riposo (nessuno in vocale) il bot chiede una raccolta della memoria (vedi music.js).
# --max-old-space-size=256: tetto al heap JS (in uso ~10-20 MB), così un errore non mangia tutta la RAM.
# Niente NODE_OPTIONS globale: lo erediterebbe anche il node della sfida JS di yt-dlp, che con un
# heap piccolo fallisce e fa usare il ripiego lento (prova del 25-10-2026).
CMD ["node", "--expose-gc", "--max-old-space-size=256", "server/src/index.js"]
