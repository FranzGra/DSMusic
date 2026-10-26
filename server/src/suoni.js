// Soundbar: libreria dei suoni brevi di ogni server Discord (guild), caricati dall'Activity.
//
// - File audio convertiti una volta sola al caricamento in Ogg/Opus 48 kHz stereo con volume
//   normalizzato (loudnorm): per suonarli non serve ffmpeg, node legge i pacchetti Opus dal file.
// - Indice per server in `${dataDir}/suoni-<guild>.json`, file in `${dataDir}/suoni/<guild>/<uuid>.ogg`.
//   Scrittura atomica dell'indice (file temporaneo + rename, come playlists.js).
// - Biglietti monouso per il caricamento via HTTP e limitatore anti-spam per chi suona.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import express from 'express';

const PREFISSO = 'suoni-';
const nomeSicuro = (guildId) => String(guildId).replace(/[^\w-]/g, '_');
const FILE_VALIDO = /^[\w-]+\.ogg$/;

export const NOME_MAX = 40;
export const SUONI_MAX = 100;
export const MAX_SECONDI = 20;
export const MAX_MB = 2;
export const TOLLERANZA_S = 0.25; // un suono di 20,2 s passa ancora
export const TIMEOUT_MS = 15_000; // ffprobe + ffmpeg per un caricamento
export const BIGLIETTO_MS = 60_000;
export const VOLUME_MIN = 0.1;
export const VOLUME_MAX = 2;
export const VOLUME_PASSO = 0.05;

/** Errore da mostrare all'utente così com'è. Codici: permesso, troppo_lungo, troppo_grande, formato, nome_usato, pieno, disco, piano, altro_canale. */
export class SoundError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** Nome pulito (spazi in fila ridotti a uno) oppure errore. */
export function nomeValido(name) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!n) throw new SoundError('Il nome non può essere vuoto', 'nome_vuoto');
  if ([...n].length > NOME_MAX) throw new SoundError(`Nome troppo lungo (massimo ${NOME_MAX} caratteri)`, 'nome_lungo');
  return n;
}

/**
 * Volume di un suono (1 = 100%): numero tra 0,1 e 2, arrotondato a 0,05 (fuori intervallo: portato al
 * limite). Non è un numero: errore.
 */
export function volumeValido(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v.trim().replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new SoundError('Volume non valido', 'volume');
  const r = Math.round(n / VOLUME_PASSO) * VOLUME_PASSO;
  return Number(Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, r)).toFixed(2));
}

/** Header X-Volume del caricamento: assente o non valido = 1 (il caricamento non si perde per il volume). */
export function volumeDaHeader(testo) {
  if (testo === undefined || testo === null || String(testo).trim() === '') return 1;
  try {
    return volumeValido(String(testo));
  } catch {
    return 1;
  }
}

const stessoNome = (a, b) => a.localeCompare(b, 'it', { sensitivity: 'base' }) === 0;

/** Chi può caricare: un amministratore oppure chi ha uno dei ruoli della Soundbar. */
export const puoCaricare = ({ isAdmin = false, haRuolo = false } = {}) => isAdmin === true || haRuolo === true;

/** Il membro (ruoli: Set, Map o array di id) ha almeno uno dei ruoli consentiti? Lista vuota = no. */
export function haUnRuolo(ruoliMembro, consentiti) {
  const lista = (Array.isArray(consentiti) ? consentiti : []).map(String).filter(Boolean);
  if (!lista.length || !ruoliMembro) return false;
  const ha = typeof ruoliMembro.has === 'function' ? (id) => ruoliMembro.has(id) : (id) => [...ruoliMembro].map(String).includes(id);
  return lista.some(ha);
}

/** Rinominare o eliminare: chi l'ha caricato oppure un amministratore. */
export function puoModificareSuono(user, suono) {
  if (!user || !suono) return false;
  if (user.isAdmin === true) return true;
  return Boolean(user.id && suono.createdBy?.id && String(suono.createdBy.id) === String(user.id));
}

