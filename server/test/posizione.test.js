// «Aggiungi in coda» e «Riproduci dopo»: dove finiscono i brani aggiunti. Niente Discord né yt-dlp.
// Avvio: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GuildMusic, messaggioAggiunta, posizioneValida } from '../src/music.js';
import { COMMANDS, handleCommand, handleTextMessage, parseText } from '../src/commands.js';
import { anteprimaLink } from '../src/resolver.js';

// In modalità prova un timer simula la fine del brano: alla fine di ogni test si ferma tutto.
const creati = [];
afterEach(() => { for (const g of creati.splice(0)) g.stop(); });

const flush = () => new Promise((r) => setImmediate(r));
let n = 0;
const track = (title) => ({
  id: `${title}-${++n}`, title, author: 'Test', url: `https://soundcloud.com/x/${title}`,
  duration: 200, thumbnail: null, requestedBy: 'Test', query: null,
});
const titoli = (g) => g.queue.map((t) => t.title);

/** Musica in modalità prova (senza bot): resolveInput finto, risponde con i brani indicati. */
function setup() {
  const notices = [];
  const g = new GuildMusic('g', { bot: null, onChange() {}, onNotice: (_g, m) => notices.push(m), idleMinutes: 0, emptySeconds: 0 });
  creati.push(g);
  const risposte = new Map();
  g.lib = {
    ...g.lib,
    resolveInput: async (q) => {
      const r = risposte.get(q);
      if (r) return r();
      return { tracks: [track(q)], playlistTitle: null };
    },
  };
  return { g, risposte, notices };
}

test('posizione: solo fine, prossimo e ora; il resto è fine', () => {
  assert.equal(posizioneValida('prossimo'), 'prossimo');
  assert.equal(posizioneValida('ora'), 'ora');
  assert.equal(posizioneValida(undefined), 'fine');
  assert.equal(posizioneValida('cima'), 'fine');
});

test('in coda: in fondo, come prima', async () => {
  const { g } = setup();
  await g.add('A');
  await g.add('B');
  await g.add('C', { posizione: 'fine' });
  assert.equal(g.current.title, 'A');
  assert.deepEqual(titoli(g), ['B', 'C']);
});

test('riproduci dopo: subito dopo il brano in corso, e più «dopo» restano nell’ordine fatto', async () => {
  const { g } = setup();
  await g.add('A');
  await g.add('B');
  await g.add('C');
  const r1 = await g.add('X', { posizione: 'prossimo' });
  assert.equal(r1.subito, false);
  assert.match(r1.message, /^Riproduce dopo: X/);
  assert.deepEqual(titoli(g), ['X', 'B', 'C']);
  await g.add('Y', { posizione: 'prossimo' });
  await g.add('Z', { posizione: 'prossimo' });
  assert.deepEqual(titoli(g), ['X', 'Y', 'Z', 'B', 'C'], 'la seconda dopo la prima, stile Spotify');
  await g.add('D');
  assert.deepEqual(titoli(g), ['X', 'Y', 'Z', 'B', 'C', 'D']);
});

test('riproduci dopo: quando X parte, il prossimo «dopo» va dopo Y (ancora in attesa)', async () => {
  const { g } = setup();
  await g.add('A');
  await g.add('B');
  await g.add('X', { posizione: 'prossimo' });
  await g.add('Y', { posizione: 'prossimo' });
  g.skip(); // parte X
  await flush();
  assert.equal(g.current.title, 'X');
  await g.add('Z', { posizione: 'prossimo' });
  assert.deepEqual(titoli(g), ['Y', 'Z', 'B']);
  g.skip(); g.skip(); // Y, poi Z: i «prossimi» sono finiti
  await flush();
  assert.equal(g.current.title, 'Z');
  await g.add('W', { posizione: 'prossimo' });
  assert.deepEqual(titoli(g), ['W', 'B']);
});

test('riproduci dopo con niente in riproduzione: parte subito', async () => {
  const { g } = setup();
  const r = await g.add('X', { posizione: 'prossimo' });
  assert.equal(r.subito, true);
  assert.equal(g.current.title, 'X');
  assert.match(r.message, /^In riproduzione: X/);
  assert.deepEqual(titoli(g), []);
});

test('riproduci dopo con una coda ferma (bot uscito): va in testa e parte lui', async () => {
  const { g } = setup();
  g.queue = [track('B'), track('C')]; // coda ritrovata, niente in corso
  await g.add('X', { posizione: 'prossimo' });
  assert.equal(g.current.title, 'X');
  assert.deepEqual(titoli(g), ['B', 'C']);
});

