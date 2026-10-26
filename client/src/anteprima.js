// Solo per lo sviluppo (npm run dev -w client, poi /?anteprima=1): stato finto per vedere la grafica
// senza server e senza Discord. App.jsx lo importa solo quando import.meta.env.DEV è vero,
// quindi non finisce nella build di produzione.
const brano = (id, title, author, duration, requestedBy = 'Prova') => ({ id, title, author, duration, thumbnail: null, requestedBy });
const qp = new URLSearchParams(location.search);

const TITOLI = [
  ['Under Pressure', 'Queen & David Bowie', 248], ['Don’t Stop Me Now', 'Queen', 209], ['Somebody to Love', 'Queen', 296],
  ['Albachiara', 'Vasco Rossi', 262], ['Vita spericolata', 'Vasco Rossi', 285], ['La donna cannone', 'Francesco De Gregori', 279],
  ['Bohemian Like You', 'The Dandy Warhols', 211], ['Mr. Brightside', 'The Killers', 222], ['Seven Nation Army', 'The White Stripes', 231],
  ['Smells Like Teen Spirit', 'Nirvana', 301], ['Another One Bites the Dust', 'Queen', 215], ['Wonderwall (Remastered)', 'Oasis', 258],
];
const PERSONE = ['Prova', 'Giulia', 'Marco', 'Luca'];
const membro = (id, name, extra = {}) => ({
  id, name, avatar: null, avatarUrl: null, speaking: false, muted: false, deaf: false,
  serverMuted: false, serverDeaf: false, streaming: false, video: false, ...extra,
});
const MEMBRI_BASE = [
  membro('m1', 'Prova', { speaking: true, streaming: true }),
  membro('m2', 'Giulia', { video: true }),
  membro('m3', 'Luca Bianchi', { muted: true, deaf: true }),
  membro('m4', 'Marco', { muted: true, serverMuted: true }),
  membro('m5', 'Sara Esposito Montanari', { streaming: true, video: true, muted: true }),
];
// ?persone=N per provare il pannello «Nel canale» con poche o tante persone (predefinito 5).
const ALTRI = ['Alessandro', 'Chiara Rossi', 'Davide', 'Elena Ferrari Colombo', 'Federico', 'Martina', 'Paolo Ricci', 'Valentina'];
const N_PERSONE = Math.max(0, Math.floor(Number(qp.get('persone') ?? MEMBRI_BASE.length)) || 0);
const MEMBRI = Array.from({ length: N_PERSONE }, (_, i) =>
  i < MEMBRI_BASE.length ? MEMBRI_BASE[i] : membro(`m${i + 1}`, ALTRI[(i - MEMBRI_BASE.length) % ALTRI.length], i % 3 === 0 ? { muted: true } : {}));

/**
 * Simula il messaggio leggero { type: 'members' } del server: ogni 3 s parla un'altra persona
 * (solo chi non è muto). Restituisce la funzione per fermarlo.
 */
export function simulaParlato(onMessage) {
  if (statoAnteprima.members == null || statoAnteprima.members.length === 0) return () => {};
  const voci = MEMBRI.filter((m) => !m.muted).map((m) => m.id);
  let turno = 0;
  const t = setInterval(() => {
    turno += 1;
    const chi = voci[turno % voci.length];
    onMessage({ type: 'members', members: MEMBRI.map((m) => ({ ...m, speaking: m.id === chi })) });
  }, 3000);
  return () => clearInterval(t);
}

// ?coda=N per provare code corte o lunghe (predefinito 96 brani).
const N = Number(qp.get('coda') ?? 96);