const PERMESSO_MSG = 'Solo chi l\'ha caricato o un amministratore del server può rinominarlo o eliminarlo';
const PERMESSO_VOLUME_MSG = 'Solo chi l\'ha caricato o un amministratore del server può cambiarne il volume';

/** Per i client: niente percorsi dei file. */
export function riassuntoSuono(s) {
  return {
    id: s.id,
    name: s.name,
    duration: s.duration,
    by: s.createdBy?.name ?? null,
    byId: s.createdBy?.id ?? null,
    createdAt: s.createdAt,
    volume: s.volume ?? 1,
  };
}

// ---------- durata ----------
/** Uscita di `ffprobe -show_entries format=duration -of default=nw=1:nk=1`: secondi o null. */
export function durataDaFfprobe(testo) {
  const t = String(testo ?? '').trim().split(/\s+/)[0];
  const n = Number(t);
  return t && Number.isFinite(n) && n > 0 ? n : null;
}

/** Riga «Duration: 00:00:02.50» di `ffmpeg -i`: secondi o null (anche per «N/A»). */
export function durataDaFfmpeg(testo) {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(String(testo ?? ''));
  if (!m) return null;
  const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return s > 0 ? s : null;
}

export const argomentiFfprobe = (file) => ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file];

/**
 * Conversione: al massimo maxSec + 0,3 s (poi si ricontrolla la durata), niente video né metadati,
 * volume normalizzato, Ogg/Opus 48 kHz stereo 96 kbit/s con pacchetti da 20 ms (come vuole Discord).
 */
export function argomentiFfmpeg({ input, output, maxSec = MAX_SECONDI }) {
  return [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
    '-i', input,
    '-t', String(maxSec + 0.3),
    '-vn', '-map_metadata', '-1',
    '-af', 'loudnorm=I=-16:TP=-1.5',
    '-ar', '48000', '-ac', '2',
    '-c:a', 'libopus', '-b:a', '96k', '-frame_duration', '20',
    '-f', 'ogg', output,
  ];
}

/**
 * Copia del suono con il volume cambiato, partendo dal file già normalizzato (che resta com'è: niente
 * perdite che si sommano a ogni modifica). Sopra il 100% un limitatore a -1,5 dBTP evita la distorsione.
 */
export function argomentiVolume({ input, output, volume }) {
  const v = Number(volume).toFixed(2);
  const filtro = volume > 1 ? `volume=${v},alimiter=limit=0.84:level=false` : `volume=${v}`;
  return [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
    '-i', input,
    '-vn', '-map_metadata', '-1',
    '-af', filtro,
    '-ar', '48000', '-ac', '2',
    '-c:a', 'libopus', '-b:a', '96k', '-frame_duration', '20',
    '-f', 'ogg', output,
  ];
}

