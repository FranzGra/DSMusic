// Salvataggio della coda su disco: un file JSON per server (guild), così sopravvive ai riavvii.
// Scrittura ritardata (tante modifiche di fila = una sola scrittura) e atomica (file temporaneo + rename):
// se il processo muore a metà resta il file vecchio, mai uno a metà.
import fs from 'node:fs';
import path from 'node:path';

const PREFISSO = 'coda-';
const nomeSicuro = (guildId) => String(guildId).replace(/[^\w-]/g, '_');

export class QueueStore {
  constructor({ dir, delayMs = 1000 }) {
    this.dir = dir;
    this.delayMs = delayMs;
    this.pending = new Map(); // guildId -> testo JSON da scrivere
    this.timers = new Map(); // guildId -> timer della scrittura ritardata
    this.lastWritten = new Map(); // guildId -> ultimo testo scritto (evita scritture uguali)
    this.writing = new Map(); // guildId -> Promise della scrittura in corso (una alla volta)
    this.closed = false;
    this.seq = 0; // nomi diversi per i file temporanei
    this.latest = new Map(); // guildId -> ultimo testo chiesto (anche se la scrittura è in corso)
  }

  fileFor(guildId) {
    return path.join(this.dir, `${PREFISSO}${nomeSicuro(guildId)}.json`);
  }

  /** Legge tutte le code salvate. I file rovinati vengono saltati con un avviso. */
  loadAll() {
    const out = new Map();
    let files;
    try {
      files = fs.readdirSync(this.dir);
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[coda] Non riesco a leggere ${this.dir}: ${err.message}`);
      return out;
    }
    for (const f of files) {
      if (!f.startsWith(PREFISSO) || !f.endsWith('.json')) continue;
      const file = path.join(this.dir, f);
      try {
        const text = fs.readFileSync(file, 'utf8');
        const data = JSON.parse(text);
        const guildId = typeof data?.guildId === 'string' ? data.guildId : f.slice(PREFISSO.length, -5);
        out.set(guildId, data);
        this.lastWritten.set(guildId, text);
      } catch (err) {
        console.warn(`[coda] File ${f} non leggibile, lo salto: ${err.message}`);
      }
    }
    return out;
  }

  /** Chiede di salvare: la scrittura vera parte dopo delayMs dall'ultima modifica. */
  save(guildId, data) {
    if (this.closed) return;
    const text = JSON.stringify({ ...data, guildId: String(guildId) });
    if (text === this.lastWritten.get(guildId) && !this.pending.has(guildId)) return;
    this.pending.set(guildId, text);
    this.latest.set(guildId, text);
    clearTimeout(this.timers.get(guildId));
    const t = setTimeout(() => {
      this.timers.delete(guildId);
      void this.writeNow(guildId);
    }, this.delayMs);
    t.unref?.();
    this.timers.set(guildId, t);
  }

  /** Scrive subito (in modo asincrono) quello che è in attesa per questa guild. */
  writeNow(guildId) {
    const prev = this.writing.get(guildId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const text = this.pending.get(guildId);
      if (text === undefined) return;
      this.pending.delete(guildId);
      if (text === this.lastWritten.get(guildId)) return;
      const file = this.fileFor(guildId);
      const tmp = `${file}.${process.pid}-${++this.seq}.tmp`;
      try {
        await fs.promises.mkdir(this.dir, { recursive: true });
        await fs.promises.writeFile(tmp, text);
        // Chiuso nel frattempo: vale il salvataggio finale sincrono, questo (più vecchio) si scarta.
        if (this.closed) return void (await fs.promises.rm(tmp, { force: true }));
        await fs.promises.rename(tmp, file);
        this.lastWritten.set(guildId, text);
      } catch (err) {
        console.error(`[coda] Salvataggio non riuscito (${file}): ${err.message}`);
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
      }
    });
    this.writing.set(guildId, next);
    return next;
  }

  /** Aspetta che tutte le scritture in attesa siano finite. */
  async flush() {
    for (const [guildId, t] of this.timers) {
      clearTimeout(t);
      this.timers.delete(guildId);
      void this.writeNow(guildId);
    }
    await Promise.all([...this.writing.values()]);
  }

  /** Alla chiusura del processo: scrive subito, in modo sincrono, e da qui in poi ignora i salvataggi. */
  close() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const [guildId, text] of this.latest) {
      if (text === this.lastWritten.get(guildId)) continue;
      const file = this.fileFor(guildId);
      const tmp = `${file}.${process.pid}-${++this.seq}.tmp`;
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, file);
        this.lastWritten.set(guildId, text);
      } catch (err) {
        console.error(`[coda] Salvataggio finale non riuscito (${file}): ${err.message}`);
      }
    }
    this.pending.clear();
    this.closed = true;
  }
}
