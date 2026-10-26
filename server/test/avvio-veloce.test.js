// Partenza veloce: link YouTube risolto con una sola chiamata, playlist caricata dopo,
// via veloce ffmpeg con ripieghi (link vecchio → nuovo link, poi yt-dlp | ffmpeg). Avvio: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuildMusic } from '../src/music.js';
import { videoIdDaLink, haPlaylist } from '../src/resolver.js';
import { erroreAudio, headerArgs } from '../src/audio.js';

const flush = () => new Promise((r) => setImmediate(r));
const opzioni = () => ({ bot: null, onChange() {}, onNotice() {}, idleMinutes: 0, emptySeconds: 0 });
const brano = (id, extra = {}) => ({ id: `t-${id}-${Math.random()}`, title: `Brano ${id}`, author: 'Test', url: `https://www.youtube.com/watch?v=${id}`, duration: 200, thumbnail: null, requestedBy: null, query: null, ...extra });
const ID = 'pRpeEdMmmQ0';
const stream = (extra = {}) => ({ url: 'https://cdn/a', headers: {}, exp: Date.now() + 60_000, direct: true, track: brano(ID), ...extra });

/** Audio finto: ready() riesce o fallisce con il messaggio dato. */
const audioFinto = (log, tipo, errore = null) => (...args) => {
  log.push({ tipo, args });
  return { stream: null, kill() {}, touch() {}, bytes: () => 1, idleMs: () => 0, ready: async () => { if (errore) throw new Error(errore); } };
};

test('link YouTube: id del video e playlist', () => {
  assert.equal(videoIdDaLink(`https://www.youtube.com/watch?v=${ID}`), ID);
  assert.equal(videoIdDaLink(`https://youtu.be/${ID}?si=abc`), ID);
  assert.equal(videoIdDaLink(`https://music.youtube.com/watch?v=${ID}&list=RDx`), ID);
  assert.equal(videoIdDaLink(`https://www.youtube.com/shorts/${ID}`), ID);
  assert.equal(videoIdDaLink('https://www.youtube.com/playlist?list=PLabc'), null);
  assert.equal(videoIdDaLink('https://soundcloud.com/a/b'), null);
  assert.equal(videoIdDaLink('waka waka'), null);
  assert.equal(haPlaylist(`https://www.youtube.com/watch?v=${ID}&list=RD${ID}`), true);
  assert.equal(haPlaylist(`https://www.youtube.com/watch?v=${ID}`), false);
});

test('header per ffmpeg: User-Agent a parte, gli altri in -headers, niente a capo iniettati', () => {
  assert.deepEqual(headerArgs({ 'User-Agent': 'UA', Accept: '*/*', 'Bad\r\nX': 'y' }), ['-user_agent', 'UA', '-headers', 'Accept: */*\r\n']);
  assert.deepEqual(headerArgs(undefined), []);
  assert.equal(erroreAudio(new Error('pipe:0: Invalid data found when processing input')), 'il flusso audio ricevuto non è valido');
});

test('link singolo: una chiamata dà brano e stream, il brano parte dalla cache senza risolvere di nuovo', async () => {
  const g = new GuildMusic('g', opzioni());
  const chiamate = [];
  g.lib.getStream = async (url) => { chiamate.push(url); return stream(); };
  g.lib.resolveInput = async () => { throw new Error('non deve servire'); };
  const r = await g.add(`https://youtu.be/${ID}`);
  assert.equal(r.count, 1);
  assert.equal(g.current.title, `Brano ${ID}`);
  assert.equal(chiamate.length, 1);
  const s = await g.streamInfo(g.current);
  assert.equal(s.fromCache, true);
  assert.equal(chiamate.length, 1, 'nessuna seconda chiamata a yt-dlp');
  g.stop();
});

