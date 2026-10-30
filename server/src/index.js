// Avvio: un solo processo e una sola porta per API, WebSocket, interfaccia compilata e bot.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config, checkConfig } from './config.js';
import { Bot } from './bot.js';
import { MusicManager, messaggioAggiunta, posizioneValida } from './music.js';
import { randomUUID } from 'node:crypto';
import { anteprimaLink, searchMany } from './resolver.js';
import { COMMANDS, handleAutocomplete, handleCommand, handleTextMessage } from './commands.js';
import { QueueStore } from './store.js';
import { AuthError, CLOSE_DENIED, CLOSE_REAUTH, CLOSE_RETRY, createAuth } from './auth.js';
import { clientAddr, closeLine, formatDuration } from './wslog.js';
import { startHeartbeat } from './heartbeat.js';
import { createDiagLimiter, diagLine } from './diag.js';
import { AudioCache } from './audiocache.js';
import { PlaylistError, PlaylistLibrary } from './playlists.js';
import { StatoCanale } from './statocanale.js';
import { SoundError, SoundLibrary, creaBiglietti, creaConvertitore, creaLimitatore, creaRouteSuoni, creaVolumizzatore, pianoMsg, puoCaricare } from './suoni.js';

checkConfig();

// ---------- errori non gestiti ----------
// Coda salvata su disco (definita qui perché serve anche quando il processo cade).
const store = new QueueStore({ dir: config.dataDir });

// Una promessa rifiutata senza catch: si registra e si continua (non lascia stato rotto).
process.on('unhandledRejection', (reason) => {
  console.error('[server] Promessa rifiutata non gestita:', reason instanceof Error ? reason.stack : reason);
});
// Un'eccezione non gestita lascia il processo in uno stato sconosciuto: si salva la coda e si esce
// con codice 1, così Docker (restart: unless-stopped) riavvia il bot pulito.
process.on('uncaughtException', (err) => {
  console.error('[server] Errore non gestito, esco per farmi riavviare:', err?.stack || err);
  try {
    store.close();
  } catch { /* già in uscita */ }
  process.exit(1);
});

// ---------- bot (facoltativo in modalità prova) ----------
let bot = null;
if (config.botToken) {
  bot = new Bot({ token: config.botToken, textChannelIds: config.textChannelIds, mostraParlanti: config.mostraParlanti });
  bot.commands = COMMANDS;
  try {
    await bot.start();
  } catch (err) {
    if (!config.prova) {
      console.error(`\n  ${err.message}\n`);
      process.exit(1);
    }
    console.warn(`[bot] ${err.message} (modalità prova: continuo senza bot)`);
    bot = null;
  }
}

// ---------- client WebSocket per guild ----------
/** @type {Map<string, Set<import('ws').WebSocket>>} */
const sockets = new Map();
const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const broadcast = (guildId, msg) => {
  for (const ws of sockets.get(guildId) ?? []) send(ws, msg);
};

// Cache audio in RAM (per server: ultimo ascoltato, in corso e 2 prossimi), budget unico per tutti i server
const cacheAudio = new AudioCache({
  budgetMb: config.cacheAudioMb,
  maxBrani: config.cacheAudioBrani,
  maxSec: config.cacheAudioMaxMinuti * 60,
});
console.log(cacheAudio.attiva
  ? `[cache] Audio in RAM: fino a ${config.cacheAudioMb} MB e ${config.cacheAudioBrani} brani per server (max ${config.cacheAudioMaxMinuti} min l'uno)`
  : '[cache] Audio in RAM spenta (CACHE_AUDIO_MB=0)');

// Stato del canale vocale = brano in riproduzione (STATO_CANALE=0 per spegnerlo)
const statoCanale = new StatoCanale({
  attivo: config.statoCanale && Boolean(bot),
  imposta: bot ? (channelId, status) => bot.impostaStatoCanale(channelId, status) : null,
});
if (bot) bot.onStatoCanale = (channelId, status) => statoCanale.ricorda(channelId, status);

