// Stabilità: attese di riconnessione, battito, salvataggio della coda, canale vocale, verifica
// dell'accesso e blocchi dell'audio. Niente Discord né yt-dlp. Avvio: npm test
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { backoffDelay, createHeartbeat, CLOSE_DENIED as C_DENIED, CLOSE_RETRY as C_RETRY } from '../../client/src/reconnect.js';
import { startHeartbeat } from '../src/heartbeat.js';
import { QueueStore } from '../src/store.js';
import { GuildMusic, MusicManager } from '../src/music.js';
import { AuthError, CLOSE_DENIED, CLOSE_RETRY, createAuth } from '../src/auth.js';

afterEach(() => mock.timers.reset());

const flush = () => new Promise((r) => setImmediate(r));
const track = (title) => ({ id: title, title, author: 'Test', url: `https://www.youtube.com/watch?v=${title}`, duration: 200, thumbnail: null, requestedBy: 'Test', query: null });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsmusic-test-'));

// ---------- attese di riconnessione ----------
test('backoff: parte da 0,5 s, raddoppia, si ferma a 15 s, con parte casuale', () => {
  const min = (n) => backoffDelay(n, { random: () => 0 });
  const max = (n) => backoffDelay(n, { random: () => 1 });
  assert.equal(max(0), 500);
  assert.equal(min(0), 250);
  assert.equal(max(1), 1000);
  assert.equal(max(2), 2000);
  assert.equal(max(4), 8000);
  assert.equal(max(5), 15_000); // 16 s → limitato a 15 s
  assert.equal(max(50), 15_000);
  assert.equal(min(50), 7500);
  for (let n = 0; n < 20; n++) {
    const d = backoffDelay(n);
    assert.ok(d >= 250 && d <= 15_000, `tentativo ${n}: ${d} ms`);
  }
  // valori strani: come il primo tentativo
  assert.equal(backoffDelay(-3, { random: () => 1 }), 500);
  assert.equal(backoffDelay(undefined, { random: () => 1 }), 500);
});

test('codici di chiusura uguali tra client e server', () => {
  assert.equal(C_DENIED, CLOSE_DENIED);
  assert.equal(C_RETRY, CLOSE_RETRY);
});

// ---------- battito lato client ----------
test('battito client: ping ogni 20 s, dopo 2 pong mancati la connessione è morta', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let pings = 0;
  let dead = 0;
  const hb = createHeartbeat({ sendPing: () => pings++, onDead: () => dead++ });
  hb.start();
  mock.timers.tick(20_000);
  assert.equal(pings, 1);
  mock.timers.tick(20_000);
  assert.equal(pings, 2);
  assert.equal(dead, 0);
  mock.timers.tick(20_000);
  assert.equal(dead, 1);
  mock.timers.tick(60_000);
  assert.equal(dead, 1, 'onDead una volta sola');
  assert.equal(pings, 2, 'dopo la morte niente più ping');
});

test('battito client: con le risposte resta vivo', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let dead = 0;
  const hb = createHeartbeat({ sendPing: () => hb.alive(), onDead: () => dead++ });
  hb.start();
  mock.timers.tick(10 * 60_000);
  assert.equal(dead, 0);
  hb.stop();
});

test('battito client: probe (pagina di nuovo visibile) senza risposta in 5 s chiude', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let pings = 0;
  let dead = 0;
  const hb = createHeartbeat({ sendPing: () => pings++, onDead: () => dead++ });
  hb.start();
  hb.probe();
  assert.equal(pings, 1, 'ping subito');
  mock.timers.tick(4_999);
  assert.equal(dead, 0);
  mock.timers.tick(1);
  assert.equal(dead, 1);

  // con risposta in tempo resta viva
  dead = 0;
  hb.start();
  hb.probe();
  hb.alive();
  mock.timers.tick(5_000);
  assert.equal(dead, 0);
  hb.stop();
});

// ---------- battito lato server ----------
function fakeWss() {
  const wss = new EventEmitter();
  wss.clients = new Set();
  wss.add = () => {
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.pings = 0;
    ws.terminated = false;
    ws.ping = () => ws.pings++;
    ws.terminate = () => { ws.terminated = true; wss.clients.delete(ws); };
    wss.clients.add(ws);
    wss.emit('connection', ws);
    return ws;
  };
  return wss;
}

test('battito server: chi risponde resta, chi non risponde al pong viene chiuso', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const wss = fakeWss();
  const stop = startHeartbeat(wss, { intervalMs: 25_000 });
  const buono = wss.add();
  const morto = wss.add();
  const chiacchierone = wss.add();

  mock.timers.tick(25_000);
  assert.equal(buono.pings, 1);
  assert.equal(morto.pings, 1);
  buono.emit('pong');
  chiacchierone.emit('message', '{"type":"ping"}'); // anche un messaggio vale come risposta

  mock.timers.tick(25_000);
  assert.equal(morto.terminated, true);
  assert.equal(buono.terminated, false);
  assert.equal(chiacchierone.terminated, false);
  assert.equal(buono.pings, 2);
  stop();
});