test('playlist: il primo brano parte subito, il resto arriva dopo (senza doppione del primo)', async () => {
  const g = new GuildMusic('g', opzioni());
  let finisci;
  g.lib.getStream = async () => stream();
  g.lib.resolveInput = () => new Promise((res) => { finisci = res; });
  const avvisi = [];
  g.onNotice = (_id, n) => avvisi.push(n.message);

  const r = await g.add(`https://www.youtube.com/watch?v=${ID}&list=RD${ID}`);
  assert.match(r.message, /carico il resto/);
  assert.equal(g.current.title, `Brano ${ID}`, 'parte prima che la playlist sia letta');
  assert.equal(g.queue.length, 0);

  finisci({ tracks: [brano(ID), brano('bbbbbbbbbbb'), brano('ccccccccccc')], playlistTitle: 'Mix' });
  await flush();
  assert.deepEqual(g.queue.map((t) => t.title), ['Brano bbbbbbbbbbb', 'Brano ccccccccccc']);
  assert.match(avvisi.at(-1), /Aggiunti altri 2 brani da «Mix»/);
  g.stop();
});

test('playlist arrivata dopo stop: non riempie la coda', async () => {
  const g = new GuildMusic('g', opzioni());
  let finisci;
  g.lib.getStream = async () => stream();
  g.lib.resolveInput = () => new Promise((res) => { finisci = res; });
  await g.add(`https://www.youtube.com/watch?v=${ID}&list=PLx`);
  g.stop();
  finisci({ tracks: [brano('bbbbbbbbbbb')], playlistTitle: null });
  await flush();
  assert.deepEqual(g.queue, []);
});

test('audio: link in cache non valido → link nuovo e secondo tentativo', async () => {
  const g = new GuildMusic('g', opzioni());
  const log = [];
  let n = 0;
  g.lib.getStream = async () => stream({ url: `https://cdn/${++n}` });
  const t = brano(ID);
  g.cacheStream(t.url, stream({ url: 'https://cdn/vecchio' }));
  let prima = true;
  g.lib.createOpusStreamAt = (info, at) => {
    const err = prima ? 'pipe: Invalid data found when processing input' : null;
    prima = false;
    return audioFinto(log, 'diretto', err)(info.url, at);
  };
  g.lib.createOpusStream = audioFinto(log, 'ripiego');
  await g.openAudio(t, 30);
  assert.deepEqual(log.map((x) => [x.tipo, ...x.args]), [['diretto', 'https://cdn/vecchio', 30], ['diretto', 'https://cdn/1', 30]]);
});

test('audio: 403 su un link appena chiesto → subito il ripiego yt-dlp | ffmpeg', async () => {
  const g = new GuildMusic('g', opzioni());
  const log = [];
  g.lib.getStream = async () => stream({ url: 'https://cdn/x' });
  g.lib.createOpusStreamAt = (info, at) => audioFinto(log, 'diretto', 'Server returned 403 Forbidden')(info.url, at);
  g.lib.createOpusStream = audioFinto(log, 'ripiego');
  const t = brano(ID);
  await g.openAudio(t, 0);
  assert.deepEqual(log.map((x) => x.tipo), ['diretto', 'ripiego']);
  assert.deepEqual(log[1].args, [t.url, 0, { volume: 60 }]);
});

test('audio: link non leggibile da ffmpeg (direct=false) → ripiego, e se fallisce anche quello errore chiaro', async () => {
  const g = new GuildMusic('g', opzioni());
  const log = [];
  g.lib.getStream = async () => stream({ direct: false });
  g.lib.createOpusStreamAt = audioFinto(log, 'diretto');
  g.lib.createOpusStream = audioFinto(log, 'ripiego', 'pipe:0: Invalid data found when processing input');
  await assert.rejects(g.openAudio(brano(ID), 0), /flusso audio ricevuto non è valido/);
  assert.deepEqual(log.map((x) => x.tipo), ['ripiego']);
});

test('prefetch: mentre suona prepara lo stream del prossimo (una sola volta)', async () => {
  const g = new GuildMusic('g', opzioni());
  g.bot = { ready: true, inVoice: () => true };
  let chiamate = 0;
  g.lib.getStream = async () => { chiamate++; return stream({ track: null }); };
  g.current = brano('aaaaaaaaaaa');
  g.queue.push(brano('bbbbbbbbbbb'));
  await Promise.all([g.prefetch(), g.prefetch()]);
  assert.equal(chiamate, 1);
  assert.equal(g.streamCache.has('https://www.youtube.com/watch?v=bbbbbbbbbbb'), true);
  await g.prefetch();
  assert.equal(chiamate, 1, 'già in cache');
});
