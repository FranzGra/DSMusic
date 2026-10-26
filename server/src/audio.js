// Flusso audio per Discord, già in Opus: node non decodifica e non ricodifica niente.
// ffmpeg legge la sorgente (link diretto con i suoi header, oppure la copia in RAM della cache) e
// scrive Ogg/Opus; @discordjs/voice estrae solo i pacchetti (StreamType.OggOpus).
//  - sorgente già Opus e volume 100%: copia senza ricodifica (-c:a copy), CPU quasi zero;
//  - altrimenti: filtro volume di ffmpeg + libopus (codificatore nativo, più leggero di opusscript).
// Ripiego: yt-dlp scarica e passa i dati a ffmpeg (più lento, ma funziona sempre).
import { spawn } from 'node:child_process';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { config } from './config.js';

const ATTESA_SIGKILL_MS = 3000; // se un processo non si chiude con SIGTERM, dopo 3 s SIGKILL
export const OPUS_KBPS = 128;

const vivo = (p) => p.exitCode === null && p.signalCode === null;

/**
 * Come esce l'audio da ffmpeg: 'copia' (pacchetti Opus della sorgente così come sono) oppure
 * 'opus' (ricodifica con libopus, con il volume applicato da ffmpeg).
 * La copia è possibile solo se la sorgente è Opus e il volume è al 100%.
 */
export function sceltaUscita({ acodec = null, volume = 100 } = {}) {
  return acodec === 'opus' && Math.round(volume) === 100 ? 'copia' : 'opus';
}

/** Argomenti di uscita di ffmpeg per la modalità scelta (sempre Ogg/Opus su stdout). */
export function argomentiUscita(modo, volume = 100) {
  // -copypriorss 0: con la copia e -ss prima di -i, ffmpeg salta al punto di indice (Cues del WebM)
  // precedente e copierebbe anche i pacchetti prima del secondo chiesto (fino a qualche secondo
  // indietro): spostamenti e cambi di volume ripartirebbero da un altro punto. Così parte giusto (±20 ms).
  if (modo === 'copia') return ['-vn', '-c:a', 'copy', '-copypriorss', '0', '-f', 'ogg', 'pipe:1'];
  const v = Math.max(0, Math.min(100, Math.round(volume)));
  return [
    '-vn',
    ...(v !== 100 ? ['-af', `volume=${(v / 100).toFixed(2)}`] : []),
    '-ar', '48000', '-ac', '2',
    // compression_level 5: circa il 35% di CPU in meno del livello 10 (predefinito; misura 0,70% contro 1,08%) con qualità che a 128 kbps non si distingue
    '-c:a', 'libopus', '-b:a', `${OPUS_KBPS}k`, '-vbr', 'on', '-compression_level', '5', '-frame_duration', '20',
    '-f', 'ogg', 'pipe:1',
  ];
}

/**
 * Mette insieme lo stream di ffmpeg con i controlli comuni.
 * idleMs() dice da quanto non passano dati (controllo dei blocchi), bytes() quanti ne sono passati,
 * ready(ms) si risolve al primo dato e fallisce se ffmpeg si chiude prima (con il suo errore).
 */