// ---------- salvataggio della coda ----------
test('coda salvata: scrittura ritardata e atomica, poi ricaricata da un nuovo processo', async () => {
  const dir = path.join(tmpDir(), 'dati'); // la cartella non esiste ancora: la crea
  const store = new QueueStore({ dir, delayMs: 20 });
  const data = { v: 1, channelId: 'voce-1', current: track('A'), queue: [track('B'), track('C')], volume: 35, loop: 'queue' };
  store.save('123', data);
  store.save('123', { ...data, volume: 40 }); // tante modifiche di fila: una scrittura
  assert.equal(fs.existsSync(dir), false, 'non scrive subito');
  await store.flush();

  const files = fs.readdirSync(dir);
  assert.deepEqual(files, ['coda-123.json'], 'niente file temporanei rimasti');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'coda-123.json'), 'utf8'));
  assert.equal(saved.volume, 40);
  assert.equal(saved.guildId, '123');

  // "riavvio": un altro store sulla stessa cartella
  const loaded = new QueueStore({ dir }).loadAll();
  assert.equal(loaded.size, 1);
  assert.deepEqual(loaded.get('123').queue.map((t) => t.title), ['B', 'C']);
});

test('coda salvata: close() scrive subito e poi ignora; file rovinati saltati', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'coda-rotto.json'), '{ non è json');
  fs.writeFileSync(path.join(dir, 'altro.txt'), 'x');
  const store = new QueueStore({ dir, delayMs: 60_000 });
  store.save('9', { v: 1, current: null, queue: [track('X')], volume: 60, loop: 'off' });
  store.close();
  store.save('9', { v: 1, current: null, queue: [], volume: 60, loop: 'off' }); // dopo close: ignorato
  const warn = mock.method(console, 'warn', () => {});
  const loaded = new QueueStore({ dir }).loadAll();
  warn.mock.restore();
  assert.equal(loaded.size, 1, 'il file rovinato non blocca gli altri');
  assert.deepEqual(loaded.get('9').queue.map((t) => t.title), ['X']);
});

test('ricarica: il brano che suonava torna in cima, in pausa e senza rientrare in voce', () => {
  const bot = { ready: true, joins: 0, isConnected: () => false, inVoice: () => false, join() { this.joins++; } };
  const g = new GuildMusic('g', { bot, onChange: () => {}, onNotice: () => {} });
  g.restore({ v: 1, channelId: 'voce-7', current: track('A'), queue: [track('B'), { title: 'senza link' }, null], volume: 25, loop: 'track' });
  assert.equal(g.current, null);
  assert.deepEqual(g.queue.map((t) => t.title), ['A', 'B'], 'brani non validi scartati');
  assert.equal(g.away, true, 'play lo fa rientrare');
  assert.equal(g.paused, false);
  assert.equal(g.volume, 25);
  assert.equal(g.loop, 'track');
  assert.equal(g.channelId, 'voce-7');
  assert.equal(bot.joins, 0);
  const snap = g.snapshot();
  assert.equal(snap.queue.length, 2);
  assert.equal(snap.away, true);

  // valori strani: ignorati
  const h = new GuildMusic('h', { bot, onChange: () => {}, onNotice: () => {} });
  h.restore({ volume: 'tanto', loop: 'boh', queue: 'non lista' });
  assert.equal(h.volume, 60);
  assert.equal(h.loop, 'off');
  assert.deepEqual(h.queue, []);
});

test('ogni modifica della coda va al salvataggio; restoreAll la ritrova', async () => {
  const dir = tmpDir();
  const store = new QueueStore({ dir, delayMs: 10 });
  const music = new MusicManager({ bot: null, onChange: () => {}, onNotice: () => {}, store });
  const g = music.get('55');
  g.queue.push(track('A'), track('B'));
  g.setVolume(42);
  g.setLoop('queue');
  await store.flush();

  const store2 = new QueueStore({ dir });
  const music2 = new MusicManager({ bot: null, onChange: () => {}, onNotice: () => {}, store: store2 });
  assert.equal(music2.restoreAll(), 1);
  const g2 = music2.get('55');
  assert.deepEqual(g2.queue.map((t) => t.title), ['A', 'B']);
  assert.equal(g2.volume, 42);
  assert.equal(g2.loop, 'queue');
});

// ---------- canale vocale ----------
test('channelId cambia solo se il bot non è già in un canale vocale', async () => {
  const bot = { ready: true, voice: false, isConnected() { return this.voice; }, inVoice() { return this.voice; }, countHumans: () => 1, leave() { this.voice = false; } };
  const g = new GuildMusic('g', { bot, onChange: () => {}, onNotice: () => {}, idleMinutes: 0, emptySeconds: 0 }); // senza timer di uscita
  g.startReal = async () => { bot.voice = true; g.audio = { kill() {} }; };

  g.setChannel('voce-1');
  assert.equal(g.channelId, 'voce-1', 'fuori dal canale: si imposta');
  g.addTrack(track('A'), { channelId: 'voce-1' });
  await flush();
  await flush();
  assert.equal(bot.voice, true);

  // altri utenti da altri canali: il bot resta dov'è
  g.addTrack(track('B'), { channelId: 'voce-2' });
  g.setChannel('voce-3');
  g.togglePause({ channelId: 'voce-4' });
  assert.equal(g.channelId, 'voce-1');

  // il bot esce: il prossimo canale scelto vale
  g.stop();
  assert.equal(bot.voice, false);
  g.setChannel('voce-2');
  assert.equal(g.channelId, 'voce-2');
  g.setChannel(null);
  assert.equal(g.channelId, 'voce-2', 'null non cancella il canale');

  // Discord sposta il bot: vale sempre
  bot.voice = true;
  g.botVoiceChanged('voce-9');
  assert.equal(g.channelId, 'voce-9');
});