/** Avvia un programma e raccoglie l'uscita (con tempo massimo). ENOENT = programma assente. */
export function esegui(cmd, args, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let finito = false;
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      if (finito) return;
      finito = true;
      p.kill('SIGKILL');
      reject(new SoundError('Conversione troppo lenta: riprova con un file più piccolo', 'formato'));
    }, timeoutMs);
    p.stdout.on('data', (d) => { if (out.length < 65_536) out += d; });
    p.stderr.on('data', (d) => { if (err.length < 65_536) err += d; });
    p.on('error', (e) => {
      if (finito) return;
      finito = true;
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      if (finito) return;
      finito = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

/** Durata di un file: ffprobe; se manca o non sa dirla, la riga «Duration:» di ffmpeg. null = non si sa. */
export async function misuraDurata(file, { ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', timeoutMs = TIMEOUT_MS } = {}) {
  try {
    const r = await esegui(ffprobe, argomentiFfprobe(file), { timeoutMs });
    const d = r.code === 0 ? durataDaFfprobe(r.stdout) : null;
    if (d !== null) return d;
  } catch (err) {
    if (err instanceof SoundError) throw err;
    // ffprobe assente: si prova con ffmpeg
  }
  const r = await esegui(ffmpeg, ['-hide_banner', '-nostdin', '-i', file], { timeoutMs });
  return durataDaFfmpeg(r.stderr);
}

/** d = durata misurata (null = non nota prima della conversione: si sa solo che è oltre il massimo). */
const troppoLungo = (d, maxSec) =>
  new SoundError(`Suono troppo lungo (${d === null ? 'più di ' + maxSec : d.toFixed(1).replace('.', ',')} s): massimo ${maxSec} secondi`, 'troppo_lungo');

/**
 * Convertitore vero (ffprobe + ffmpeg). converti(buffer, { out, maxSec }) scrive il file Ogg/Opus in
 * `out` e restituisce { duration }. Il file caricato va in una cartella temporanea (in Docker /tmp è in RAM).
 */
export function creaConvertitore({ ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', tmpDir = os.tmpdir(), timeoutMs = TIMEOUT_MS } = {}) {
  return async function converti(buffer, { out, maxSec = MAX_SECONDI }) {
    const t0 = Date.now();
    const resto = () => Math.max(1000, timeoutMs - (Date.now() - t0));
    const input = path.join(tmpDir, `suono-${randomUUID()}.in`);
    try {
      await fs.promises.writeFile(input, buffer);
      const prima = await misuraDurata(input, { ffmpeg, ffprobe, timeoutMs: resto() });
      if (prima !== null && prima > maxSec + TOLLERANZA_S) throw troppoLungo(prima, maxSec);
      let r;
      try {
        r = await esegui(ffmpeg, argomentiFfmpeg({ input, output: out, maxSec }), { timeoutMs: resto() });
      } catch (err) {
        if (err instanceof SoundError) throw err;
        throw new SoundError('ffmpeg non disponibile sul server', 'altro');
      }
      if (r.code !== 0) {
        console.warn(`[suoni] ffmpeg (codice ${r.code}): ${r.stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}`);
        throw new SoundError('Formato non riconosciuto', 'formato');
      }
      // Ricontrollo sul file convertito: un file senza durata nota viene tagliato a maxSec + 0,3 s
      const dopo = await misuraDurata(out, { ffmpeg, ffprobe, timeoutMs: resto() });
      if (dopo === null || dopo < 0.05) throw new SoundError('Formato non riconosciuto', 'formato');
      if (dopo > maxSec + TOLLERANZA_S) throw troppoLungo(prima, maxSec);
      return { duration: Math.round(dopo * 100) / 100 };
    } catch (err) {
      await fs.promises.rm(out, { force: true }).catch(() => {});
      throw err;
    } finally {
      await fs.promises.rm(input, { force: true }).catch(() => {});
    }
  };
}

/** volumizza(input, out, volume): scrive in `out` la copia Ogg/Opus del suono con il volume scelto. */
export function creaVolumizzatore({ ffmpeg = 'ffmpeg', timeoutMs = TIMEOUT_MS } = {}) {
  return async function volumizza(input, out, volume) {
    let r;
    try {
      r = await esegui(ffmpeg, argomentiVolume({ input, output: out, volume }), { timeoutMs });
    } catch (err) {
      await fs.promises.rm(out, { force: true }).catch(() => {});
      if (err instanceof SoundError) throw err;
      throw new SoundError('ffmpeg non disponibile sul server', 'altro');
    }
    if (r.code !== 0) {
      await fs.promises.rm(out, { force: true }).catch(() => {});
      console.warn(`[suoni] ffmpeg volume (codice ${r.code}): ${r.stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}`);
      throw new SoundError('Non riesco a cambiare il volume del suono', 'altro');
    }
  };
}

// ---------- biglietti per il caricamento ----------
/**
 * Biglietti monouso: il WebSocket (utente già verificato) ne chiede uno, la richiesta HTTP del
 * caricamento lo consuma. Validi ttlMs, legati a server e utente.
 */
export function creaBiglietti({ ttlMs = BIGLIETTO_MS, now = Date.now } = {}) {
  const biglietti = new Map(); // ticket -> { guildId, user, scade }
  const pulisci = () => {
    const t = now();
    for (const [k, v] of biglietti) if (v.scade <= t) biglietti.delete(k);
  };
  return {
    crea(guildId, user) {
      pulisci();
      const ticket = randomUUID();
      biglietti.set(ticket, { guildId: String(guildId), user: { id: String(user.id), name: String(user.name ?? '') }, scade: now() + ttlMs });
      return ticket;
    },
    /** Consuma il biglietto: { guildId, user } oppure null (sconosciuto, già usato o scaduto). */
    usa(ticket) {
      const b = typeof ticket === 'string' ? biglietti.get(ticket) : null;
      if (!b) return null;
      biglietti.delete(ticket);
      if (b.scade <= now()) return null;
      return { guildId: b.guildId, user: b.user };
    },
    get size() {
      pulisci();
      return biglietti.size;
    },
  };
}

// ---------- anti-spam ----------
/**
 * Limitatore: un suono ogni perUtenteMs per utente, al massimo maxFinestra suoni in finestraMs per
 * server e al massimo maxPerPersona suoni in personaFinestraMs (finestra scorrevole) per persona.
 * attesa(guildId, userId) → 0 se può suonare (e lo conta), altrimenti i ms da aspettare.
 * prova(guildId, userId) → true se può suonare (e lo conta): come attesa, ma booleano.
 */
export function creaLimitatore({
  perUtenteMs = 1500, finestraMs = 10_000, maxFinestra = 6,
  maxPerPersona = 10, personaFinestraMs = 60_000, now = Date.now,
} = {}) {
  const recentiPersona = new Map(); // `${guild}:${user}` -> [ms] (ultimi suoni, in ordine)
  const recenti = new Map(); // guild -> [ms]
  const attesa = (guildId, userId) => {
    const t = now();
    const k = `${guildId}:${userId}`;
    const mie = (recentiPersona.get(k) ?? []).filter((x) => t - x < personaFinestraMs);
    const lista = (recenti.get(guildId) ?? []).filter((x) => t - x < finestraMs);
    if (mie.length) recentiPersona.set(k, mie); else recentiPersona.delete(k);
    if (lista.length) recenti.set(guildId, lista); else recenti.delete(guildId);
    let aspetta = 0;
    if (mie.length) aspetta = Math.max(aspetta, perUtenteMs - (t - mie.at(-1)));
    if (mie.length >= maxPerPersona) aspetta = Math.max(aspetta, personaFinestraMs - (t - mie[mie.length - maxPerPersona]));
    if (lista.length >= maxFinestra) aspetta = Math.max(aspetta, finestraMs - (t - lista[lista.length - maxFinestra]));
    if (aspetta > 0) return aspetta;
    mie.push(t);
    lista.push(t);
    recentiPersona.set(k, mie);
    recenti.set(guildId, lista);
    if (recentiPersona.size > 500) {
      for (const [kk, v] of recentiPersona) if (t - v.at(-1) >= personaFinestraMs) recentiPersona.delete(kk);
    }
    return 0;
  };
  return { attesa, prova: (guildId, userId) => attesa(guildId, userId) === 0 };
}

export const PIANO_MSG = 'Piano con i suoni';
/** «Piano con i suoni: riprova tra 23 s» (secondi arrotondati per eccesso). */
export const pianoMsg = (ms) => (ms > 0 ? `${PIANO_MSG}: riprova tra ${Math.ceil(ms / 1000)} s` : PIANO_MSG);

// ---------- libreria ----------
export class SoundLibrary {
  constructor({ dir, now = Date.now, maxSec = MAX_SECONDI, volumizza = creaVolumizzatore() }) {
    this.dir = dir;
    this.now = now;
    this.maxSec = maxSec;
    this.volumizza = volumizza; // (input, out, volume) => Promise: copia del suono col volume cambiato
    this.cache = new Map(); // guildId -> array di suoni
    this.writing = new Map(); // guildId -> Promise dell'ultima scrittura
    this.coda = new Map(); // guildId -> Promise dell'ultimo caricamento (uno alla volta per server)
    this.seq = 0;
  }

  fileFor(guildId) {
    return path.join(this.dir, `${PREFISSO}${nomeSicuro(guildId)}.json`);
  }

  cartella(guildId) {
    return path.join(this.dir, 'suoni', nomeSicuro(guildId));
  }

  /** Percorso del file audio di un suono (quello normalizzato, volume 100%). */
  percorso(guildId, suono) {
    return path.join(this.cartella(guildId), suono.file);
  }

  /** File da suonare: la copia col volume cambiato se c'è, altrimenti quello normalizzato. */
  daSuonare(guildId, suono) {
    if (suono.fileVol && (suono.volume ?? 1) !== 1) return path.join(this.cartella(guildId), suono.fileVol);
    return this.percorso(guildId, suono);
  }

  /** Mette in fila un lavoro con ffmpeg: uno alla volta per server (caricamenti e cambi di volume). */
  inCoda(guildId, lavoro) {
    const prev = this.coda.get(guildId) ?? Promise.resolve();
    const p = prev.catch(() => {}).then(lavoro);
    this.coda.set(guildId, p);
    p.finally(() => { if (this.coda.get(guildId) === p) this.coda.delete(guildId); }).catch(() => {});
    return p;
  }

  /** Suoni di un server (letti dal disco la prima volta). Indice rovinato: messo da parte. File mancanti: tolti. */
  all(guildId) {
    let list = this.cache.get(guildId);
    if (list) return list;
    list = [];
    const file = this.fileFor(guildId);
    let tolti = 0;
    let sistemati = 0;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data?.suoni)) {
        for (const s of data.suoni) {
          if (!s || typeof s.id !== 'string' || typeof s.name !== 'string' || typeof s.file !== 'string' || !FILE_VALIDO.test(s.file)) continue;
          if (!fs.existsSync(path.join(this.cartella(guildId), s.file))) {
            tolti++;
            continue;
          }
          // Volume: suoni vecchi senza campo = 1; copia col volume sparita = si torna a 1 (l'interfaccia dice il vero)
          let vol = 1;
          try { vol = s.volume === undefined ? 1 : volumeValido(s.volume); } catch { vol = 1; }
          const copiaOk = typeof s.fileVol === 'string' && FILE_VALIDO.test(s.fileVol) && fs.existsSync(path.join(this.cartella(guildId), s.fileVol));
          if (vol !== 1 && !copiaOk) {
            vol = 1;
            sistemati++;
          }
          s.volume = vol;
          s.fileVol = vol !== 1 ? s.fileVol : null;
          list.push(s);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[suoni] Indice ${file} non leggibile: ${err.message}. Lo tengo da parte e parto da zero`);
        try { fs.renameSync(file, `${file}.rovinato-${Date.now()}`); } catch { /* niente */ }
      }
    }
    this.cache.set(guildId, list);
    if (tolti) console.warn(`[suoni] ${guildId}: ${tolti} suoni senza file tolti dall'indice`);
    if (sistemati) console.warn(`[suoni] ${guildId}: ${sistemati} suoni senza la copia col volume, tornati al 100%`);
    if (tolti || sistemati) this.persist(guildId).catch(() => {});
    return list;
  }

  list(guildId) {
    return this.all(guildId).map(riassuntoSuono);
  }

  get(guildId, id) {
    return this.all(guildId).find((s) => s.id === id) ?? null;
  }

  trova(guildId, id) {
    const s = this.get(guildId, id);
    if (!s) throw new SoundError('Suono non trovato (forse è stato eliminato)', 'non_trovato');
    return s;
  }

  /** Scrittura atomica, una alla volta per server. */
  persist(guildId) {
    const text = JSON.stringify({ v: 1, guildId: String(guildId), suoni: this.all(guildId) });
    const prev = this.writing.get(guildId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const file = this.fileFor(guildId);
      const tmp = `${file}.${process.pid}-${++this.seq}.tmp`;
      try {
        await fs.promises.mkdir(this.dir, { recursive: true });
        await fs.promises.writeFile(tmp, text);
        await fs.promises.rename(tmp, file);
      } catch (err) {
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
        console.error(`[suoni] Salvataggio non riuscito (${file}): ${err.message}`);
        throw new SoundError('Non riesco a salvare i suoni sul disco', 'disco');
      }
    });
    this.writing.set(guildId, next);
    return next;
  }

  /** Controlli prima della conversione: nome valido e libero, libreria non piena. */
  controllaNuovo(guildId, name) {
    const nome = nomeValido(name);
    const list = this.all(guildId);
    if (list.some((s) => stessoNome(s.name, nome))) throw new SoundError('Nome già usato', 'nome_usato');
    if (list.length >= SUONI_MAX) throw new SoundError(`Soundbar piena (massimo ${SUONI_MAX} suoni): eliminane qualcuno`, 'pieno');
    return nome;
  }

  /**
   * Carica un suono: controlli, conversione (converti(buffer, { out, maxSec }) → { duration }),
   * rename atomico del file e voce nell'indice. Un caricamento alla volta per server.
   * Restituisce il riassunto del suono.
   */
  carica(guildId, { name, user, buffer, converti, volume = 1 }) {
    return this.inCoda(guildId, () => this.caricaOra(guildId, { name, user, buffer, converti, volume }));
  }

  async caricaOra(guildId, { name, user, buffer, converti, volume = 1 }) {
    const nome = this.controllaNuovo(guildId, name);
    if (!buffer?.length) throw new SoundError('File vuoto', 'formato');
    const id = randomUUID();
    const fileName = `${id}.ogg`;
    const dir = this.cartella(guildId);
    const finale = path.join(dir, fileName);
    const tmp = `${finale}.tmp`;
    try {
      await fs.promises.mkdir(dir, { recursive: true });
    } catch (err) {
      console.error(`[suoni] Cartella ${dir}: ${err.message}`);
      throw new SoundError('Non riesco a salvare i suoni sul disco', 'disco');
    }
    let duration;
    try {
      ({ duration } = await converti(buffer, { out: tmp, maxSec: this.maxSec }));
      await fs.promises.rename(tmp, finale);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      if (err instanceof SoundError) throw err;
      console.error(`[suoni] Caricamento non riuscito: ${err.message}`);
      throw new SoundError(err.code === 'ENOSPC' ? 'Disco pieno: non posso salvare il suono' : 'Non riesco a salvare il suono sul disco', 'disco');
    }
    // Volume scelto al caricamento: se la copia non riesce il suono resta al 100% (meglio che perderlo)
    let vol = 1;
    try { vol = volumeValido(volume); } catch { vol = 1; }
    let fileVol = null;
    if (vol !== 1) {
      try {
        fileVol = await this.creaCopia(dir, finale, id, vol);
      } catch (err) {
        console.warn(`[suoni] Volume al caricamento non applicato: ${err.message}`);
        vol = 1;
      }
    }
    const s = {
      id,
      name: nome,
      file: fileName,
      duration,
      createdBy: user ? { id: String(user.id), name: String(user.name ?? '') } : null,
      createdAt: new Date(this.now()).toISOString(),
      volume: vol,
      fileVol,
    };
    const list = this.all(guildId);
    list.push(s);
    try {
      await this.persist(guildId);
    } catch (err) {
      list.splice(list.indexOf(s), 1);
      await fs.promises.rm(finale, { force: true }).catch(() => {});
      if (fileVol) await fs.promises.rm(path.join(dir, fileVol), { force: true }).catch(() => {});
      throw err;
    }
    return riassuntoSuono(s);
  }

  async rinomina(guildId, { id, name, user }) {
    const s = this.trova(guildId, id);
    if (!puoModificareSuono(user, s)) throw new SoundError(PERMESSO_MSG, 'permesso');
    const nome = nomeValido(name);
    if (this.all(guildId).some((x) => x !== s && stessoNome(x.name, nome))) throw new SoundError('Nome già usato', 'nome_usato');
    const prima = s.name;
    s.name = nome;
    try {
      await this.persist(guildId);
    } catch (err) {
      s.name = prima;
      throw err;
    }
    return riassuntoSuono(s);
  }

  /** Copia del file normalizzato col volume `vol`: `<id>-v<percento>.ogg` (scritta in .tmp e poi rinominata). */
  async creaCopia(dir, base, id, vol) {
    const nome = `${id}-v${Math.round(vol * 100)}.ogg`;
    const finale = path.join(dir, nome);
    const tmp = `${finale}.tmp`;
    try {
      await this.volumizza(base, tmp, vol);
      await fs.promises.rename(tmp, finale);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      if (err instanceof SoundError) throw err;
      throw new SoundError('Non riesco a salvare il suono sul disco', 'disco');
    }
    return nome;
  }

  /**
   * Volume di un suono (chi l'ha caricato o admin). 1 = file normalizzato; altrimenti una copia fatta
   * con ffmpeg dal file normalizzato. Una modifica alla volta per server (in fila con i caricamenti).
   */
  async regolaVolume(guildId, { id, volume, user }) {
    const s = this.trova(guildId, id);
    if (!puoModificareSuono(user, s)) throw new SoundError(PERMESSO_VOLUME_MSG, 'permesso');
    const vol = volumeValido(volume);
    return this.inCoda(guildId, async () => {
      const list = this.all(guildId);
      const via = () => new SoundError('Suono non trovato (forse è stato eliminato)', 'non_trovato');
      if (!list.includes(s)) throw via();
      if ((s.volume ?? 1) === vol) return riassuntoSuono(s);
      const dir = this.cartella(guildId);
      const nuovo = vol === 1 ? null : await this.creaCopia(dir, this.percorso(guildId, s), s.id, vol);
      if (!list.includes(s)) {
        // eliminato mentre ffmpeg lavorava
        if (nuovo) await fs.promises.rm(path.join(dir, nuovo), { force: true }).catch(() => {});
        throw via();
      }
      const prima = { volume: s.volume ?? 1, fileVol: s.fileVol ?? null };
      s.volume = vol;
      s.fileVol = nuovo;
      try {
        await this.persist(guildId);
      } catch (err) {
        Object.assign(s, prima);
        if (nuovo && nuovo !== prima.fileVol) await fs.promises.rm(path.join(dir, nuovo), { force: true }).catch(() => {});
        throw err;
      }
      if (prima.fileVol && prima.fileVol !== nuovo) await fs.promises.rm(path.join(dir, prima.fileVol), { force: true }).catch(() => {});
      return riassuntoSuono(s);
    });
  }

  async elimina(guildId, { id, user }) {
    const list = this.all(guildId);
    const s = this.trova(guildId, id);
    if (!puoModificareSuono(user, s)) throw new SoundError(PERMESSO_MSG, 'permesso');
    const i = list.indexOf(s);
    list.splice(i, 1);
    try {
      await this.persist(guildId);
    } catch (err) {
      list.splice(i, 0, s);
      throw err;
    }
    await fs.promises.rm(this.percorso(guildId, s), { force: true }).catch(() => {});
    if (s.fileVol) await fs.promises.rm(path.join(this.cartella(guildId), s.fileVol), { force: true }).catch(() => {});
    return riassuntoSuono(s);
  }

  /**
   * Pulizia all'avvio: in ogni cartella dei suoni toglie i .tmp rimasti e i .ogg che non sono
   * nell'indice. Restituisce quanti file ha tolto.
   */
  pulisci() {
    const base = path.join(this.dir, 'suoni');
    let cartelle;
    try {
      cartelle = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return 0;
    }
    let tolti = 0;
    for (const nomeCartella of cartelle) {
      const dir = path.join(base, nomeCartella);
      // L'indice si cerca col nome della cartella (= nome sicuro del guildId)
      const noti = new Set(this.all(nomeCartella).flatMap((s) => (s.fileVol ? [s.file, s.fileVol] : [s.file])));
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.tmp') || (f.endsWith('.ogg') && !noti.has(f))) {
          try {
            fs.rmSync(path.join(dir, f), { force: true });
            tolti++;
          } catch { /* niente */ }
        }
      }
    }
    return tolti;
  }
}

// ---------- caricamento via HTTP ----------
const STATO_HTTP = { permesso: 403, troppo_grande: 413, disco: 500, altro: 500 };

/**
 * Route POST /api/suoni: corpo binario (il file), header X-Biglietto (dal WebSocket), X-Nome
 * (encodeURIComponent) e facoltativo X-Volume (es. 0.8; assente o non valido = 1). Risposta { ok, suono } oppure { ok: false, error, code }.
 * onCaricato(guildId, suono, user) dopo un caricamento riuscito (avviso e nuovo elenco ai client).
 */
export function creaRouteSuoni({ library, biglietti, converti, maxMb = MAX_MB, onCaricato = null }) {
  const router = express.Router();
  const limite = Math.round(maxMb * 1024 * 1024);
  const errore = (res, status, error, code) => res.status(status).json({ ok: false, error, code });
  router.post('/api/suoni', express.raw({ type: () => true, limit: limite }), async (req, res) => {
    const b = biglietti.usa(req.get('X-Biglietto') || '');
    if (!b) return errore(res, 401, 'Permesso scaduto: riprova a caricare', 'permesso');
    let name = '';
    try {
      name = decodeURIComponent(req.get('X-Nome') || '');
    } catch {
      return errore(res, 400, 'Nome non valido', 'nome_vuoto');
    }
    const buffer = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buffer?.length) return errore(res, 400, 'File vuoto', 'formato');
    const t0 = Date.now();
    try {
      const volume = volumeDaHeader(req.get('X-Volume'));
      const suono = await library.carica(b.guildId, { name, user: b.user, buffer, converti, volume });
      console.log(`[suoni] ${b.user.name} (${b.guildId}) ha caricato «${suono.name}» (${suono.duration} s, ${(buffer.length / 1024).toFixed(0)} KB) in ${Date.now() - t0} ms`);
      res.json({ ok: true, suono });
      try { onCaricato?.(b.guildId, suono, b.user); } catch { /* solo avvisi */ }
    } catch (err) {
      if (err instanceof SoundError) return errore(res, STATO_HTTP[err.code] ?? 400, err.message, err.code);
      console.error('[suoni] caricamento:', err.message);
      return errore(res, 500, 'Errore interno', 'altro');
    }
  });
  // Corpo oltre il limite (express.raw) o rovinato: risposta JSON chiara
  router.use('/api/suoni', (err, _req, res, _next) => {
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      return errore(res, 413, `File troppo grande (massimo ${String(maxMb).replace('.', ',')} MB)`, 'troppo_grande');
    }
    return errore(res, err?.status || 400, 'Caricamento non riuscito', 'altro');
  });
  return router;
}
