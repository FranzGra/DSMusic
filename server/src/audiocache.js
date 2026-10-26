// Cache audio in RAM (mai su disco: meno scritture, utile su memorie flash che si consumano).
// Mentre suona un brano si scaricano in memoria il file audio del brano in corso e quello del
// prossimo, così partenza, spostamento nel brano, cambio di volume e «precedente» non passano dalla
// rete. ffmpeg legge la copia da un piccolo server HTTP solo locale (127.0.0.1, con Range), quindi
// lo spostamento è immediato come con il link vero.
// Limiti: budget in MB, numero massimo di brani, durata massima; le voci usate meno di recente
// escono per prime (LRU), tranne quelle protette (brano in corso e prossimo).
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const MB = 1024 * 1024;
const BLOCCO_BYTES = 4 * MB; // richieste Range da 4 MB (come fa yt-dlp per non essere rallentati)
const ATTESA_BLOCCO_MS = 60_000;
const MAX_VOCE_BYTES = 32 * MB; // ~20 minuti a 160 kbps (il formato audio più pesante di YouTube)

export class AudioCache {
  /**
   * @param {{ budgetMb?: number, maxBrani?: number, maxSec?: number, fetchFn?: typeof fetch, log?: (s: string) => void }} o
   */
  constructor({ budgetMb = 96, maxBrani = 8, maxSec = 20 * 60, fetchFn = fetch, log = (s) => console.log(s) } = {}) {
    this.budget = Math.max(0, budgetMb) * MB;
    this.maxBrani = Math.max(1, maxBrani);
    this.maxSec = maxSec;
    this.maxVoce = Math.min(this.budget, MAX_VOCE_BYTES);
    this.fetchFn = fetchFn;
    this.log = log;
    /** @type {Map<string, { key: string, buf: Buffer, size: number, acodec: string|null, mime: string, token: string }>} */
    this.voci = new Map(); // in ordine d'uso: la prima è la meno recente
    this.perToken = new Map(); // token dell'URL locale → chiave
    this.coda = []; // { key, info }
    this.inCorso = null; // { key, ctrl, size }
    this.protette = new Map(); // proprietario (guild) → Set di chiavi da non togliere
    this.server = null;
    this.porta = null;
    this.lavoro = null; // promessa del ciclo di download in corso
    this.statistiche = { scaricati: 0, daCache: 0, scartati: 0 };
  }

  get attiva() {
    return this.budget > 0;
  }

  /** Byte occupati (voci complete + download in corso). */
  usati() {
    let n = this.inCorso?.size || 0;
    for (const v of this.voci.values()) n += v.size;
    return n;
  }

  /** Si può mettere in cache? Restituisce { ok: true } oppure { ok: false, motivo }. */
  idoneo(info, { durata = null, live = false } = {}) {
    if (!this.attiva) return { ok: false, motivo: 'cache spenta' };
    if (!info?.url || !info.direct) return { ok: false, motivo: 'link non diretto' };
    if (live) return { ok: false, motivo: 'diretta' };
    if (info.protocol && !/^https?$/.test(info.protocol)) return { ok: false, motivo: 'flusso a frammenti' };
    if (/\.m3u8|manifest/i.test(info.url)) return { ok: false, motivo: 'flusso a frammenti' };
    if (Number.isFinite(durata) && durata > this.maxSec) return { ok: false, motivo: 'troppo lungo' };
    if (info.size && info.size > this.maxVoce) return { ok: false, motivo: 'troppo grande' };
    return { ok: true };
  }

  ha(key) {
    return this.voci.has(key);
  }

  /** Il brano in corso e il prossimo di un server: non escono dalla cache per fare spazio. */
  proteggi(proprietario, chiavi) {
    const s = new Set(chiavi.filter(Boolean));
    if (s.size) this.protette.set(proprietario, s);
    else this.protette.delete(proprietario);
  }

  protetta(key) {
    for (const s of this.protette.values()) if (s.has(key)) return true;
    return false;
  }

  /**
   * Mette in coda il download di un brano (uno alla volta, nell'ordine di arrivo).
   * Restituisce true se il download è stato accodato (o è già in corso / già in cache).
   */
  scarica(key, info, opzioni = {}) {
    if (!key) return false;
    if (this.voci.has(key) || this.inCorso?.key === key || this.coda.some((j) => j.key === key)) return true;
    const v = this.idoneo(info, opzioni);
    if (!v.ok) return false;
    this.coda.push({ key, info: { url: info.url, headers: info.headers || {}, acodec: info.acodec || null, size: info.size || null } });
    if (!this.lavoro) this.lavoro = this.ciclo().finally(() => { this.lavoro = null; });
    return true;
  }

  /** Attende la fine dei download in coda (per i test e le misure). */
  async attesa() {
    while (this.lavoro) await this.lavoro;
  }

  async ciclo() {
    while (this.coda.length) {
      const job = this.coda.shift();
      const t0 = Date.now();
      try {
        const ok = await this.scaricaOra(job);
        if (ok) {
          this.statistiche.scaricati++;
          const v = this.voci.get(job.key);
          this.log(`[cache] in RAM: ${(v.size / MB).toFixed(1)} MB in ${Date.now() - t0} ms · totale ${(this.usati() / MB).toFixed(1)}/${(this.budget / MB).toFixed(0)} MB, ${this.voci.size} brani`);
        }
      } catch (err) {
        if (err?.name !== 'AbortError') this.log(`[cache] download non riuscito: ${String(err?.message || err).slice(0, 120)}`);
      } finally {
        this.inCorso = null;
      }
    }
  }