// ---------- verifica dell'accesso ----------
const risposta = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('accesso: 401 è definitivo, 429/5xx/timeout/rete sono temporanei', async () => {
  const prova = async (fetchImpl) => {
    try {
      await createAuth({ fetchImpl }).whoIs('tok');
      return 'ok';
    } catch (err) {
      assert.ok(err instanceof AuthError);
      return err.temporary ? 'temporaneo' : 'definitivo';
    }
  };
  assert.equal(await prova(async () => risposta(401)), 'definitivo');
  assert.equal(await prova(async () => risposta(429)), 'temporaneo');
  assert.equal(await prova(async () => risposta(503)), 'temporaneo');
  assert.equal(await prova(async () => { throw Object.assign(new Error('scaduto'), { name: 'TimeoutError' }); }), 'temporaneo');
  assert.equal(await prova(async () => { throw new TypeError('fetch failed'); }), 'temporaneo');
  assert.equal(await prova(async () => risposta(200, { id: '1', username: 'prova' })), 'ok');
  await assert.rejects(createAuth({ fetchImpl: async () => risposta(200) }).whoIs(''), (e) => !e.temporary);
});

test('accesso: utente e membro in cache per 10 minuti', async () => {
  let t = 1_000_000;
  let calls = 0;
  let memberCalls = 0;
  const auth = createAuth({
    now: () => t,
    fetchImpl: async () => { calls++; return risposta(200, { id: 'u1', global_name: 'Prova' }); },
    fetchMember: async () => { memberCalls++; return { id: 'u1' }; },
  });
  assert.deepEqual(await auth.verify({ accessToken: 'tok', guildId: 'g' }), { id: 'u1', name: 'Prova' });
  await auth.verify({ accessToken: 'tok', guildId: 'g' });
  assert.equal(calls, 1);
  assert.equal(memberCalls, 1);
  t += 10 * 60_000 + 1;
  await auth.verify({ accessToken: 'tok', guildId: 'g' });
  assert.equal(calls, 2, 'cache scaduta: chiede di nuovo');
  assert.equal(memberCalls, 2);
});

test('accesso: membro sconosciuto è definitivo, membro lento o 429 è temporaneo', async () => {
  const membro = (fetchMember, timeoutMs = 5000) => createAuth({ fetchImpl: async () => risposta(200, { id: 'u' }), fetchMember, timeoutMs })
    .checkMember('g', 'u')
    .then(() => 'ok', (e) => (e.temporary ? 'temporaneo' : 'definitivo'));
  assert.equal(await membro(async () => { throw Object.assign(new Error('Unknown Member'), { code: 10007 }); }), 'definitivo');
  assert.equal(await membro(async () => { throw Object.assign(new Error('Unknown Guild'), { code: 10004 }); }), 'definitivo');
  assert.equal(await membro(async () => null), 'definitivo');
  assert.equal(await membro(async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); }), 'temporaneo');
  assert.equal(await membro(() => new Promise(() => {}), 20), 'temporaneo', 'nessuna risposta: timeout');
  assert.equal(await membro(async () => ({ id: 'u' })), 'ok');
});

// ---------- blocchi dell'audio ----------
test('audio fermo da 30 s: processi chiusi, avviso e brano successivo; in pausa non scatta', async () => {
  const notices = [];
  const g = new GuildMusic('g', { bot: null, onChange: () => {}, onNotice: (_id, n) => notices.push(n.message), stallSeconds: 30 });
  let kills = 0;
  let idle = 0;
  g.startReal = async () => {};
  g.addTrack(track('A'));
  g.addTrack(track('B'));
  await flush();
  await flush();
  assert.equal(g.current?.title, 'A');
  g.audio = { kill: () => kills++, idleMs: () => idle, touch: () => { idle = 0; }, bytes: () => 1 };

  idle = 29_000;
  g.checkStall();
  assert.equal(g.current?.title, 'A');

  g.pause();
  idle = 120_000;
  g.checkStall();
  assert.equal(g.current?.title, 'A', 'in pausa non conta');
  g.resume();
  assert.equal(idle, 0, 'alla ripresa il conto riparte');

  idle = 31_000;
  g.checkStall();
  assert.equal(kills, 1, 'processi chiusi');
  assert.match(notices.at(-1), /«A».*audio fermo/);
  await flush();
  await flush();
  assert.equal(g.current?.title, 'B');
  g.stop();
});