test('playlist con «riproduci dopo»: tutti i brani dopo il corrente, nell’ordine della playlist', async () => {
  const { g, risposte } = setup();
  await g.add('A');
  await g.add('B');
  await g.add('X', { posizione: 'prossimo' });
  risposte.set('lista', () => ({ tracks: ['P1', 'P2', 'P3'].map(track), playlistTitle: 'Mix' }));
  const r = await g.add('lista', { posizione: 'prossimo' });
  assert.equal(r.count, 3);
  assert.match(r.message, /^Riproduce dopo: 3 brani da «Mix»/);
  assert.deepEqual(titoli(g), ['X', 'P1', 'P2', 'P3', 'B']);
});

test('playlist YouTube (via veloce) con «riproduci dopo»: il resto arriva dopo e resta unito', async () => {
  const { g, notices } = setup();
  await g.add('A');
  await g.add('B');
  let finisci;
  const resto = new Promise((r) => { finisci = r; });
  const link = 'https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PL1';
  const yt = (id, title) => ({ ...track(title), url: `https://www.youtube.com/watch?v=${id}` });
  g.lib.getStream = async () => ({ url: 'https://x/a', headers: {}, exp: Date.now() + 1e6, direct: true, track: yt('aaaaaaaaaaa', 'P1') });
  g.lib.resolveInput = async () => resto;
  const r = await g.add(link, { posizione: 'prossimo' });
  assert.match(r.message, /^Riproduce dopo: P1 \(carico il resto/);
  assert.deepEqual(titoli(g), ['P1', 'B']);
  // Nel frattempo un altro «riproduci dopo»: va dopo P1
  g.lib.resolveInput = async (q) => ({ tracks: [track(q)], playlistTitle: null });
  await g.add('Y', { posizione: 'prossimo' });
  assert.deepEqual(titoli(g), ['P1', 'Y', 'B']);
  // Arriva il resto della playlist: subito dopo P1, nell'ordine della playlist
  finisci({ tracks: [yt('aaaaaaaaaaa', 'P1'), yt('bbbbbbbbbbb', 'P2'), yt('ccccccccccc', 'P3')], playlistTitle: 'Mix' });
  await flush();
  assert.deepEqual(titoli(g), ['P1', 'P2', 'P3', 'Y', 'B']);
  assert.match(notices.at(-1).message, /Aggiunti altri 2 brani come prossimi/);
});

test('playlist YouTube con «riproduci dopo» a coda vuota: P1 suona, il resto subito dopo', async () => {
  const { g } = setup();
  let finisci;
  const resto = new Promise((r) => { finisci = r; });
  const yt = (id, title) => ({ ...track(title), url: `https://www.youtube.com/watch?v=${id}` });
  g.lib.getStream = async () => ({ url: 'https://x/a', headers: {}, exp: Date.now() + 1e6, direct: true, track: yt('aaaaaaaaaaa', 'P1') });
  g.lib.resolveInput = async () => resto;
  await g.add('https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PL1', { posizione: 'prossimo' });
  assert.equal(g.current.title, 'P1');
  g.lib.resolveInput = async (q) => ({ tracks: [track(q)], playlistTitle: null });
  await g.add('B'); // in coda, in fondo
  finisci({ tracks: [yt('aaaaaaaaaaa', 'P1'), yt('bbbbbbbbbbb', 'P2')], playlistTitle: null });
  await flush();
  assert.deepEqual(titoli(g), ['P2', 'B']);
});

test('risultato di ricerca: addTrack con posizione prossimo, ora e fine', async () => {
  const { g } = setup();
  await g.add('A');
  await g.add('B');
  assert.equal(g.addTrack(track('X'), { posizione: 'prossimo' }), false);
  assert.equal(g.addTrack(track('Y'), { posizione: 'prossimo' }), false);
  assert.equal(g.addTrack(track('C')), false);
  assert.deepEqual(titoli(g), ['X', 'Y', 'B', 'C']);
  assert.equal(g.addTrack(track('O'), { now: true }), true);
  await flush();
  assert.equal(g.current.title, 'O');
});

test('link con «riproduci ora»: parte subito, il brano interrotto va nello storico', async () => {
  const { g } = setup();
  await g.add('A');
  await g.add('B');
  const r = await g.add('O', { posizione: 'ora' });
  assert.equal(r.subito, true);
  assert.equal(g.current.title, 'O');
  assert.deepEqual(titoli(g), ['B']);
  assert.equal(g.history[0].title, 'A');
});

test('shuffle e stop azzerano i «prossimi»; rimuoverne uno non rompe l’ordine', async () => {
  const { g } = setup();
  await g.add('A');
  await g.add('B');
  await g.add('X', { posizione: 'prossimo' });
  await g.add('Y', { posizione: 'prossimo' });
  g.remove(g.queue[0].id); // tolgo X
  await g.add('Z', { posizione: 'prossimo' });
  assert.deepEqual(titoli(g), ['Y', 'Z', 'B']);
  g.shuffle();
  await g.add('W', { posizione: 'prossimo' });
  assert.equal(titoli(g)[0], 'W', 'dopo lo shuffle il «dopo» torna in testa');
  g.stop();
  assert.equal(g.prossimi.size, 0);
});

test('messaggi: in coda, riproduce dopo, in riproduzione', () => {
  const t = [track('Uno')];
  assert.equal(messaggioAggiunta({ tracks: t, posizione: 'fine', subito: false }), 'Aggiunto in coda: Uno');
  assert.equal(messaggioAggiunta({ tracks: t, posizione: 'prossimo', subito: false }), 'Riproduce dopo: Uno');
  assert.equal(messaggioAggiunta({ tracks: t, posizione: 'prossimo', subito: true }), 'In riproduzione: Uno');
});

// ---------- comandi ----------
test('/play ha l’opzione facoltativa «dove» con in coda / come prossima', () => {
  const play = COMMANDS.find((c) => c.name === 'play');
  const dove = play.options.find((o) => o.name === 'dove');
  assert.ok(dove);
  assert.equal(Boolean(dove.required), false);
  assert.deepEqual(dove.choices.map((c) => [c.name, c.value]), [['in coda', 'fine'], ['come prossima', 'prossimo']]);
});

test('/play dove:come prossima passa posizione prossimo', async () => {
  const chiamate = [];
  const g = {
    current: { title: 'A' }, channelId: null, queue: [],
    add: async (q, opt) => { chiamate.push(opt.posizione); const t = track(q); g.queue.unshift(t); return { tracks: [t], count: 1, message: `Riproduce dopo: ${q}` }; },
  };
  const risposte = [];
  const i = {
    inGuild: () => true, guildId: 'g', commandName: 'play', user: { id: 'u', username: 'prova' },
    member: { displayName: 'Prova', voice: { channelId: 'v' } },
    options: { getString: (k) => ({ brano: 'albachiara', dove: 'prossimo' })[k] ?? null },
    deferReply: async () => {}, editReply: async (x) => risposte.push(x),
  };
  await handleCommand(i, { music: { get: () => g } });
  assert.deepEqual(chiamate, ['prossimo']);
  assert.equal(risposte[0].embeds[0].data.author.name, 'Riproduce dopo');
  i.options.getString = (k) => ({ brano: 'altro' })[k] ?? null;
  await handleCommand(i, { music: { get: () => g } });
  assert.deepEqual(chiamate, ['prossimo', 'fine'], 'senza «dove» resta in coda');
});

test('chat: «dopo vasco albachiara» mette come prossima', async () => {
  assert.deepEqual(parseText('dopo vasco albachiara'), { query: 'vasco albachiara', posizione: 'prossimo' });
  assert.deepEqual(parseText('Dopo https://youtu.be/x'), { query: 'https://youtu.be/x', posizione: 'prossimo' });
  assert.deepEqual(parseText('dopo'), { query: 'dopo' }, '«dopo» da solo è una ricerca');
  const { g } = setup();
  await g.add('A');
  await g.add('B');
  const replies = [];
  await handleTextMessage({
    guildId: 'g', text: 'dopo albachiara', user: 'Prova', voiceChannelId: 'v', botChannelId: null, humansInBotChannel: null,
    reply: async (c) => replies.push(c), react: async () => {},
  }, { music: { get: () => g } });
  assert.deepEqual(titoli(g), ['albachiara', 'B']);
  assert.match(replies[0], /^Riproduce dopo: \*\*albachiara\*\* \(posizione 1\)/);
});

// ---------- anteprima del link incollato ----------
test('anteprima link: oEmbed YouTube, altri siti null, errori null', async () => {
  const chiamate = [];
  const fetchFn = async (url) => {
    chiamate.push(url);
    return { ok: true, json: async () => ({ title: 'Albachiara', author_name: 'Vasco', thumbnail_url: 'https://i.ytimg.com/vi/x/hq.jpg' }) };
  };
  const a = await anteprimaLink('https://youtu.be/aaaaaaaaaaa', { fetchFn });
  assert.deepEqual(a, { title: 'Albachiara', author: 'Vasco', thumbnail: 'https://i.ytimg.com/vi/x/hq.jpg', playlist: false });
  assert.match(chiamate[0], /^https:\/\/www\.youtube\.com\/oembed\?format=json&url=/);
  assert.equal(await anteprimaLink('https://example.com/x', { fetchFn }), null);
  assert.equal(await anteprimaLink('non è un link', { fetchFn }), null);
  assert.equal(await anteprimaLink('https://youtu.be/aaaaaaaaaaa', { fetchFn: async () => { throw new Error('timeout'); } }), null);
  assert.equal(await anteprimaLink('https://youtu.be/aaaaaaaaaaa', { fetchFn: async () => ({ ok: false }) }), null);
});