export const statoAnteprima = {
  // ?vuoto=1: niente in riproduzione e coda vuota. ?copertina=1: il brano in corso ha una copertina
  // (passa da /api/thumb come in produzione: senza server va servita a parte, es. con Playwright).
  current: qp.has('vuoto') ? null : {
    ...brano('a1', 'Bohemian Rhapsody (Remastered 2011)', 'Queen', 355),
    ...(qp.has('copertina') ? { thumbnail: 'https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg' } : {}),
  },
  // ?pausa=1: brano in corso in pausa (barrette ferme nella prima riga della coda).
  paused: qp.has('uscita') || qp.has('pausa'),
  loading: false,
  position: 83,
  volume: 60,
  loop: 'queue',
  // ?fuori=1: il bot non è nel canale (pallino rosso, «Fuori dal canale»).
  channelName: 'Salotto',
  inVoice: !qp.has('fuori'),
  connected: !qp.has('fuori'),
  botOnline: true,
  // ?uscita=1: canale vuoto, il bot esce tra 45 s (pillola e avviso gialli).
  ...(qp.has('uscita') ? { leaveReason: 'empty', leaveIn: 45 } : {}),
  queue: Array.from({ length: qp.has('vuoto') ? 0 : N }, (_, i) => {
    const [t, a, d] = TITOLI[i % TITOLI.length];
    return brano(`q${i}`, i < TITOLI.length ? t : `${t} (${Math.floor(i / TITOLI.length) + 1})`, a, d, PERSONE[i % PERSONE.length]);
  }),
  history: [
    brano('h0', 'Radio Ga Ga (Live at Wembley Stadium, Saturday 12 July 1986) – Remastered 2011', 'Queen', 343),
    brano('h1', 'Killer Queen', 'Queen', 181),
    brano('h2', 'Sweet Child O’ Mine', 'Guns N’ Roses', 356),
    brano('h3', 'Bella stronza', 'Marco Masini', 312),
    brano('h4', 'Una vita da mediano', 'Ligabue', 290),
  ],
  // Come state.members del server (ordine alfabetico, senza bot). ?canale=vuoto → [], ?canale=ignoto → null.
  members: qp.get('canale') === 'vuoto' ? [] : qp.get('canale') === 'ignoto' ? null : MEMBRI,
};

/** Risultati finti di una ricerca (10 righe, come YouTube). */
export const risultatiAnteprima = (query) =>
  [
    ['Albachiara (Live)', 'Vasco Rossi', 296],
    ['Albachiara', 'Vasco Rossi - Topic', 262],
    ['Albachiara – testo', 'Canzoni Italiane', 263],
    ['Vasco Rossi - Albachiara (Official Video) [Remastered 2021] dal concerto di Modena Park', 'Vasco Rossi', 318],
    ['Albachiara (San Siro 2007)', 'Vasco Rossi', 401],
    ['Albachiara - chitarra acustica', 'Lezioni di chitarra', 412],
    ['Albachiara (cover)', 'Band del liceo', 255],
    ['Albachiara karaoke', 'Karaoke Italia', 268],
    ['Albachiara piano', 'Piano Covers', 230],
    [`${query} – playlist`, 'Mix', 0],
  ].map(([title, author, duration], i) => ({ id: `r${i}`, title, author, duration, thumbnail: null }));

/** Anteprima finta di un link incollato (YouTube risolto, il resto no). */
export const anteprimaLink = (url) =>
  /youtu/.test(url) ? { title: 'Vasco Rossi - Albachiara (Official Video)', author: 'Vasco Rossi', thumbnail: null, playlist: /list=/.test(url) } : null;

/* ---------- Libreria di playlist finta (?libreria=vuota per lo stato vuoto, ?admin=1 per l'amministratore) ---------- */

// Chi guarda: Prova (m1), non amministratore, come nel mockup.
// ?ruolo=no: senza il ruolo Soundbar (puoCaricare falso). ?admin=1: amministratore.
export const utenteAnteprima = { id: 'm1', name: 'Prova', isAdmin: qp.has('admin'), puoCaricare: qp.get('ruolo') !== 'no' };
const AUTORI = { Prova: { id: 'm1', name: 'Prova' }, Giulia: { id: 'm2', name: 'Giulia' }, Marco: { id: 'm4', name: 'Marco' }, Paolo: { id: 'm9', name: 'Paolo' } };

