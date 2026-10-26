// Libreria di playlist condivisa: una sola per server Discord (guild), uguale per tutti gli utenti.
// Un file JSON per server nella cartella dati (in Docker /app/data), scritto in modo atomico
// (file temporaneo + rename, come store.js): dopo un riavvio le playlist ci sono ancora.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const PREFISSO = 'playlist-';
const nomeSicuro = (guildId) => String(guildId).replace(/[^\w-]/g, '_');

export const NOME_MAX = 60;
export const PLAYLIST_MAX = 200;
export const BRANI_MAX = 1000; // brani salvati al massimo in una playlist (oltre: si tengono i primi)

/** Errore da mostrare all'utente così com'è (nome già usato, coda vuota…). */
export class PlaylistError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** Nome pulito (spazi in fila ridotti a uno) oppure errore. */
export function nomeValido(name) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!n) throw new PlaylistError('Il nome non può essere vuoto', 'nome_vuoto');
  if ([...n].length > NOME_MAX) throw new PlaylistError(`Nome troppo lungo (massimo ${NOME_MAX} caratteri)`, 'nome_lungo');
  return n;
}

const stessoNome = (a, b) => a.localeCompare(b, 'it', { sensitivity: 'base' }) === 0;

/** Solo quello che serve per ricaricare il brano (link, o testo da cercare per i brani di Spotify). */
export function branoDaSalvare(t) {
  if (!t || typeof t !== 'object' || typeof t.title !== 'string') return null;
  const url = typeof t.url === 'string' && t.url ? t.url : null;
  const query = typeof t.query === 'string' && t.query ? t.query : null;
  if (!url && !query) return null;
  return {
    title: t.title,
    author: typeof t.author === 'string' ? t.author : null,
    url,
    query,
    duration: Number.isFinite(t.duration) ? t.duration : null,
    live: t.live === true,
    thumbnail: typeof t.thumbnail === 'string' ? t.thumbnail : null,
    source: typeof t.source === 'string' ? t.source : null,
  };
}

