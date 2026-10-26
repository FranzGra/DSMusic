// Legge la configurazione dal file .env nella cartella principale del progetto.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const envPath = path.join(rootDir, '.env');
const envExists = fs.existsSync(envPath);
if (envExists) dotenv.config({ path: envPath, quiet: true });

const env = process.env;
/** Numero intero >= 0 dal .env; se manca o non è valido vale il predefinito. */
const numero = (v, predefinito) => {
  const t = String(v ?? '').trim();
  if (!t) return predefinito;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : predefinito;
};
const vero = (v) => ['1', 'true', 'si', 'sì', 'yes'].includes(String(v ?? '').trim().toLowerCase());

export const config = {
  rootDir,
  // CLIENT_DIST: cartella dell'interfaccia compilata (per provare una build senza toccare client/dist)
  clientDist: env.CLIENT_DIST?.trim() ? path.resolve(rootDir, env.CLIENT_DIST.trim()) : path.join(rootDir, 'client', 'dist'),
  port: Number(env.PORT) || 3001,
  clientId: env.DISCORD_CLIENT_ID?.trim() || '',
  clientSecret: env.DISCORD_CLIENT_SECRET?.trim() || '',
  botToken: env.DISCORD_BOT_TOKEN?.trim() || '',
  // Canali musica: uno o più ID separati da virgola
  textChannelIds: String(env.MUSIC_TEXT_CHANNEL_ID ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  prova: vero(env.MODALITA_PROVA) || process.argv.includes('--prova'),
  provaGuildId: env.PROVA_GUILD_ID?.trim() || '',
  provaChannelId: env.PROVA_CHANNEL_ID?.trim() || '',
  // Uscita automatica dal canale vocale (0 = disattivato)
  emptySeconds: numero(env.USCITA_CANALE_VUOTO_SECONDI, 60),
  idleMinutes: numero(env.USCITA_INATTIVITA_MINUTI, 5),
  ytdlp: env.YTDLP_PATH?.trim() || 'yt-dlp',
  ffmpeg: env.FFMPEG_PATH?.trim() || 'ffmpeg',
  // Cartella dei dati che devono sopravvivere ai riavvii (coda salvata). In Docker è un volume.
  dataDir: path.resolve(rootDir, env.DATA_DIR?.trim() || 'data'),
  // Audio fermo (yt-dlp o ffmpeg bloccati) per più di così: si passa al brano dopo
  stallSeconds: numero(env.BLOCCO_AUDIO_SECONDI, 30) || 30,
  // Chi parla nel canale vocale (MOSTRA_CHI_PARLA=0 per spegnerlo): il bot entra non self-deaf
  // e legge solo chi manda pacchetti voce, senza ascoltare né decodificare l'audio.
  mostraParlanti: !['0', 'false', 'no'].includes(String(env.MOSTRA_CHI_PARLA ?? '').trim().toLowerCase()),
  // Stato del canale vocale (testo sotto il nome del canale) = brano in riproduzione. STATO_CANALE=0 lo spegne.
  statoCanale: !['0', 'false', 'no'].includes(String(env.STATO_CANALE ?? '').trim().toLowerCase()),

  // ---------- leggerezza (macchine con poca RAM) ----------
  // Cache audio in RAM (mai su disco): per ogni server l'ultimo brano ascoltato, quello in corso e i
  // 2 prossimi, per partenze, spostamenti, «precedente» e cambi di volume senza rete. 0 MB = spenta.
  // Il budget in MB è unico per tutti i server: con brani normali (3-5 min, ~1 MB al minuto) 4 brani
  // stanno in ~20 MB; se non c'è posto (brani lunghi) l'ultimo da scaricare suona dalla rete.
  cacheAudioMb: numero(env.CACHE_AUDIO_MB, 96),
  cacheAudioBrani: numero(env.CACHE_AUDIO_BRANI, 4) || 4, // per server
  cacheAudioMaxMinuti: numero(env.CACHE_AUDIO_MAX_MINUTI, 20) || 20,
  // Minuti senza il bot in nessun canale vocale prima di liberare cache, link e memoria. 0 = mai.
  riposoMinuti: numero(env.RIPOSO_MINUTI, 2),
  // Processi yt-dlp nello stesso momento (ognuno usa ~350 MB per qualche secondo). Minimo 1.
  ytdlpContemporanei: Math.max(1, numero(env.YTDLP_CONTEMPORANEI, 2)),

  // ---------- Soundbar (suoni brevi caricati dall'Activity) ----------
  // Ruoli Discord che possono caricare suoni (ID separati da virgola). Vuoto = solo gli amministratori.
  soundbarRuoli: String(env.SOUNDBAR_RUOLO_ID ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  soundbarMaxSecondi: numero(env.SOUNDBAR_MAX_SECONDI, 20) || 20,
  soundbarMaxMb: numero(env.SOUNDBAR_MAX_MB, 2) || 2,
  // ffprobe (durata dei suoni): stesso posto di ffmpeg se non indicato
  ffprobe: env.FFPROBE_PATH?.trim() || ffprobeDa(env.FFMPEG_PATH?.trim() || 'ffmpeg'),
};

/** Percorso di ffprobe accanto a ffmpeg (stesso nome con «ffprobe» al posto di «ffmpeg»). */
function ffprobeDa(ffmpeg) {
  const base = path.basename(ffmpeg);
  if (!/ffmpeg/i.test(base)) return 'ffprobe';
  return path.join(path.dirname(ffmpeg), base.replace(/ffmpeg/i, 'ffprobe')).replace(/^\.[\\/]/, '');
}

/** Controlla le variabili e, se manca qualcosa, esce con un messaggio chiaro in italiano. */
export function checkConfig() {
  const required = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN'];
  const missing = required.filter((k) => !env[k]?.trim());

  if (config.prova) {
    if (!config.provaGuildId) config.provaGuildId = 'prova-server';
    if (!config.provaChannelId) config.provaChannelId = 'prova-canale';
    if (missing.length) {
      console.warn(`[config] Modalità prova attiva. Mancano: ${missing.join(', ')}.`);
      console.warn('[config] Server e interfaccia partono, ma il bot non entra in Discord e la musica non si sente.');
    }
    return;
  }

  if (!missing.length) return;

  const righe = [
    '',
    '  Impossibile avviare il bot: configurazione incompleta.',
    '',
    envExists
      ? `  Nel file ${envPath} mancano queste variabili:`
      : `  Il file .env non esiste (${envPath}).`,
  ];
  if (envExists) for (const k of missing) righe.push(`    - ${k}`);
  righe.push(
    '',
    '  Cosa fare:',
    '    1. Copia .env.example in .env  (comando: cp .env.example .env)',
    '    2. Inserisci i valori presi dal Discord Developer Portal (vedi README.md)',
    '    3. Oppure, per provare solo l\'interfaccia nel browser, metti MODALITA_PROVA=1',
    '',
  );
  console.error(righe.join('\n'));
  process.exit(1);
}
