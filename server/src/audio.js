// Flusso audio per Discord. ffmpeg legge la sorgente (link diretto con i suoi header, oppure la copia
// in RAM della cache) e la decodifica in PCM (s16le, 48 kHz, stereo: lavoro leggero). In node il
// CodificatoreOpus applica il volume a ogni pacchetto da 20 ms e lo codifica in Opus (opusscript),
// SOLO quando il player lo chiede: davanti al player ci sono al massimo 2 pacchetti già pronti, quindi
// un cambio di volume si sente in ~40-60 ms, senza riaprire ffmpeg né toccare la rete.
// (Prima il volume stava nel filtro di ffmpeg: ogni cambio riapriva ffmpeg un po' più avanti nel
// brano, con attese di 0,5-2 s, e falliva se il link era scaduto e il brano non era in RAM.)
// Volume reale = cursore (0-100) / 100 × config.volumeBase (il 100% del cursore è più basso).
// Ripiego: yt-dlp scarica e passa i dati a ffmpeg (più lento, ma funziona sempre).
import { spawn } from 'node:child_process';
import os from 'node:os';
import { Duplex, PassThrough } from 'node:stream';
import OpusScript from 'opusscript';
import { config } from './config.js';

const ATTESA_SIGKILL_MS = 3000; // se un processo non si chiude con SIGTERM, dopo 3 s SIGKILL
export const OPUS_KBPS = 128;
export const TIPO_USCITA = 'opus'; // StreamType.Opus di @discordjs/voice: pacchetti Opus già pronti
const CAMPIONI = 960; // 20 ms a 48 kHz
const BYTE_PACCHETTO = CAMPIONI * 2 * 2; // stereo, 16 bit
const PRONTI_MAX = 2; // pacchetti già codificati davanti al player: è il ritardo del volume (~40 ms)

const vivo = (p) => p.exitCode === null && p.signalCode === null;

/** Fattore reale: cursore (0-100) per il volume di base, 3 decimali. */
export function fattoreVolume(volume = 100, base = config.volumeBase) {
  const v = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
  return Number(((v / 100) * base).toFixed(3));
}

/** Argomenti di uscita di ffmpeg: solo decodifica in PCM su stdout (il volume e Opus li fa node). */
export function argomentiUscita() {
  return ['-vn', '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1'];
}

/**
 * PCM s16le stereo 48 kHz → pacchetti Opus da 20 ms (objectMode), con il volume applicato al
 * momento della codifica. Il volume nuovo passa in modo graduale dentro un pacchetto (niente «clic»).
 * Codifica un pacchetto solo quando c'è posto (al massimo PRONTI_MAX pronti): un pezzo grande di PCM
 * da ffmpeg (fino a 64 KB = 0,3 s) resta crudo finché il player non lo chiede. In pausa è fermo.
 */
export class CodificatoreOpus extends Duplex {
  constructor({ guadagno = 1, kbps = OPUS_KBPS } = {}) {
    super({ readableObjectMode: true, readableHighWaterMark: PRONTI_MAX, writableHighWaterMark: BYTE_PACCHETTO * 4 });
    this.enc = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    this.enc.setBitrate(kbps * 1000);
    // Complessità 5 (come prima con libopus -compression_level 5): ~0,5% di un core per brano
    try { this.enc.encoderCTL(4010, 5); } catch { /* resta il predefinito */ }
    this.pcm = Buffer.alloc(BYTE_PACCHETTO); // allineato: si lavora con Int16Array
    this.campioni = new Int16Array(this.pcm.buffer, this.pcm.byteOffset, BYTE_PACCHETTO / 2);
    this.riempiti = 0; // byte già in this.pcm
    this.guadagno = Math.max(0, Math.min(1, Number(guadagno) || 0)); // voluto
    this.attuale = this.guadagno; // applicato all'ultimo campione
    this.pezzo = null; // { chunk, o, cb }: PCM ricevuto e non ancora copiato
    this.finale = null; // callback di _final: finito il PCM, si chiude dopo l'ultimo pacchetto
    this.pieno = false; // il player ha già PRONTI_MAX pacchetti: si aspetta _read
    this.inPompa = false;
  }

  /** Volume reale (0-1): si applica dal prossimo pacchetto codificato. */
  impostaGuadagno(g) {
    this.guadagno = Math.max(0, Math.min(1, Number(g) || 0));
  }

  codifica() {
    const s = this.campioni;
    const da = this.attuale;
    const a = this.guadagno;
    if (da !== 1 || a !== 1) {
      const passo = (a - da) / CAMPIONI;
      for (let i = 0, k = 0; i < CAMPIONI; i++) {
        const g = da + passo * (i + 1);
        for (let c = 0; c < 2; c++, k++) {
          const v = Math.round(s[k] * g);
          s[k] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
        }
      }
    }
    this.attuale = a;
    this.riempiti = 0;
    this.pieno = !this.push(this.enc.encode(this.pcm, CAMPIONI));
  }