const music = new MusicManager({
  bot,
  emptySeconds: config.emptySeconds,
  idleMinutes: config.idleMinutes,
  stallSeconds: config.stallSeconds,
  store,
  cache: cacheAudio.attiva ? cacheAudio : null,
  riposoMinuti: config.riposoMinuti,
  onRiposo: () => thumbCache.clear(), // anche le copertine tenute in memoria
  onChange: (guildId, state) => {
    broadcast(guildId, { type: 'state', state });
    // Il canale vero del bot (non quello di riferimento dell'Activity): fuori dal vocale si ripristina.
    statoCanale.aggiorna(guildId, { channelId: state.inVoice ? bot?.canaleBot(guildId) : null, track: state.current });
  },
  onNotice: (guildId, notice) => broadcast(guildId, { type: 'notice', ...notice }),
  // Solo «chi parla» cambiato: messaggio leggero invece dello stato completo
  onMembers: (guildId, members) => broadcast(guildId, { type: 'members', members }),
});

// Libreria di playlist condivisa (una per server Discord), nella stessa cartella dati della coda
const playlists = new PlaylistLibrary({ dir: config.dataDir });
const mandaPlaylist = (guildId) => broadcast(guildId, { type: 'playlists', playlists: playlists.list(guildId) });
// Soundbar: suoni brevi caricati dall'Activity (uno per server), nella stessa cartella dati
const suoni = new SoundLibrary({ dir: config.dataDir, maxSec: config.soundbarMaxSecondi, volumizza: creaVolumizzatore({ ffmpeg: config.ffmpeg }) });
const mandaSuoni = (guildId) => broadcast(guildId, { type: 'suoni', suoni: suoni.list(guildId) });
const bigliettiSuoni = creaBiglietti();
const limitaSuoni = creaLimitatore();
const convertiSuono = creaConvertitore({ ffmpeg: config.ffmpeg, ffprobe: config.ffprobe });
{
  const tolti = suoni.pulisci();
  console.log(`[suoni] Soundbar: max ${config.soundbarMaxSecondi} s e ${config.soundbarMaxMb} MB per suono · ruoli che caricano: ${config.soundbarRuoli.length || 'solo admin'}${tolti ? ` · ${tolti} file rimasti tolti` : ''}`);
}
/** Può caricare suoni (permesso aggiornato: admin oppure uno dei ruoli della Soundbar)? */
const permessoCarica = async (guildId, u) => {
  if (!bot?.ready) return { isAdmin: u.isAdmin, puoCaricare: config.prova };
  const [isAdmin, haRuolo] = await Promise.all([bot.isAdmin(guildId, u.id), bot.haRuolo(guildId, u.id, config.soundbarRuoli)]);
  return { isAdmin, puoCaricare: puoCaricare({ isAdmin, haRuolo }) };
};
// /suono (piano B del caricamento): stessa libreria, stesso convertitore e stesso anti-spam
const comandiSuoni = {
  library: suoni,
  converti: convertiSuono,
  limitatore: limitaSuoni,
  maxMb: config.soundbarMaxMb,
  permesso: (guildId, userId) => permessoCarica(guildId, { id: userId, isAdmin: false }),
  onCambio: (guildId) => mandaSuoni(guildId),
};
{
  const n = music.restoreAll();
  console.log(`[coda] Cartella dati: ${config.dataDir} · code ricaricate con brani: ${n}`);
}

// Verifica di chi si collega (timeout 5 s, cache 10 min)
const auth = createAuth({
  fetchMember: bot
    ? async (guildId, userId) => {
        const guild = await bot.client.guilds.fetch(guildId);
        return guild.members.fetch(userId);
      }
    : null,
});