const braniFinti = (n, seme = 0) =>
  Array.from({ length: n }, (_, i) => {
    const [t, a, d] = TITOLI[(i + seme) % TITOLI.length];
    return { title: t, author: a, duration: d, thumbnail: null };
  });
let seq = 0;
const nuova = (name, n, autore, seme) => {
  const ora = new Date().toISOString();
  return { id: `pl-${++seq}`, name, tracks: braniFinti(n, seme), createdBy: AUTORI[autore], createdAt: ora, updatedAt: ora };
};
let libreria = qp.get('libreria') === 'vuota' ? [] : [
  nuova('Serata anni 80', 24, 'Prova', 0),
  nuova('Rock italiano', 31, 'Giulia', 3),
  nuova('Cantautori per la domenica mattina', 18, 'Prova', 5),
  nuova('Queen e dintorni', 12, 'Marco', 1),
  nuova('Per studiare', 40, 'Paolo', 7),
];
const meta = ({ tracks, ...p }) => ({ ...p, count: tracks.length, duration: tracks.reduce((s, t) => s + (t.duration || 0), 0) });
/** Elenco come nel messaggio `playlists` del server (senza i brani). */
export const playlistAnteprima = () => libreria.map(meta);

const pulisci = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const stesso = (a, b) => a.toLowerCase() === b.toLowerCase();
const puoModificare = (p) => utenteAnteprima.isAdmin || p.createdBy.id === utenteAnteprima.id;
const errore = (code, error) => ({ result: { ok: false, code, error } });
const controllaNome = (name) =>
  !name ? errore('nome_vuoto', 'Il nome non può essere vuoto') : name.length > 60 ? errore('nome_lungo', 'Nome troppo lungo (massimo 60 caratteri)') : null;

/**
 * Risposta finta ai messaggi playlist* (come il server): { result, playlists?, patch? }.
 * `patch` sono i campi di stato da cambiare (queue, current) dopo un caricamento.
 */
export function rispondiPlaylist(msg, stato) {
  if (msg.type === 'playlistSave') {
    const name = pulisci(msg.name);
    const bad = controllaNome(name);
    if (bad) return bad;
    const tracks = [stato?.current, ...(stato?.queue || [])].filter(Boolean).map(({ title, author, duration, thumbnail }) => ({ title, author, duration, thumbnail }));
    if (!tracks.length) return errore('coda_vuota', 'La coda è vuota: niente da salvare');
    const old = libreria.find((p) => stesso(p.name, name));
    if (old && !msg.overwrite) return errore('nome_usato', 'Nome già usato');
    if (old && !puoModificare(old)) return errore('permesso', `Questo nome è di una playlist di ${old.createdBy.name}: scegli un altro nome`);
    if (!old && libreria.length >= 200) return errore('piena', 'Libreria piena (massimo 200 playlist): eliminane qualcuna');
    let p;
    if (old) {
      p = { ...old, tracks: tracks.slice(0, 1000), updatedAt: new Date().toISOString() };
      libreria = libreria.map((x) => (x.id === old.id ? p : x));
    } else {
      p = { ...nuova(name, 0, 'Prova', 0), createdBy: { id: utenteAnteprima.id, name: utenteAnteprima.name }, tracks: tracks.slice(0, 1000) };
      libreria = [...libreria, p];
    }
    return { result: { ok: true, playlist: meta(p), overwritten: Boolean(old), truncated: tracks.length > 1000 }, playlists: playlistAnteprima() };
  }

  const p = libreria.find((x) => x.id === msg.id);
  if (!p) return errore('non_trovata', 'Playlist non trovata (forse è stata eliminata)');

  if (msg.type === 'playlistLoad') {
    const nuovi = p.tracks.map((t, i) => ({ ...t, id: `l${Date.now()}-${i}`, requestedBy: utenteAnteprima.name }));
    let queue = msg.mode === 'replace' ? nuovi : [...(stato?.queue || []), ...nuovi];
    let current = stato?.current ?? null;
    if (!current && queue.length) [current, ...queue] = queue;
    return { result: { ok: true, playlist: meta(p), mode: msg.mode, count: nuovi.length }, patch: { queue, current } };
  }
  if (!puoModificare(p)) return errore('permesso', 'Solo chi l’ha creata o un amministratore del server può rinominarla o eliminarla');
  if (msg.type === 'playlistRename') {
    const name = pulisci(msg.name);
    const bad = controllaNome(name);
    if (bad) return bad;
    if (libreria.some((x) => x.id !== p.id && stesso(x.name, name))) return errore('nome_usato', 'Nome già usato');
    const q = { ...p, name, updatedAt: new Date().toISOString() };
    libreria = libreria.map((x) => (x.id === p.id ? q : x));
    return { result: { ok: true, playlist: meta(q) }, playlists: playlistAnteprima() };
  }
  if (msg.type === 'playlistDelete') {
    libreria = libreria.filter((x) => x.id !== p.id);
    return { result: { ok: true, playlist: meta(p) }, playlists: playlistAnteprima() };
  }
  return errore('interno', 'Errore interno');
}