  pompa() {
    if (this.inPompa || !this.enc) return;
    this.inPompa = true;
    try {
      for (;;) {
        if (this.riempiti === BYTE_PACCHETTO) {
          if (this.pieno) return;
          this.codifica();
        } else if (this.pezzo) {
          const p = this.pezzo;
          const n = Math.min(BYTE_PACCHETTO - this.riempiti, p.chunk.length - p.o);
          p.chunk.copy(this.pcm, this.riempiti, p.o, p.o + n);
          this.riempiti += n;
          p.o += n;
          if (p.o >= p.chunk.length) {
            this.pezzo = null;
            p.cb(); // può chiamare subito _write con il pezzo dopo: lo prende questo stesso giro
          }
        } else if (this.finale) {
          if (this.riempiti > 0) {
            this.pcm.fill(0, this.riempiti); // ultimo pezzo: completato con silenzio
            this.riempiti = BYTE_PACCHETTO;
            continue;
          }
          const cb = this.finale;
          this.finale = null;
          this.push(null);
          cb();
          return;
        } else {
          return;
        }
      }
    } catch (err) {
      this.destroy(err);
    } finally {
      this.inPompa = false;
    }
  }

  _write(chunk, _enc, cb) {
    this.pezzo = { chunk, o: 0, cb };
    this.pompa();
  }

  _final(cb) {
    this.finale = cb;
    this.pompa();
  }

  _read() {
    this.pieno = false;
    this.pompa();
  }

  _destroy(err, cb) {
    try { this.enc?.delete(); } catch { /* già liberato */ }
    this.enc = null;
    cb(err);
  }
}

/**
 * Mette insieme lo stream di ffmpeg (PCM) con il codificatore e i controlli comuni.
 * idleMs() dice da quanto non passano dati (controllo dei blocchi), bytes() quanti ne sono passati,
 * ready(ms) si risolve al primo dato e fallisce se ffmpeg si chiude prima (con il suo errore),
 * impostaVolume(cursore) cambia il volume subito (dal prossimo pacchetto).
 */
function wrap(ffmpeg, others = [], { volume = 100, base = config.volumeBase, ...extra } = {}) {
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
  const cod = new CodificatoreOpus({ guadagno: fattoreVolume(volume, base) });
  ffmpeg.stdout.pipe(out).pipe(cod);
  ffmpeg.stdout.on('error', () => {});
  out.on('error', () => {});
  cod.on('error', (e) => console.error('[opus] codifica non riuscita:', e.message));
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

  const audio = {
    ...extra,
    modo: 'pcm',
    tipo: TIPO_USCITA,
    volume,
    stream: cod,
    kill,
    impostaVolume(v) {
      audio.volume = v;
      cod.impostaGuadagno(fattoreVolume(v, base));
    },
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
  return audio;
}

/**
 * Ripiego: avvia yt-dlp | ffmpeg e restituisce lo stream di pacchetti Opus. Con startSec > 0 ffmpeg scarta l'inizio (più lento del seek diretto).
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
    ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...ss, ...argomentiUscita()],
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
  return wrap(ffmpeg, [ytdlp], { volume, fonte: 'ripiego' });
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
 * Con startSec > 0 -ss sta PRIMA di -i, così salta subito al punto giusto senza scaricare l'inizio
 * (decodificando, ffmpeg parte esattamente dal secondo chiesto).
 * @param {{ url: string, headers?: Record<string,string>, acodec?: string|null }} stream
 * @param {{ volume?: number, fonte?: string, base?: number }} opzioni fonte: 'rete' | 'cache' (solo per i log e le stime);
 *   base: volume di base (predefinito config.volumeBase)
 */
export function createOpusStreamAt(stream, startSec = 0, { volume = 100, fonte = 'rete', base = config.volumeBase } = {}) {
  const ss = startSec > 0 ? ['-ss', String(Math.max(0, Math.round(startSec * 1000) / 1000))] : [];
  const ffmpeg = spawn(
    config.ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      ...headerArgs(stream.headers),
      ...ss,
      '-i', stream.url,
      ...argomentiUscita(),
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return wrap(ffmpeg, [], { volume, fonte, base });
}

/**
 * File locale (suoni della Soundbar) con il solo volume di base: stessa uscita della musica
 * (pacchetti Opus, TIPO_USCITA). guadagno 0-1 (predefinito config.volumeBase).
 */
export function createFileStream(file, { guadagno = config.volumeBase } = {}) {
  const ffmpeg = spawn(
    config.ffmpeg,
    ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, ...argomentiUscita()],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return wrap(ffmpeg, [], { volume: 100, base: guadagno, fonte: 'file' });
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
