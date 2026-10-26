// Trasforma un link o un testo di ricerca in uno o più brani, usando yt-dlp.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

const MAX_PLAYLIST = 200;
const isUrl = (s) => /^https?:\/\//i.test(s);

/** Traduce gli errori più comuni di yt-dlp in frasi comprensibili. */
function friendly(raw) {
  const rules = [
    [/Unsupported URL/i, 'Link non supportato'],
    [/getaddrinfo|Failed to resolve|Unable to download webpage|timed out/i, 'Sito non raggiungibile'],
    [/Private video|Video unavailable|This video is not available|removed/i, 'Video non disponibile o privato'],
    [/Sign in to confirm|age-restricted|confirm your age/i, 'YouTube chiede l\'accesso per questo video (età o controllo anti-bot)'],
    [/HTTP Error 404/i, 'Pagina non trovata (404)'],
  ];
  for (const [re, text] of rules) if (re.test(raw)) return text;
  return raw.replace(/^ERROR:\s*/, '').slice(0, 160);
}

/**
 * Limite ai processi yt-dlp contemporanei. Ognuno, con la sfida JS di YouTube, usa ~350 MB per
 * qualche secondo: su una macchina con poca RAM 10 processi insieme la finirebbero.
 * Le richieste dell'utente (aggiungi, cerca) passano davanti; quelle di sfondo (`bassa`, la
 * preparazione del prossimo brano) partono solo quando non gira nessun altro yt-dlp.
 * Restituisce prendi(bassa) → Promise<rilascia()>.
 */
export function creaLimitatore(max = 2) {
  const attesa = [];
  let attivi = 0;
  const avanti = () => {
    while (attesa.length) {
      const i = attesa.findIndex((x) => !x.bassa);
      const k = i >= 0 ? i : 0;
      const job = attesa[k];
      if (job.bassa ? attivi > 0 : attivi >= max) return;
      attesa.splice(k, 1);
      attivi++;
      let fatto = false;
      job.res(() => {
        if (fatto) return;
        fatto = true;
        attivi--;
        avanti();
      });
    }
  };
  return {
    prendi: (bassa = false) => new Promise((res) => { attesa.push({ res, bassa }); avanti(); }),
    stato: () => ({ attivi, inAttesa: attesa.length }),
  };
}
export const limiteYtdlp = creaLimitatore(config.ytdlpContemporanei);

/** Esegue yt-dlp (rispettando il limite dei processi) e restituisce il JSON prodotto. */
async function ytdlpJson(args, timeoutMs = 60_000, { bassa = false } = {}) {
  const rilascia = await limiteYtdlp.prendi(bassa);
  try {
    return await ytdlpJsonSubito(args, timeoutMs);
  } finally {
    rilascia();
  }
}

function ytdlpJsonSubito(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ytdlp, ['--no-warnings', '--ignore-config', '-J', ...args], {
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('yt-dlp ha impiegato troppo tempo'));
    }, timeoutMs);
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`yt-dlp non trovato o non avviabile (${e.message})`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const msg = err.split('\n').find((l) => l.includes('ERROR')) || err.trim() || `codice ${code}`;
        return reject(new Error(friendly(msg)));
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error('Risposta di yt-dlp non valida'));
      }
    });
  });
}

function bestThumb(info) {
  if (info.thumbnail) return info.thumbnail;
  const list = info.thumbnails || [];
  if (!list.length) return null;
  // Preferisce una miniatura media (né minuscola né enorme).
  const sorted = [...list].filter((t) => t.url).sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find((t) => (t.width || 0) >= 320) || sorted.at(-1))?.url || null;
}

function entryUrl(e, extractor) {
  if (e.webpage_url) return e.webpage_url;
  if (e.url && isUrl(e.url)) return e.url;
  if (e.id && /youtube/i.test(extractor || e.ie_key || '')) return `https://www.youtube.com/watch?v=${e.id}`;
  return e.url || null;
}

function toTrack(e, requestedBy, extractor) {
  return {
    id: randomUUID(),
    title: e.title || e.track || 'Titolo sconosciuto',
    author: e.uploader || e.channel || e.artist || e.creator || null,
    url: entryUrl(e, extractor),
    duration: Number.isFinite(e.duration) ? Math.round(e.duration) : null,
    live: e.is_live === true || e.live_status === 'is_live', // dirette: niente spostamento nel brano
    thumbnail: bestThumb(e),
    source: (e.extractor_key || e.ie_key || extractor || '').replace(/Tab$|Search$/, '') || null,
    requestedBy,
    query: null,
  };
}

/** Cerca su YouTube il primo risultato per un testo. */
export async function searchOne(text, requestedBy, { bassa = false } = {}) {
  const info = await ytdlpJson(['--flat-playlist', `ytsearch1:${text}`], 60_000, { bassa });
  const first = info.entries?.[0];
  if (!first) throw new Error(`Nessun risultato per "${text}"`);
  return toTrack(first, requestedBy, 'Youtube');
}