/**
 * Coda finta: `clear` svuota i brani successivi (il brano in corso resta); `add` / `addResult` aggiungono
 * un brano in fondo ('fine'), come primo della coda ('prossimo') o in cima ('ora', passa in riproduzione).
 * Restituisce i campi di stato da cambiare, oppure una funzione (stato) => campi.
 */
export const rispondiCoda = (msg) => {
  if (msg?.type === 'clear') return { queue: [] };
  if (msg?.type === 'add' || msg?.type === 'addResult' || msg?.type === 'accodaDaStorico') {
    return (st) => {
      const t = brano(`n${Date.now()}`, msg.titolo || msg.query || 'Brano', 'Anteprima', 200, PERSONE[0]);
      const queue = st?.queue || [];
      if (msg.posizione === 'prossimo') return { queue: [t, ...queue] };
      if (msg.posizione === 'ora') return { current: t, queue };
      return { queue: [...queue, t] };
    };
  }
  return null;
};

/* ---------- Soundbar finta (?suoni=vuoto per lo stato vuoto, ?ruolo=no senza ruolo, ?admin=1 amministratore) ---------- */

let seqSuoni = 0;
const suonoFinto = (name, duration, by, byId, volume = 1) => ({ id: `s${++seqSuoni}`, name, duration, by, byId, volume, createdAt: new Date().toISOString() });
let suoniLista = qp.get('suoni') === 'vuoto' ? [] : [
  suonoFinto('Applauso', 4, 'Prova', 'm1'),
  suonoFinto('Bruh', 1, 'Marco', 'm4', 0.8),
  suonoFinto('Rullo di tamburi', 6, 'Giulia', 'm2'),
  suonoFinto('Vittoria!', 8, 'Prova', 'm1', 1.5),
  suonoFinto('Grillo', 3, 'Luca', 'm3'),
  suonoFinto('Sirena dei pompieri molto lunga', 5, 'Marco', 'm4'),
];
/** Elenco come nel messaggio `suoni` del server. */
export const suoniAnteprima = () => suoniLista.map((x) => ({ ...x }));

const MAX_SUONO_S = 20;
const puoModificareSuono = (x) => utenteAnteprima.isAdmin || x.byId === utenteAnteprima.id;
const controllaNomeSuono = (name) =>
  !name ? { code: 'nome_vuoto', error: 'Il nome non può essere vuoto' } : name.length > 40 ? { code: 'nome_lungo', error: 'Nome troppo lungo (massimo 40 caratteri)' } : null;
const nomeUsato = (name, tranne) => suoniLista.some((x) => x.id !== tranne && stesso(x.name, name));