/** Riassunto per i client: niente elenco dei brani, per tenere leggeri i messaggi. */
export function riassunto(p) {
  return {
    id: p.id,
    name: p.name,
    count: p.tracks.length,
    duration: p.tracks.reduce((s, t) => s + (Number.isFinite(t.duration) && !t.live ? t.duration : 0), 0),
    createdBy: p.createdBy,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/**
 * Chi può modificare (rinominare o eliminare) una playlist: chi l'ha creata (createdBy.id) oppure
 * un amministratore del server Discord (permesso Administrator).
 * Caricare: tutti.
 * @param {{ id: string, isAdmin?: boolean }} user
 * @param {{ createdBy?: { id?: string } | null }} playlist
 */
export function puoModificarePlaylist(user, playlist) {
  if (!user || !playlist) return false;
  if (user.isAdmin === true) return true;
  return Boolean(user.id && playlist.createdBy?.id && String(playlist.createdBy.id) === String(user.id));
}

/** Eliminare: stessa regola di puoModificarePlaylist. */
export const puoEliminarePlaylist = (user, playlist) => puoModificarePlaylist(user, playlist);

const PERMESSO_MSG = 'Solo chi l\'ha creata o un amministratore del server può rinominarla o eliminarla';

export class PlaylistLibrary {
  constructor({ dir, now = Date.now }) {
    this.dir = dir;
    this.now = now;
    this.cache = new Map(); // guildId -> array di playlist (complete, con i brani)
    this.writing = new Map(); // guildId -> Promise dell'ultima scrittura (una alla volta)
    this.seq = 0;
  }

  fileFor(guildId) {
    return path.join(this.dir, `${PREFISSO}${nomeSicuro(guildId)}.json`);
  }

  /** Playlist di un server (lette dal disco la prima volta). File rovinato: avviso e libreria vuota. */
  all(guildId) {
    let list = this.cache.get(guildId);
    if (list) return list;
    list = [];
    const file = this.fileFor(guildId);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data?.playlists)) {
        list = data.playlists.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.tracks));
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[playlist] File ${file} non leggibile: ${err.message}. Lo tengo da parte e parto da zero`);
        try { fs.renameSync(file, `${file}.rovinato-${Date.now()}`); } catch { /* niente */ }
      }
    }
    this.cache.set(guildId, list);
    return list;
  }

  list(guildId) {
    return this.all(guildId).map(riassunto);
  }

  get(guildId, id) {
    return this.all(guildId).find((p) => p.id === id) ?? null;
  }

  trova(guildId, id) {
    const p = this.get(guildId, id);
    if (!p) throw new PlaylistError('Playlist non trovata (forse è stata eliminata)', 'non_trovata');
    return p;
  }

  /** Scrittura atomica, una alla volta per server; si aspetta che sia sul disco. */
  persist(guildId) {
    const text = JSON.stringify({ v: 1, guildId: String(guildId), playlists: this.all(guildId) });
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
        console.error(`[playlist] Salvataggio non riuscito (${file}): ${err.message}`);
        throw new PlaylistError('Non riesco a salvare la libreria sul disco', 'disco');
      }
    });
    this.writing.set(guildId, next);
    return next;
  }

  /**
   * Salva dei brani con un nome. Nome già usato: errore 'nome_usato', a meno di overwrite=true
   * (allora si sostituiscono i brani di quella playlist, che tiene id e data di creazione).
   * Restituisce { playlist (riassunto), overwritten, truncated }.
   */
  async save(guildId, { name, tracks, user, overwrite = false }) {
    const nome = nomeValido(name);
    const brani = (Array.isArray(tracks) ? tracks : []).map(branoDaSalvare).filter(Boolean);
    if (!brani.length) throw new PlaylistError('La coda è vuota: niente da salvare', 'coda_vuota');
    const truncated = brani.length > BRANI_MAX;
    if (truncated) brani.length = BRANI_MAX;
    const list = this.all(guildId);
    const esistente = list.find((p) => stessoNome(p.name, nome));
    const t = new Date(this.now()).toISOString();
    if (esistente) {
      if (!overwrite) throw new PlaylistError('Nome già usato', 'nome_usato');
      // Sovrascrivere = modificare: stessa regola di rinomina ed elimina.
      if (!puoModificarePlaylist(user, esistente)) {
        const di = esistente.createdBy?.name ? ` di ${esistente.createdBy.name}` : ' di un altro utente';
        throw new PlaylistError(`Questo nome è di una playlist${di}: scegli un altro nome`, 'permesso');
      }
      const prima = { ...esistente };
      Object.assign(esistente, { name: nome, tracks: brani, updatedAt: t });
      try {
        await this.persist(guildId);
      } catch (err) {
        Object.assign(esistente, prima);
        throw err;
      }
      return { playlist: riassunto(esistente), overwritten: true, truncated };
    }
    if (list.length >= PLAYLIST_MAX) throw new PlaylistError(`Libreria piena (massimo ${PLAYLIST_MAX} playlist): eliminane qualcuna`, 'piena');
    const p = {
      id: randomUUID(),
      name: nome,
      tracks: brani,
      createdBy: user ? { id: String(user.id), name: String(user.name ?? '') } : null,
      createdAt: t,
      updatedAt: t,
    };
    list.push(p);
    try {
      await this.persist(guildId);
    } catch (err) {
      list.splice(list.indexOf(p), 1);
      throw err;
    }
    return { playlist: riassunto(p), overwritten: false, truncated };
  }

  async rename(guildId, { id, name, user }) {
    const p = this.trova(guildId, id);
    if (!puoModificarePlaylist(user, p)) throw new PlaylistError(PERMESSO_MSG, 'permesso');
    const nome = nomeValido(name);
    const altra = this.all(guildId).find((x) => x !== p && stessoNome(x.name, nome));
    if (altra) throw new PlaylistError('Nome già usato', 'nome_usato');
    const prima = { name: p.name, updatedAt: p.updatedAt };
    p.name = nome;
    p.updatedAt = new Date(this.now()).toISOString();
    try {
      await this.persist(guildId);
    } catch (err) {
      Object.assign(p, prima);
      throw err;
    }
    return riassunto(p);
  }

  async delete(guildId, { id, user }) {
    const list = this.all(guildId);
    const p = this.trova(guildId, id);
    if (!puoModificarePlaylist(user, p)) throw new PlaylistError(PERMESSO_MSG, 'permesso');
    const i = list.indexOf(p);
    list.splice(i, 1);
    try {
      await this.persist(guildId);
    } catch (err) {
      list.splice(i, 0, p);
      throw err;
    }
    return riassunto(p);
  }
}