/** Cerca su YouTube più risultati (solo metadati, veloce) per la vista "Cerca". */
export async function searchMany(text, count = 10) {
  const q = String(text || '').trim().slice(0, 200);
  if (!q) throw new Error('Scrivi cosa cercare');
  const info = await ytdlpJson(['--flat-playlist', `ytsearch${count}:${q}`], 25_000);
  return (info.entries || [])
    .filter((e) => e && e.id && !/\[(private|deleted)/i.test(e.title || ''))
    .map((e) => toTrack(e, null, 'Youtube'));
}

// ---------- Spotify (senza chiavi: oEmbed pubblico + pagina embed pubblica) ----------
const SPOTIFY_RE = /open\.spotify\.com\/(?:intl-[a-z]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/i;

async function spotify(url, requestedBy) {
  const [, kind, id] = url.match(SPOTIFY_RE);
  const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error('Link Spotify non valido o non pubblico');
  const oembed = await res.json();

  // La pagina embed pubblica contiene anche gli artisti e, per album e playlist, l'elenco dei brani.
  let html = '';
  try {
    const emb = await fetch(`https://open.spotify.com/embed/${kind}/${id}`);
    if (emb.ok) html = await emb.text();
  } catch { /* facoltativo */ }

  if (kind === 'track') {
    const artists = [...(html.match(/"artists":\[(.*?)\]/)?.[1] ?? '').matchAll(/"name":"([^"]+)"/g)].map((m) => m[1]);
    const query = [oembed.title, artists.join(' ')].filter(Boolean).join(' ');
    const t = await searchOne(query, requestedBy);
    return [{ ...t, thumbnail: oembed.thumbnail_url || t.thumbnail, source: 'Spotify → YouTube' }];
  }

  const list = [];
  const block = html.match(/"trackList":\[(.*?)\]\s*,\s*"/s)?.[1] ?? '';
  for (const m of block.matchAll(/"title":"((?:[^"\\]|\\.)*)","subtitle":"((?:[^"\\]|\\.)*)"/g)) {
    const title = JSON.parse(`"${m[1]}"`);
    const artist = JSON.parse(`"${m[2]}"`);
    list.push({
      id: randomUUID(),
      title,
      author: artist,
      url: null,
      duration: null,
      thumbnail: oembed.thumbnail_url || null,
      source: 'Spotify → YouTube',
      requestedBy,
      query: `${title} ${artist}`, // cercato su YouTube solo quando tocca a lui
    });
    if (list.length >= MAX_PLAYLIST) break;
  }
  if (!list.length) throw new Error('Non riesco a leggere i brani di questo album o playlist Spotify');
  return list;
}

/**
 * Risolve quello che l'utente ha scritto.
 * @returns {Promise<{tracks: object[], playlistTitle: string|null}>}
 */
export async function resolveInput(input, requestedBy = null) {
  const text = String(input || '').trim();
  if (!text) throw new Error('Scrivi un link o cosa cercare');

  if (!isUrl(text)) return { tracks: [await searchOne(text, requestedBy)], playlistTitle: null };

  if (SPOTIFY_RE.test(text)) {
    const tracks = await spotify(text, requestedBy);
    return { tracks, playlistTitle: tracks.length > 1 ? 'Spotify' : null };
  }

  const info = await ytdlpJson(['--flat-playlist', '--playlist-end', String(MAX_PLAYLIST), text]);
  if (info._type === 'playlist' && Array.isArray(info.entries)) {
    const tracks = info.entries
      .filter((e) => e && !/\[(private|deleted)/i.test(e.title || ''))
      .map((e) => toTrack(e, requestedBy, info.extractor_key));
    if (!tracks.length) throw new Error('La playlist è vuota');
    return { tracks, playlistTitle: info.title || 'Playlist' };
  }
  return { tracks: [toTrack(info, requestedBy, info.extractor_key)], playlistTitle: null };
}

const cercaInCorso = new WeakMap(); // brano pigro → ricerca in corso (preparazione e partenza insieme: una sola)

/** Per i brani "pigri" (es. da playlist Spotify) trova il link vero prima di suonarli. */
export async function ensurePlayable(track, { bassa = false } = {}) {
  if (track.url) return track;
  let p = cercaInCorso.get(track);
  if (!p) {
    p = searchOne(track.query || track.title, track.requestedBy, { bassa })
      .then((found) => {
        track.url = found.url;
        track.duration ??= found.duration;
        return track;
      })
      .finally(() => cercaInCorso.delete(track));
    cercaInCorso.set(track, p);
  }
  return p;
}

const DURATA_URL_DEFAULT_MS = 30 * 60_000; // se l'URL non dice quando scade, lo teniamo 30 minuti
// Solo audio quando c'è; altrimenti (alcuni video danno solo HLS) un video piccolo, non il 1080p.
const FORMATO = 'bestaudio/best[height<=480]/best';
// Il client "web_embedded" di YouTube dà link che ffmpeg legge subito (prova del 24-10-2026 nel container:
// risoluzione ~4 s, primo audio 0,1-0,6 s). Con il client predefinito ffmpeg riceve 403.
const CLIENT_VELOCE = 'youtube:player_client=web_embedded';

/** Dall'URL diretto legge quando scade (parametro expire= di YouTube), con un margine di 1 minuto. */
export function scadenzaUrl(directUrl, now = Date.now()) {
  const m = /[?&/]expire[=/](\d{9,11})/.exec(directUrl || '');
  if (m) return Number(m[1]) * 1000 - 60_000;
  return now + DURATA_URL_DEFAULT_MS;
}

const isYoutube = (url) => /(^|\.)(youtube\.com|youtu\.be)$/i.test(hostOf(url));
function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** Id del video in un link YouTube (watch?v=, youtu.be/, shorts/, music.youtube), altrimenti null. */
export function videoIdDaLink(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch { return null; }
  if (!isYoutube(u.href)) return null;
  const id = u.hostname.endsWith('youtu.be') ? u.pathname.slice(1).split('/')[0]
    : u.searchParams.get('v') || (/^\/(?:shorts|live|embed)\/([^/?#]+)/.exec(u.pathname)?.[1] ?? null);
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

/** Il link YouTube contiene anche una playlist (list=)? */
export const haPlaylist = (input) => {
  try { return isYoutube(input) && Boolean(new URL(String(input).trim()).searchParams.get('list')); } catch { return false; }
};

/**
 * Una sola chiamata a yt-dlp: dati del brano + URL diretto dello stream con i suoi header.
 * Restituisce { url, headers, exp, direct, track }. direct = false: ffmpeg da solo riceverebbe 403,
 * serve il ripiego yt-dlp | ffmpeg.
 */
export async function getStream(url, requestedBy = null, { bassa = false } = {}) {
  let info;
  let direct = true;
  try {
    info = await ytdlpJson(['--no-playlist', '-f', FORMATO, '--extractor-args', CLIENT_VELOCE, url], 30_000, { bassa });
  } catch (err) {
    if (!isYoutube(url)) throw err;
    // Es. video con l'incorporamento disattivato: client predefinito (link non leggibili da ffmpeg).
    info = await ytdlpJson(['--no-playlist', '-f', FORMATO, url], 30_000, { bassa });
    direct = false;
  }
  const f = info.url ? info : info.requested_formats?.[0];
  if (!f?.url) throw new Error('yt-dlp non ha dato un link audio');
  const size = Number(f.filesize || f.filesize_approx) || null;
  return {
    url: f.url,
    headers: f.http_headers || info.http_headers || {},
    exp: scadenzaUrl(f.url),
    direct,
    // Per la scelta della via audio: 'opus' si copia senza ricodificare; un file unico (https, non
    // m3u8/dash a frammenti) si può scaricare nella cache in RAM.
    acodec: typeof f.acodec === 'string' && f.acodec !== 'none' ? f.acodec : null,
    protocol: typeof f.protocol === 'string' ? f.protocol : null,
    size,
    track: toTrack(info, requestedBy, info.extractor_key),
  };
}

/**
 * Anteprima veloce di un link incollato (titolo, autore, copertina) con oEmbed pubblico, senza
 * yt-dlp. Solo YouTube, Spotify e SoundCloud; entro `timeoutMs`, altrimenti null.
 * `fetchFn` si sostituisce nei test.
 */
export async function anteprimaLink(input, { timeoutMs = 2500, fetchFn = fetch } = {}) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const vid = videoIdDaLink(u.href);
  const endpoint = vid ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${vid}`)}`
    : isYoutube(u.href) ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u.href)}`
    : SPOTIFY_RE.test(u.href) ? `https://open.spotify.com/oembed?url=${encodeURIComponent(u.href)}`
    : /(^|\.)soundcloud\.com$/i.test(u.hostname) ? `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(u.href)}`
    : null;
  if (!endpoint) return null;
  try {
    const r = await fetchFn(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || typeof d.title !== 'string') return null;
    return {
      title: d.title.slice(0, 300),
      author: typeof d.author_name === 'string' ? d.author_name.slice(0, 200) : null,
      thumbnail: typeof d.thumbnail_url === 'string' && /^https:\/\//.test(d.thumbnail_url) ? d.thumbnail_url : null,
      playlist: haPlaylist(u.href) || /\/(album|playlist|sets)\//i.test(u.pathname),
    };
  } catch {
    return null;
  }
}