/** Risposta finta a suonoBiglietto / suonoRinomina / suonoVolume / suonoElimina: { result, suoni? }. */
export function rispondiSuoni(msg) {
  if (msg.type === 'suonoBiglietto') {
    return utenteAnteprima.puoCaricare || utenteAnteprima.isAdmin
      ? { result: { ok: true, ticket: 'biglietto-finto' } }
      : { result: { ok: false, code: 'permesso', error: 'Serve il ruolo Soundbar per caricare suoni' } };
  }
  const x = suoniLista.find((y) => y.id === msg.id);
  if (!x) return errore('non_trovato', 'Suono non trovato (forse è stato eliminato)');
  if (!puoModificareSuono(x)) return errore('permesso', 'Solo chi l’ha caricato o un amministratore può modificarlo');
  if (msg.type === 'suonoRinomina') {
    const name = pulisci(msg.name);
    const bad = controllaNomeSuono(name);
    if (bad) return errore(bad.code, bad.error);
    if (nomeUsato(name, x.id)) return errore('nome_usato', 'Nome già usato da un altro suono');
    suoniLista = suoniLista.map((y) => (y.id === x.id ? { ...y, name } : y));
    return { result: { ok: true }, suoni: suoniAnteprima() };
  }
  if (msg.type === 'suonoVolume') {
    const n = typeof msg.volume === 'number' ? msg.volume : Number.NaN;
    if (!Number.isFinite(n)) return errore('volume', 'Volume non valido');
    const volume = Number(Math.max(0.1, Math.min(2, Math.round(n / 0.05) * 0.05)).toFixed(2));
    suoniLista = suoniLista.map((y) => (y.id === x.id ? { ...y, volume } : y));
    return { result: { ok: true, suono: suoniLista.find((y) => y.id === x.id) }, suoni: suoniAnteprima() };
  }
  if (msg.type === 'suonoElimina') {
    suoniLista = suoniLista.filter((y) => y.id !== x.id);
    return { result: { ok: true }, suoni: suoniAnteprima() };
  }
  return errore('interno', 'Errore interno');
}

/** Caricamento finto (niente rete): aggiunge il suono all'elenco. Il server vero ricontrolla durata e nome. */
export async function caricaSuonoFinto(file, nome, durata, volume = 1) {
  await new Promise((r) => setTimeout(r, 900));
  const name = pulisci(nome);
  const bad = controllaNomeSuono(name);
  if (bad) return errore(bad.code, bad.error);
  if (file.size > 2 * 1024 * 1024) return errore('troppo_grande', 'File troppo grande (massimo 2 MB)');
  if (nomeUsato(name)) return errore('nome_usato', 'Esiste già un suono con questo nome: scegline un altro.');
  const s = { ...suonoFinto(name, Math.min(MAX_SUONO_S, Math.max(1, Math.round(durata || 2))), utenteAnteprima.name, utenteAnteprima.id, Number(volume) || 1) };
  suoniLista = [...suoniLista, s];
  return { result: { ok: true, suono: s }, suoni: suoniAnteprima() };
}

/**
 * Simula suona / suonoFerma sullo stato finto: `state.suono = { id, name, by, fine }` con `fine` a timer
 * (millisecondi dall'epoca) e la musica ferma finché il suono dura.
 */
let timerSuono = null;
export function rispondiSuonare(msg, setState) {
  if (msg?.type === 'suona') {
    const x = suoniLista.find((y) => y.id === msg.id);
    if (!x) return;
    clearTimeout(timerSuono);
    const fine = Date.now() + x.duration * 1000;
    setState((st) => (st ? { ...st, suono: { id: x.id, name: x.name, by: utenteAnteprima.name, fine } } : st));
    timerSuono = setTimeout(() => setState((st) => (st?.suono?.fine === fine ? { ...st, suono: null } : st)), x.duration * 1000);
  } else if (msg?.type === 'suonoFerma') {
    clearTimeout(timerSuono);
    setState((st) => (st ? { ...st, suono: null } : st));
  }
}