if (bot) {
  // Messaggi in chat (canali musica o menzione del bot): stessa coda della GUI e dei comandi slash.
  bot.onText = (ctx) =>
    handleTextMessage(ctx, {
      music,
      notify: (guildId, message) => broadcast(guildId, { type: 'notice', kind: 'info', message }),
    });
  bot.onBotVoice = (guildId, channelId) => music.get(guildId).botVoiceChanged(channelId);
  bot.onHumans = (guildId, count) => music.get(guildId).humansChanged(count);
  bot.onMembers = (guildId, info) => music.get(guildId).membersChanged(info);
  bot.onCommand = (interaction) =>
    handleCommand(interaction, {
      music,
      notify: (guildId, message) => broadcast(guildId, { type: 'notice', kind: 'info', message }),
      isConnected: (guildId) => bot.isConnected(guildId),
      soundbar: comandiSuoni,
    });
  bot.onAutocomplete = (interaction) => handleAutocomplete(interaction, { soundbar: comandiSuoni });
}

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// Compatibilità: alcune guide vecchie usano il prefisso /.proxy per le chiamate dall'Activity.
app.use((req, _res, next) => {
  if (req.url.startsWith('/.proxy/')) req.url = req.url.slice('/.proxy'.length);
  next();
});

app.get('/api/config', (_req, res) => {
  res.json({
    clientId: config.clientId,
    prova: config.prova,
    provaGuildId: config.prova ? config.provaGuildId : null,
    provaChannelId: config.prova ? config.provaChannelId : null,
    botOnline: Boolean(bot?.ready),
  });
});

// Scambio del "code" OAuth2 dell'Embedded App SDK con l'access token (come nella guida ufficiale).
// Log di una riga, senza code né token.
app.post('/api/token', async (req, res) => {
  const t0 = Date.now();
  const fail = (status, error) => {
    console.warn(`[token] errore ${status}: ${error} (${formatDuration(Date.now() - t0)})`);
    res.status(status).json({ error });
  };
  const code = req.body?.code;
  if (!code || typeof code !== 'string') return fail(400, 'code mancante');
  if (!config.clientId || !config.clientSecret) {
    return fail(500, 'DISCORD_CLIENT_ID o DISCORD_CLIENT_SECRET non impostati');
  }
  try {
    const r = await fetch('https://discord.com/api/oauth2/token', {
      signal: AbortSignal.timeout(8000),
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'authorization_code',
        code,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.access_token) {
      return fail(502, `Discord ${r.status}: ${data.error_description || data.error || 'scambio token fallito'}`);
    }
    console.log(`[token] ok (${formatDuration(Date.now() - t0)})`);
    res.json({ access_token: data.access_token, expires_in: data.expires_in ?? null });
  } catch (err) {
    const scaduto = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    fail(502, scaduto ? 'Discord non risponde' : `rete: ${err.message}`);
  }
});

// Copertine: dentro Discord le immagini esterne sono bloccate (CSP), quindi passano da qui.
// Solo domini di immagini noti, per non diventare un proxy aperto.
const THUMB_HOSTS = ['cdn.discordapp.com', 'ytimg.com', 'ggpht.com', 'googleusercontent.com', 'sndcdn.com', 'scdn.co', 'spotifycdn.com', 'vimeocdn.com', 'bcbits.com'];
const thumbCache = new Map(); // url -> { type, buf }
app.get('/api/thumb', async (req, res) => {
  let u;
  try {
    u = new URL(String(req.query.u || ''));
  } catch {
    return res.status(400).end();
  }
  const okHost = THUMB_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  if (u.protocol !== 'https:' || !okHost) return res.status(403).end();
  try {
    let hit = thumbCache.get(u.href);
    if (!hit) {
      const r = await fetch(u.href, { signal: AbortSignal.timeout(8000) });
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !type.startsWith('image/')) return res.status(502).end();
      hit = { type, buf: Buffer.from(await r.arrayBuffer()) };
      if (thumbCache.size > 300) thumbCache.delete(thumbCache.keys().next().value);
      thumbCache.set(u.href, hit);
    }
    res.set('Cache-Control', 'public, max-age=86400').type(hit.type).send(hit.buf);
  } catch {
    res.status(502).end();
  }
});

// Diagnostica del client (vedi client/src/diag.js): una riga di log, con limite di frequenza.
const diagAllowed = createDiagLimiter();
app.post('/api/diag', express.text({ type: 'text/plain', limit: '8kb' }), (req, res) => {
  const addr = clientAddr(req);
  if (!diagAllowed(addr)) return res.status(429).end();
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  console.log(diagLine(body, { addr }));
  res.status(204).end();
});