  /** Fa spazio per `bytes` togliendo le voci meno usate (non protette). false se non si può. */
  faiSpazio(bytes) {
    if (bytes > this.maxVoce) return false;
    for (const [key] of this.voci) {
      if (this.usati() + bytes <= this.budget && this.voci.size < this.maxBrani) break;
      if (this.protetta(key)) continue;
      this.togli(key);
    }
    return this.usati() + bytes <= this.budget && this.voci.size < this.maxBrani;
  }

  async richiesta(url, headers, inizio, fine, signal) {
    return this.fetchFn(url, {
      headers: { ...headers, Range: `bytes=${inizio}-${fine}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(ATTESA_BLOCCO_MS)]),
    });
  }

  async scaricaOra({ key, info }) {
    const ctrl = new AbortController();
    this.inCorso = { key, ctrl, size: 0 };
    let r = await this.richiesta(info.url, info.headers, 0, BLOCCO_BYTES - 1, ctrl.signal);
    if (r.status !== 200 && r.status !== 206) throw new Error(`HTTP ${r.status}`);
    const tot = r.status === 206
      ? Number(/\/(\d+)\s*$/.exec(r.headers.get('content-range') || '')?.[1])
      : Number(r.headers.get('content-length'));
    if (!Number.isFinite(tot) || tot <= 0) {
      await r.body?.cancel();
      throw new Error('dimensione sconosciuta');
    }
    if (tot > this.maxVoce || !this.faiSpazio(tot)) {
      await r.body?.cancel();
      this.statistiche.scartati++;
      this.log(`[cache] non entra: ${(tot / MB).toFixed(1)} MB (budget ${(this.budget / MB).toFixed(0)} MB, ${this.voci.size} brani)`);
      return false;
    }
    this.inCorso.size = tot;
    const buf = Buffer.allocUnsafe(tot);
    let pos = 0;
    for (;;) {
      for await (const parte of r.body) {
        if (pos + parte.length > tot) throw new Error('il file è più lungo del previsto');
        buf.set(parte, pos);
        pos += parte.length;
      }
      if (pos >= tot || r.status === 200) break;
      r = await this.richiesta(info.url, info.headers, pos, Math.min(tot, pos + BLOCCO_BYTES) - 1, ctrl.signal);
      if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
    }
    if (pos !== tot) throw new Error(`file incompleto (${pos}/${tot} byte)`);
    if (this.inCorso?.ctrl !== ctrl) return false; // svuotata nel frattempo
    const token = randomUUID();
    const mime = /mime=([^&]+)/.exec(info.url)?.[1] ? decodeURIComponent(/mime=([^&]+)/.exec(info.url)[1]) : 'application/octet-stream';
    this.voci.set(key, { key, buf, size: tot, acodec: info.acodec, mime, token });
    this.perToken.set(token, key);
    return true;
  }

  /**
   * Sorgente per ffmpeg se il brano è in cache: { url (locale), headers: {}, acodec }, altrimenti null.
   * Conta come uso recente (LRU).
   */
  async sorgente(key) {
    const v = this.voci.get(key);
    if (!v) return null;
    this.voci.delete(key);
    this.voci.set(key, v);
    await this.avviaServer();
    this.statistiche.daCache++;
    return { url: `http://127.0.0.1:${this.porta}/c/${v.token}`, headers: {}, acodec: v.acodec, direct: true };
  }

  togli(key) {
    const v = this.voci.get(key);
    if (!v) return;
    this.voci.delete(key);
    this.perToken.delete(v.token);
  }

  /** Libera tutto: download annullati, voci tolte, server locale chiuso. */
  svuota() {
    const n = this.voci.size;
    const mb = this.usati() / MB;
    this.coda.length = 0;
    this.inCorso?.ctrl.abort();
    this.inCorso = null;
    this.voci.clear();
    this.perToken.clear();
    if (this.server) {
      this.server.closeAllConnections?.();
      this.server.close();
      this.server = null;
      this.porta = null;
    }
    return { brani: n, mb };
  }

  stato() {
    return {
      brani: this.voci.size,
      mb: +(this.usati() / MB).toFixed(1),
      budgetMb: this.budget / MB,
      inCoda: this.coda.length + (this.inCorso ? 1 : 0),
      ...this.statistiche,
    };
  }

  // ---------- server HTTP locale (solo 127.0.0.1) ----------
  avviaServer() {
    if (this.porta) return Promise.resolve();
    if (this.avvio) return this.avvio;
    this.avvio = new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => this.servi(req, res));
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => {
        this.server = s;
        this.porta = s.address().port;
        s.unref(); // non tiene vivo il processo
        resolve();
      });
    }).finally(() => { this.avvio = null; });
    return this.avvio;
  }

  servi(req, res) {
    const m = /^\/c\/([\w-]+)$/.exec(req.url || '');
    const key = m && this.perToken.get(m[1]);
    const v = key && this.voci.get(key);
    if (!v || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end();
      return;
    }
    res.on('error', () => {});
    const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let inizio = 0;
    let fine = v.size - 1;
    if (r && (r[1] || r[2])) {
      if (r[1]) {
        inizio = Number(r[1]);
        if (r[2]) fine = Math.min(fine, Number(r[2]));
      } else {
        inizio = Math.max(0, v.size - Number(r[2])); // bytes=-N: gli ultimi N byte
      }
      if (inizio > fine || inizio >= v.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${v.size}` }).end();
        return;
      }
    }
    const parziale = Boolean(r && (r[1] || r[2]));
    res.writeHead(parziale ? 206 : 200, {
      'Content-Type': v.mime,
      'Accept-Ranges': 'bytes',
      'Content-Length': fine - inizio + 1,
      ...(parziale ? { 'Content-Range': `bytes ${inizio}-${fine}/${v.size}` } : {}),
    });
    if (req.method === 'HEAD') res.end();
    else res.end(v.buf.subarray(inizio, fine + 1)); // nessuna copia: una vista sul buffer
  }
}
