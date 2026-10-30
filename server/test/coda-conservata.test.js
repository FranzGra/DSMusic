// La coda si svuota solo con il cestino: stop, uscite e guasti la lasciano com'è. Niente Discord né yt-dlp.
// Avvio: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuildMusic, MusicManager } from '../src/music.js';
import { QueueStore } from '../src/store.js';

const creati = [];
const cartelle = [];
afterEach(() => {
  for (const g of creati.splice(0)) g.stop();
  for (const d of cartelle.splice(0)) rmSync(d, { recursive: true, force: true });
});

let n = 0;
const track = (title) => ({
  id: `${title}-${++n}`, title, author: 'Test', url: `https://soundcloud.com/x/${title}`,
  duration: 200, thumbnail: null, requestedBy: 'Test', query: null,
});
const attendi = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const titoli = (g) => g.queue.map((t) => t.title);

function setup(bot = null) {
  const salvati = [];
  const avvisi = [];
  const g = new GuildMusic('g', {
    bot, onChange() {}, onPersist: (_g, d) => salvati.push(d),
    onNotice: (_g, a) => avvisi.push(a), idleMinutes: 0, emptySeconds: 0,
  });
  g.cache = { proteggi() {}, ha: () => false };
  g.lib = { ...g.lib, resolveInput: async (q) => ({ tracks: [track(q)], playlistTitle: null }) };
  creati.push(g);
  return { g, salvati, avvisi };
}

test('stop: la coda resta con il brano in corso in cima, e si salva', async () => {
  const { g, salvati } = setup();
  await g.add('A');
  await g.add('B');
  await g.add('C');
  await attendi();
  assert.equal(g.current.title, 'A');

  g.stop();
  assert.equal(g.current, null);
  assert.deepEqual(titoli(g), ['A', 'B', 'C']);
  assert.equal(g.away, true);
  assert.equal(g.paused, false);
  assert.equal(g.pausedPos, 0, 'il brano riparte dall\'inizio');

  const salvato = salvati.at(-1);
  assert.deepEqual(salvato.queue.map((t) => t.title), ['A', 'B', 'C']);
  assert.equal(salvato.current, null);
});

test('stop due volte: la coda non cambia', async () => {
  const { g } = setup();
  await g.add('A');
  await g.add('B');
  g.stop();
  g.stop();
  assert.deepEqual(titoli(g), ['A', 'B']);
});

test('dopo stop il bot non rientra da solo: al primo play riparte il primo brano', async () => {
  const bot = {
    ready: false, joins: 0, leaves: 0, isConnected: () => false, inVoice: () => false,
    join() { this.joins++; }, leave() { this.leaves++; },
  };
  const { g } = setup(bot);
  g.queue.push(track('A'), track('B'));
  g.stop();
  await attendi();
  assert.equal(bot.leaves, 1);
  assert.equal(bot.joins, 0);
  assert.equal(g.current, null);

  await g.togglePause();
  await attendi();
  assert.equal(g.current.title, 'A');
  assert.deepEqual(titoli(g), ['B']);
  assert.equal(g.away, false);
});

test('il cestino azzera la coda, anche dopo uno stop', async () => {
  const { g, salvati } = setup();
  await g.add('A');
  await g.add('B');
  g.stop();
  assert.equal(g.clear(), 2);
  assert.deepEqual(g.queue, []);
  assert.deepEqual(salvati.at(-1).queue, []);
});

test('riavvio: la coda fermata con stop si ricarica', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coda-conservata-'));
  cartelle.push(dir);
  const store = new QueueStore({ dir, delayMs: 10 });
  const music = new MusicManager({ bot: null, onChange() {}, onNotice() {}, store });
  const g = music.get('55');
  creati.push(g);
  g.queue.push(track('A'), track('B'));
  g.stop();
  await store.flush();

  const store2 = new QueueStore({ dir });
  const music2 = new MusicManager({ bot: null, onChange() {}, onNotice() {}, store: store2 });
  assert.equal(music2.restoreAll(), 1);
  const g2 = music2.get('55');
  creati.push(g2);
  assert.deepEqual(titoli(g2), ['A', 'B']);
  assert.equal(g2.current, null);
  assert.equal(g2.away, true);
});

test('canale vocale mancante: nessun brano consumato, la coda resta', async () => {
  const bot = { ready: true, isConnected: () => false, inVoice: () => false, join() {}, leave() {} };
  const { g, avvisi } = setup(bot);
  g.queue.push(track('A'), track('B'), track('C'));
  g.channelId = null;
  await g.playNext({ fromEnd: false });
  await attendi();
  assert.equal(g.current, null);
  assert.deepEqual(titoli(g), ['A', 'B', 'C']);
  assert.equal(g.away, true);
  assert.equal(avvisi.length, 1);
  assert.match(avvisi[0].message, /la coda resta/);
});

test('brani che falliscono: uno passa al prossimo, il terzo di fila ferma tutto', async () => {
  const { g, avvisi } = setup();
  g.queue.push(track('A'), track('B'), track('C'), track('D'), track('E'));
  await g.playNext({ fromEnd: false });
  await attendi();
  assert.equal(g.current.title, 'A');
  assert.equal(g.fallimenti, 0);

  g.audioFailed('primo'); // via A
  g.audioFailed('secondo'); // via B, senza che C abbia fatto in tempo a partire
  assert.equal(g.current.title, 'C');
  g.audioFailed('terzo'); // qui si ferma: C torna in cima
  await attendi();
  assert.equal(g.current, null);
  assert.deepEqual(titoli(g), ['C', 'D', 'E']);
  assert.equal(g.away, true);
  assert.match(avvisi.at(-1).message, /la coda resta/);
});

test('un brano che parte azzera il conto dei fallimenti', async () => {
  const { g } = setup();
  g.queue.push(track('A'), track('B'), track('C'));
  await g.playNext({ fromEnd: false });
  await attendi();
  g.audioFailed('rotto');
  assert.equal(g.fallimenti, 1);
  await attendi();
  assert.equal(g.current.title, 'B');
  assert.equal(g.fallimenti, 0);
});