// Caricamento di un suono della Soundbar (biglietto chiesto prima sul WebSocket)
app.use(creaRouteSuoni({
  library: suoni,
  biglietti: bigliettiSuoni,
  converti: convertiSuono,
  maxMb: config.soundbarMaxMb,
  onCaricato: (guildId, suono, u) => {
    broadcast(guildId, { type: 'notice', kind: 'info', message: `${u.name} ha caricato «${suono.name}»` });
    mandaSuoni(guildId);
  },
}));

app.get('/api/health', (_req, res) => res.json({ ok: true, prova: config.prova, botOnline: Boolean(bot?.ready) }));

// Interfaccia compilata
const indexHtml = path.join(config.clientDist, 'index.html');
if (fs.existsSync(indexHtml)) {
  // La pagina HTML va sempre ricontrollata (no-cache): dopo una ricostruzione Discord e il browser
  // prendono subito quella nuova. Gli asset hanno l'hash nel nome: cache lunga e immutabile.
  app.use(express.static(config.clientDist, {
    index: false,
    cacheControl: false,
    setHeaders: (res, file) => {
      const f = file.replace(/\\/g, '/');
      if (f.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      else if (f.includes('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'public, max-age=3600');
    },
  }));
  app.get(/^\/(?!api\/|ws$).*/, (_req, res) =>
    res.sendFile(indexHtml, { cacheControl: false, headers: { 'Cache-Control': 'no-cache' } }));
} else {
  app.get('/', (_req, res) =>
    res.status(503).type('text').send('Interfaccia non compilata: esegui "npm run build" e riavvia.'),
  );
}

const server = http.createServer(app);

// ---------- WebSocket ----------
// 3 MB: abbastanza per un eventuale suono mandato come frame binario (ripiego), non di più
const wss = new WebSocketServer({ noServer: true, maxPayload: 3 * 1024 * 1024 });
wss.on('error', (err) => console.error('[ws] Errore del server WebSocket:', err.message));
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {}); // connessione interrotta durante l'handshake: niente da fare
  const p = new URL(req.url, 'http://x').pathname.replace(/^\/\.proxy/, '');
  if (p !== '/ws') {
    console.warn(`[ws] upgrade rifiutato: percorso ${p.slice(0, 60)}`);
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// Ping del protocollo ogni 25 s: chi non risponde viene chiuso (vedi heartbeat.js)
startHeartbeat(wss, { intervalMs: 25_000 });

let wsSeq = 0;
wss.on('connection', (ws, req) => {
  let guildId = null;
  let channelId = null;
  let user = null;
  // Una riga per apertura, esito della presentazione e chiusura (codice e durata).
  const id = ++wsSeq;
  const startedAt = Date.now();
  console.log(`[ws] #${id} aperta da ${clientAddr(req)}`);
  ws.on('close', (code) => console.log(closeLine({ id, code, startedAt, user, guildId })));
  // Ultimi risultati di ricerca di questo utente: restano suoi, non vanno a tutti.
  let searchResults = new Map();
  // Senza questo un frame rovinato o un socket interrotto sarebbe un'eccezione non gestita.
  ws.on('error', (err) => console.warn(`[ws] #${id} errore: ${err.message}`));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    // Battito dell'applicazione: il client controlla così che la connessione sia viva davvero.
    if (msg.type === 'ping') return send(ws, { type: 'pong', t: msg.t ?? null });

    if (msg.type === 'hello') {
      if (user) return; // già presentato
      const t0 = Date.now();
      let who;
      try {
        if (config.prova && !msg.accessToken) {
          who = { id: 'prova', name: msg.name || 'Prova' };
        } else {
          who = await auth.whoIs(String(msg.accessToken || ''));
          if (bot?.ready && msg.guildId) await auth.checkMember(String(msg.guildId), who.id);
        }
        if (!msg.guildId) throw new AuthError('server (guild) sconosciuto');
      } catch (err) {
        const temporary = err instanceof AuthError && err.temporary;
        const reauth = err instanceof AuthError && err.reauth;
        const closeCode = temporary ? CLOSE_RETRY : reauth ? CLOSE_REAUTH : CLOSE_DENIED;
        console.warn(`[ws] #${id} ${temporary ? 'rimandata' : 'rifiutata'} (${closeCode}) in ${formatDuration(Date.now() - t0)}: ${err.message}`);
        send(ws, {
          type: 'notice',
          kind: 'error',
          message: temporary ? `Verifica non riuscita: ${err.message}` : `Accesso negato: ${err.message}`,
        });
        // CLOSE_DENIED: il client smette di ritentare; CLOSE_RETRY: riprova;
        // CLOSE_REAUTH: chiede a Discord un token nuovo e riprova.
        ws.close(closeCode, temporary ? 'riprova' : reauth ? 'token rifiutato' : 'accesso negato');
        return;
      }
      if (ws.readyState !== 1) return; // chiuso mentre verificavo
      console.log(`[ws] #${id} accettata: ${who.name} (${msg.guildId}) in ${formatDuration(Date.now() - t0)}`);
      // Amministratore del server (permesso Administrator): può eliminare anche le playlist degli altri.
      // Senza bot (modalità prova) non si può sapere: in prova vale sì, per provare l'interfaccia.
      // Soundbar: carica chi è admin o ha uno dei ruoli di SOUNDBAR_RUOLO_ID (in prova: sì)
      const [isAdmin, haRuolo] = bot?.ready
        ? await Promise.all([bot.isAdmin(String(msg.guildId), who.id), bot.haRuolo(String(msg.guildId), who.id, config.soundbarRuoli)])
        : [config.prova, config.prova];
      if (ws.readyState !== 1) return;
      user = { ...who, isAdmin, puoCaricare: puoCaricare({ isAdmin, haRuolo }) };
      guildId = String(msg.guildId);
      channelId = msg.channelId ? String(msg.channelId) : null;
      if (!sockets.has(guildId)) sockets.set(guildId, new Set());
      sockets.get(guildId).add(ws);
      const g = music.get(guildId);
      g.setChannel(channelId); // non sposta il bot se è già in un canale vocale
      // Subito dopo welcome sempre lo stato completo: a ogni (ri)collegamento il client riparte da qui.
      send(ws, { type: 'welcome', user });
      send(ws, { type: 'state', state: g.snapshot() });
      send(ws, { type: 'playlists', playlists: playlists.list(guildId) });
      send(ws, { type: 'suoni', suoni: suoni.list(guildId) });
      return;
    }

    if (!guildId || !user) return send(ws, { type: 'notice', kind: 'error', message: 'Connessione non pronta' });
    const g = music.get(guildId);
    try {
      switch (msg.type) {
        case 'add': {
          // posizione: 'fine' (in coda, predefinita), 'prossimo' (riproduci dopo) o 'ora'.
          // reqId torna nell'avviso: il client sa quale pulsante ha finito di aspettare.
          const reqId = msg.reqId ?? null;
          send(ws, { type: 'notice', kind: 'busy', message: 'Cerco…', reqId });
          try {
            const r = await g.add(msg.query, { channelId, user: user.name, posizione: msg.posizione });
            send(ws, { type: 'notice', kind: 'info', message: r.message, reqId });
          } catch (err) {
            send(ws, { type: 'notice', kind: 'error', message: err.message, reqId });
          }
          break;
        }
        case 'anteprimaLink': {
          // Titolo e copertina di un link incollato, prima di scegliere dove metterlo.
          const info = await anteprimaLink(String(msg.query || ''));
          send(ws, { type: 'anteprimaLink', reqId: msg.reqId ?? null, query: msg.query, info });
          break;
        }
        case 'search': {
          const reqId = msg.reqId ?? null;
          const query = String(msg.query || '');
          try {
            const tracks = await searchMany(query, 10);
            searchResults = new Map(tracks.map((t) => [t.id, t]));
            send(ws, {
              type: 'results', reqId, query,
              results: tracks.map(({ id, title, author, duration, thumbnail }) => ({ id, title, author, duration, thumbnail })),
            });
          } catch (err) {
            send(ws, { type: 'results', reqId, query, results: [], error: err.message });
          }
          break;
        }
        case 'addResult': {
          const reqId = msg.reqId ?? null;
          const found = searchResults.get(msg.id);
          if (!found) {
            send(ws, { type: 'notice', kind: 'error', message: 'Risultato scaduto: ripeti la ricerca', reqId });
            break;
          }
          const track = { ...found, id: randomUUID(), requestedBy: user.name };
          const posizione = msg.now ? 'ora' : posizioneValida(msg.posizione);
          const subito = g.addTrack(track, { channelId, now: posizione === 'ora', posizione });
          send(ws, { type: 'notice', kind: 'info', message: messaggioAggiunta({ tracks: [track], posizione, subito }), reqId });
          break;
        }
        case 'playNow': g.playNow(msg.id); break;
        case 'toggle': g.togglePause({ channelId }); break;
        case 'skip': g.skip(); break;
        case 'stop': g.stop(); break;
        case 'remove': g.remove(msg.id); break;
        case 'move': g.move(msg.id, msg.to); break;
        case 'shuffle': g.shuffle(); break;
        case 'clear': g.clear(); break;
        case 'loop': g.setLoop(msg.mode); break;
        case 'volume': g.setVolume(msg.value); break;
        case 'seek': {
          const r = g.seek(msg.position);
          if (!r.ok) send(ws, { type: 'notice', kind: 'error', message: r.reason });
          break;
        }
        case 'riproduciDaStorico': g.playFromHistory(msg.id, { channelId }); break;
        case 'accodaDaStorico': {
          const t = g.queueFromHistory(msg.id, { channelId });
          if (t) send(ws, { type: 'notice', kind: 'info', message: `In coda: ${t.title}` });
          break;
        }
        // ---------- libreria di playlist (condivisa da tutto il server) ----------
        case 'playlistSave':
        case 'playlistLoad':
        case 'playlistRename':
        case 'playlistDelete': {
          const reqId = msg.reqId ?? null;
          const action = msg.type;
          try {
            let extra = {};
            if (action === 'playlistSave') {
              const overwrite = msg.overwrite === true;
              // Sovrascrivere la playlist di un altro richiede il permesso (ruoli aggiornati)
              const isAdmin = overwrite && bot?.ready ? await bot.isAdmin(guildId, user.id) : user.isAdmin;
              const r = await playlists.save(guildId, {
                name: msg.name, tracks: g.braniPerPlaylist(), user: { ...user, isAdmin }, overwrite,
              });
              extra = { playlist: r.playlist, overwritten: r.overwritten, truncated: r.truncated };
            } else if (action === 'playlistLoad') {
              const p = playlists.trova(guildId, String(msg.id ?? ''));
              const mode = msg.mode === 'replace' ? 'replace' : 'append';
              const count = g.loadPlaylist(p.tracks, { mode, channelId, user: user.name });
              extra = { playlist: playlists.list(guildId).find((x) => x.id === p.id), mode, count };
            } else {
              // Rinomina ed elimina: solo chi l'ha creata o un amministratore. Permesso controllato con
              // i dati freschi: un ruolo può essere cambiato dopo il collegamento.
              const isAdmin = bot?.ready ? await bot.isAdmin(guildId, user.id) : user.isAdmin;
              const chi = { ...user, isAdmin };
              const id = String(msg.id ?? '');
              extra = action === 'playlistRename'
                ? { playlist: await playlists.rename(guildId, { id, name: msg.name, user: chi }) }
                : { playlist: await playlists.delete(guildId, { id, user: chi }) };
            }
            send(ws, { type: 'playlistResult', reqId, action, ok: true, ...extra });
            if (action !== 'playlistLoad') mandaPlaylist(guildId);
          } catch (err) {
            const known = err instanceof PlaylistError;
            if (!known) console.error(`[playlist] ${action}:`, err.message);
            send(ws, {
              type: 'playlistResult', reqId, action, ok: false,
              error: known ? err.message : 'Errore interno', code: known ? err.code : 'interno',
            });
          }
          break;
        }
        // ---------- Soundbar ----------
        case 'suonoBiglietto': {
          // Permesso ricontrollato con i dati freschi; il biglietto vale 60 s per un solo caricamento
          const reqId = msg.reqId ?? null;
          const p = await permessoCarica(guildId, user);
          user.puoCaricare = p.puoCaricare;
          if (!p.puoCaricare) {
            send(ws, { type: 'suonoBiglietto', reqId, ok: false, error: 'Serve il ruolo Soundbar per caricare suoni', code: 'permesso' });
            break;
          }
          send(ws, { type: 'suonoBiglietto', reqId, ok: true, ticket: bigliettiSuoni.crea(guildId, user) });
          break;
        }
        case 'suona': {
          try {
            const attesa = limitaSuoni.attesa(guildId, user.id);
            if (attesa > 0) throw new SoundError(pianoMsg(attesa), 'piano');
            const s = suoni.trova(guildId, String(msg.id ?? ''));
            const r = await g.suona(s, { file: suoni.daSuonare(guildId, s), by: user.name, channelId });
            if (r.prova) send(ws, { type: 'notice', kind: 'info', message: 'Suonato (solo in Discord)' });
          } catch (err) {
            if (!(err instanceof SoundError)) console.error('[suoni] suona:', err.message);
            send(ws, { type: 'notice', kind: 'error', message: err.message });
          }
          break;
        }
        case 'suonoFerma': g.suoni.interrompi(); break;
        case 'suonoRinomina':
        case 'suonoVolume':
        case 'suonoElimina': {
          const reqId = msg.reqId ?? null;
          const action = msg.type;
          try {
            // Solo chi l'ha caricato o un amministratore (permesso con i dati freschi)
            const isAdmin = bot?.ready ? await bot.isAdmin(guildId, user.id) : user.isAdmin;
            const chi = { ...user, isAdmin };
            const id = String(msg.id ?? '');
            let suono;
            if (action === 'suonoRinomina') {
              suono = await suoni.rinomina(guildId, { id, name: msg.name, user: chi });
            } else if (action === 'suonoVolume') {
              // Vale dal prossimo «suona» (il suono in corso finisce col volume di prima)
              suono = await suoni.regolaVolume(guildId, { id, volume: msg.volume, user: chi });
            } else {
              suono = await suoni.elimina(guildId, { id, user: chi });
              if (g.suoni.attivo?.id === id) g.suoni.interrompi();
            }
            send(ws, { type: 'suonoResult', reqId, action, ok: true, suono });
            mandaSuoni(guildId);
          } catch (err) {
            const known = err instanceof SoundError;
            if (!known) console.error(`[suoni] ${action}:`, err.message);
            send(ws, {
              type: 'suonoResult', reqId, action, ok: false,
              error: known ? err.message : 'Errore interno', code: known ? err.code : 'altro',
            });
          }
          break;
        }
        case 'precedente': {
          const r = g.previous({ channelId });
          if (!r.ok) send(ws, { type: 'notice', kind: 'error', message: r.reason });
          break;
        }
        default: send(ws, { type: 'notice', kind: 'error', message: `Azione sconosciuta: ${msg.type}` });
      }
    } catch (err) {
      send(ws, { type: 'notice', kind: 'error', message: err.message });
    }
  });

  ws.on('close', () => {
    if (guildId) sockets.get(guildId)?.delete(ws);
  });
});

server.listen(config.port, () => {
  console.log(`[server] In ascolto su http://localhost:${config.port}`);
  if (config.prova) {
    console.log(`[server] Modalità prova: apri http://localhost:${config.port} nel browser`);
  }
});

let chiusura = false;
const chiudi = async () => {
  if (chiusura) return;
  chiusura = true;
  console.log('\n[server] Chiusura…');
  setTimeout(() => process.exit(0), 3000).unref();
  // Prima si salva la coda così com'è (con il brano in corso); poi stop() chiude audio e canale.
  await store.flush().catch(() => {});
  store.close();
  for (const g of music.guilds.values()) g.stop();
  // Prima di scollegarsi, il canale torna com'era (al massimo 2 s, poi si chiude comunque)
  await Promise.race([statoCanale.ripristinaTutti(), new Promise((r) => setTimeout(r, 2000).unref())]).catch(() => {});
  bot?.client.destroy();
  for (const ws of wss.clients) ws.terminate();
  server.close(() => process.exit(0));
};
process.on('SIGINT', chiudi);
process.on('SIGTERM', chiudi);