function wrap(ffmpeg, others = [], extra = {}) {
  let lastData = Date.now();
  let bytes = 0;
  let stderr = '';
  let firstResolve;
  let firstReject;
  const first = new Promise((res, rej) => { firstResolve = res; firstReject = rej; });
  first.catch(() => {}); // chi non aspetta ready() non deve vedere un rifiuto non gestito

  // Contatore in mezzo: rispetta la contropressione (in pausa non scorre niente) e segna l'ultimo dato.
  const out = new PassThrough({
    transform(chunk, _enc, cb) {
      lastData = Date.now();
      if (bytes === 0) firstResolve();
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  ffmpeg.stdout.pipe(out);
  ffmpeg.stdout.on('error', () => {});
  out.on('error', () => {});
  ffmpeg.stderr.on('data', (d) => {
    const s = String(d).trim();
    stderr = (stderr + '\n' + s).slice(-2000);
    console.error('[ffmpeg]', s);
  });
  ffmpeg.on('error', (e) => {
    console.error('[ffmpeg] non avviabile:', e.message);
    firstReject(new Error(`ffmpeg non avviabile (${e.message})`));
  });
  ffmpeg.on('close', (code) => {
    if (bytes === 0) firstReject(new Error(stderr.trim() || `ffmpeg chiuso (codice ${code}) senza audio`));
    // Se ffmpeg muore, gli altri processi (yt-dlp) non servono più: niente processi orfani.
    for (const p of others) if (vivo(p)) p.kill();
  });

  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    for (const p of [...others, ffmpeg]) {
      if (!vivo(p)) continue;
      p.kill();
      // Garanzia: se dopo qualche secondo è ancora vivo, lo chiude a forza.
      setTimeout(() => vivo(p) && p.kill('SIGKILL'), ATTESA_SIGKILL_MS).unref();
    }
    // Lo stream non va distrutto a mano: con ffmpeg chiuso finisce da solo, senza errori "premature close".
  };

  return {
    ...extra,
    stream: out,
    kill,
    idleMs: () => Date.now() - lastData,
    touch: () => { lastData = Date.now(); },
    bytes: () => bytes,
    ready(timeoutMs = 15_000) {
      let t;
      const timeout = new Promise((_, rej) => {
        t = setTimeout(() => rej(new Error(`nessun audio dopo ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
        t.unref?.();
      });
      return Promise.race([first, timeout]).finally(() => clearTimeout(t));
    },
  };
}

/**
 * Ripiego: avvia yt-dlp | ffmpeg e restituisce lo stream Ogg/Opus (sempre ricodificato: il formato
 * scaricato non si conosce prima). Con startSec > 0 ffmpeg scarta l'inizio (più lento del seek diretto).
 * yt-dlp lavora nella cartella temporanea: per i formati a frammenti scrive file .part
 * (in /app non può, e ffmpeg riceverebbe dati non validi).
 */
export function createOpusStream(url, startSec = 0, { volume = 100 } = {}) {
  const ytdlp = spawn(
    config.ytdlp,
    ['--no-warnings', '--ignore-config', '--no-playlist', '-f', 'bestaudio/best', '--http-chunk-size', '1M', '-o', '-', url],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: os.tmpdir() },
  );
  const ss = startSec > 0 ? ['-ss', String(Math.floor(startSec))] : [];
  const ffmpeg = spawn(
    config.ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...ss, ...argomentiUscita('opus', volume)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  ytdlp.stdout.pipe(ffmpeg.stdin);
  // Quando ffmpeg viene chiuso, yt-dlp riceve EPIPE: è normale, lo ignoriamo.
  ffmpeg.stdin.on('error', () => {});
  ytdlp.stdout.on('error', () => {});
  ytdlp.stderr.on('data', (d) => {
    const s = String(d);
    if (s.includes('ERROR')) console.error('[yt-dlp]', s.trim());
  });
  ytdlp.on('error', (e) => console.error('[yt-dlp] non avviabile:', e.message));
  // (Se finisce yt-dlp, ffmpeg riceve la fine del flusso e si chiude da solo.)
  return wrap(ffmpeg, [ytdlp], { modo: 'opus', volume, fonte: 'ripiego' });
}

/** Argomenti di ffmpeg per gli header HTTP chiesti dal sito (YouTube rifiuta con 403 senza User-Agent). */
export function headerArgs(headers = {}) {
  const args = [];
  let altri = '';
  for (const [k, v] of Object.entries(headers || {})) {
    if (typeof v !== 'string' || /[\r\n]/.test(k + v)) continue;
    if (k.toLowerCase() === 'user-agent') args.push('-user_agent', v);
    else altri += `${k}: ${v}\r\n`;
  }
  if (altri) args.push('-headers', altri);
  return args;
}

/**
 * Via veloce: ffmpeg legge l'URL (diretto, o quello locale della cache in RAM) con gli header giusti.
 * Con startSec > 0 -ss sta PRIMA di -i, così salta subito al punto giusto senza scaricare l'inizio.
 * @param {{ url: string, headers?: Record<string,string>, acodec?: string|null }} stream
 * @param {{ volume?: number, fonte?: string }} opzioni fonte: 'rete' | 'cache' (solo per i log e le stime)
 */
export function createOpusStreamAt(stream, startSec = 0, { volume = 100, fonte = 'rete' } = {}) {
  const ss = startSec > 0 ? ['-ss', String(Math.max(0, Math.round(startSec * 1000) / 1000))] : [];
  const modo = sceltaUscita({ acodec: stream.acodec, volume });
  const ffmpeg = spawn(
    config.ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      ...headerArgs(stream.headers),
      ...ss,
      '-i', stream.url,
      ...argomentiUscita(modo, volume),
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return wrap(ffmpeg, [], { modo, volume, fonte });
}

/** L'errore di ffmpeg dice che l'URL dello stream è scaduto o non più valido? */
export const urlScaduto = (err) => /\b40[13]\b|\b410\b|Forbidden|expired|Gone/i.test(String(err?.message || err));

/** Errori di ffmpeg in parole semplici. */
export function erroreAudio(err) {
  const m = String(err?.message || err || '');
  if (/Invalid data found/i.test(m)) return 'il flusso audio ricevuto non è valido';
  if (urlScaduto(m)) return 'il sito ha rifiutato il link audio (403)';
  if (/nessun audio dopo/i.test(m)) return m;
  return m.split('\n').pop().slice(0, 160) || 'errore audio';
}
