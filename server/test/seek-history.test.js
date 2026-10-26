// Spostamento nel brano (seek), storico degli ultimi brani e lettura dei tempi scritti a mano.
// Niente Discord né yt-dlp. Avvio: npm test
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { StreamType } from '@discordjs/voice';
import { GuildMusic, STORICO_MAX } from '../src/music.js';
import { formatTime, handleTextMessage, parseText, parseTime } from '../src/commands.js';
import { scadenzaUrl } from '../src/resolver.js';
import { urlScaduto } from '../src/audio.js';

afterEach(() => mock.timers.reset());

const flush = () => new Promise((r) => setImmediate(r));
const track = (title, extra = {}) => ({
  id: `${title}-${Math.random()}`, title, author: 'Test', url: `https://www.youtube.com/watch?v=${title}`,
  duration: 200, thumbnail: null, requestedBy: 'Test', query: null, ...extra,
});
const opzioni = (extra = {}) => ({ bot: null, onChange() {}, onNotice() {}, idleMinutes: 0, emptySeconds: 0, ...extra });

/** Bot finto «collegato» con startReal sostituito: registra da dove riparte l'audio. */
function botFinto(g) {
  const avvii = [];
  g.bot = { ready: true, isConnected: () => true, inVoice: () => true, countHumans: () => 1, leave() {}, join: async () => ({ subscribe() {} }) };
  g.channelId = 'voce-1';
  g.startReal = async (t, { at = 0 } = {}) => {
    avvii.push({ title: t.title, at });
    g.audio = { kill() {}, touch() {}, bytes: () => 1, idleMs: () => 0 };
  };
  return avvii;
}

// ---------- tempi ----------
test('parseTime: secondi, m:ss e h:mm:ss', () => {
  assert.equal(parseTime('90'), 90);
  assert.equal(parseTime('1:30'), 90);
  assert.equal(parseTime('01:30'), 90);
  assert.equal(parseTime('1:02:03'), 3723);
  assert.equal(parseTime(' 2:05 '), 125);
  assert.equal(parseTime('0'), 0);
  for (const no of ['', 'abc', '1:60', '1:61:00', '-5', '1.5', '1:2:3:4', '1::30', null, undefined]) {
    assert.equal(parseTime(no), null, String(no));
  }
});

test('formatTime: 1:30 e 1:02:03', () => {
  assert.equal(formatTime(90), '1:30');
  assert.equal(formatTime(3723), '1:02:03');
  assert.equal(formatTime(0), '0:00');
});

test('parole in chat: vai 1:30, indietro, precedente', () => {
  assert.deepEqual(parseText('vai 1:30'), { command: 'vai', arg: '1:30' });
  assert.deepEqual(parseText('Vai a 90!'), { command: 'vai', arg: '90' });
  assert.deepEqual(parseText('indietro'), { command: 'precedente' });
  assert.deepEqual(parseText('Precedente.'), { command: 'precedente' });
  assert.deepEqual(parseText('vai al mare'), { query: 'vai al mare' }, 'un titolo resta una ricerca');
});

test('URL dello stream: scadenza da expire=, altrimenti 30 minuti; 403 = scaduto', () => {
  const exp = 1_900_000_000;
  assert.equal(scadenzaUrl(`https://rr1.googlevideo.com/videoplayback?expire=${exp}&id=x`), exp * 1000 - 60_000);
  assert.equal(scadenzaUrl('https://example.com/a.mp3', 1000), 1000 + 30 * 60_000);
  assert.ok(urlScaduto(new Error('Server returned 403 Forbidden')));
  assert.ok(!urlScaduto(new Error('Invalid data found when processing input')));
});

// ---------- storico ----------
test('storico: massimo 5, il più recente in cima, niente doppioni di fila', async () => {
  const g = new GuildMusic('g', opzioni());
  for (const n of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) g.queue.push(track(n));
  await g.playNext({ fromEnd: false }); // A
  for (let i = 0; i < 6; i++) await g.playNext({ fromEnd: true }); // finiscono A..F, suona G
  assert.equal(g.current.title, 'G');
  assert.equal(g.history.length, STORICO_MAX);
  assert.deepEqual(g.history.map((t) => t.title), ['F', 'E', 'D', 'C', 'B']);

  // Ripeti brano: lo stesso brano finisce più volte ma nello storico c'è una volta sola
  g.loop = 'track';
  await g.playNext({ fromEnd: true });
  await g.playNext({ fromEnd: true });
  assert.equal(g.current.title, 'G');
  assert.deepEqual(g.history.map((t) => t.title), ['G', 'F', 'E', 'D', 'C']);
  g.stop();
});

test('storico: saltato o sostituito ci va, stop no', async () => {
  const g = new GuildMusic('g', opzioni());
  g.queue.push(track('A'), track('B'));
  await g.playNext({ fromEnd: false });
  g.skip(); // A saltato
  await flush();
  assert.deepEqual(g.history.map((t) => t.title), ['A']);
  g.addTrack(track('C'), { now: true }); // B sostituito
  await flush();
  assert.deepEqual(g.history.map((t) => t.title), ['B', 'A']);
  g.stop(); // C fermato: non è «ascoltato»
  assert.deepEqual(g.history.map((t) => t.title), ['B', 'A']);
});

test('storico: riproduci subito e rimetti in coda (con id nuovi)', async () => {
  const g = new GuildMusic('g', opzioni());
  g.queue.push(track('A'), track('B'), track('C'));
  await g.playNext({ fromEnd: false });
  await g.playNext({ fromEnd: true }); // A nello storico, suona B
  const a = g.history[0];

  g.queueFromHistory(a.id);
  assert.equal(g.queue.at(-1).title, 'A');
  assert.notEqual(g.queue.at(-1).id, a.id, 'copia con id nuovo');
  assert.equal(g.history[0].id, a.id, 'resta nello storico');

  g.playFromHistory(a.id);
  await flush();
  assert.equal(g.current.title, 'A');
  assert.deepEqual(g.history.map((t) => t.title), ['B'], 'B interrotto va nello storico, A esce dallo storico');
  assert.equal(g.playFromHistory('non-esiste'), null);
  g.stop();
});

test('precedente: entro 5 s torna al brano prima e quello attuale va in cima alla coda', async () => {
  const g = new GuildMusic('g', opzioni());
  g.queue.push(track('A'), track('B'), track('C'));
  await g.playNext({ fromEnd: false });
  await g.playNext({ fromEnd: true }); // suona B, storico [A]
  g.startedAt = Date.now() - 2000; // 2 s di B

  const r = g.previous();
  await flush();
  assert.equal(r.ok, true);
  assert.equal(r.restarted, false);
  assert.equal(g.current.title, 'A');
  assert.deepEqual(g.queue.map((t) => t.title), ['B', 'C']);
  assert.deepEqual(g.history.map((t) => t.title), [], 'B non finisce nello storico');
  g.stop();
});

test('precedente: oltre 5 s ricomincia il brano attuale', async () => {
  const g = new GuildMusic('g', opzioni());
  g.queue.push(track('A'), track('B'));
  await g.playNext({ fromEnd: false });
  await g.playNext({ fromEnd: true }); // suona B, storico [A]
  g.startedAt = Date.now() - 42_000;

  const r = g.previous();
  assert.equal(r.restarted, true);
  assert.equal(g.current.title, 'B');
  assert.ok(g.position() < 1, `posizione ${g.position()}`);
  assert.deepEqual(g.history.map((t) => t.title), ['A'], 'storico invariato');

  // Niente storico e niente brano: risposta chiara
  const vuoto = new GuildMusic('v', opzioni());
  assert.equal(vuoto.previous().ok, false);
  g.stop();
});

test('storico salvato su disco con la coda e ricaricato (al massimo 5, brani validi)', async () => {
  const g = new GuildMusic('g', opzioni());
  g.queue.push(track('A'), track('B'));
  await g.playNext({ fromEnd: false });
  await g.playNext({ fromEnd: true });
  const dati = JSON.parse(JSON.stringify(g.persistData()));
  assert.deepEqual(dati.history.map((t) => t.title), ['A']);

  const h = new GuildMusic('g', opzioni());
  h.restore({ ...dati, history: [...dati.history, { rotto: true }, ...Array.from({ length: 8 }, (_, i) => track(`X${i}`))] });
  assert.equal(h.history.length, STORICO_MAX);
  assert.equal(h.history[0].title, 'A');
  assert.deepEqual(h.snapshot().history, h.history);
  g.stop();
});

// ---------- spostamento nel brano ----------
test('seek in modalità prova: sposta l\'orologio, anche in pausa', async () => {
  const g = new GuildMusic('g', opzioni());
  g.queue.push(track('A'));
  await g.playNext({ fromEnd: false });
  assert.deepEqual(g.seek(90), { ok: true, pos: 90 });
  assert.ok(Math.abs(g.position() - 90) < 1);
  g.pause();
  assert.equal(g.seek(30).pos, 30);
  assert.equal(g.position(), 30);
  g.resume();
  assert.ok(Math.abs(g.position() - 30) < 1);
  g.stop();
});

test('seek: limiti, dirette e brani senza durata', async () => {
  const g = new GuildMusic('g', opzioni());
  assert.equal(g.seek(10).ok, false, 'niente in riproduzione');
  g.queue.push(track('A'));
  await g.playNext({ fromEnd: false });
  assert.equal(g.seek(5000).pos, 199, 'al massimo durata - 1');
  assert.equal(g.seek(-20).pos, 0);
  assert.equal(g.seek('abc').ok, false);

  g.current = track('Diretta', { live: true, duration: 5000 });
  assert.equal(g.seek(10).ok, false);
  g.current = track('Senza durata', { duration: null });
  assert.equal(g.seek(10).ok, false);
  g.stop();
});

test('seek con il bot: riparte dal punto scelto, stesso brano, coda e volume invariati', async () => {
  const g = new GuildMusic('g', opzioni());
  const avvii = botFinto(g);
  g.queue.push(track('A'), track('B'));
  await g.playNext({ fromEnd: false });
  g.setVolume(35);
  const avanti = mock.method(g, 'playNext');

  const r = g.seek(120);
  assert.equal(r.ok, true);
  assert.equal(g.loading, true, 'mentre riapre l\'audio');
  assert.equal(g.position(), 120, 'la barra resta sul punto scelto anche durante il caricamento');
  await flush();
  assert.equal(g.loading, false);
  assert.equal(g.current.title, 'A');
  assert.deepEqual(g.queue.map((t) => t.title), ['B']);
  assert.deepEqual(avvii.at(-1), { title: 'A', at: 120 });
  assert.ok(Math.abs(g.position() - 120) < 1);
  assert.equal(g.volume, 35);
  assert.equal(avanti.mock.callCount(), 0, 'nessun passaggio al brano dopo');
  assert.deepEqual(g.history, [], 'lo spostamento non mette niente nello storico');
  assert.equal(g.seek(10).ok, true);
  await flush();
  g.stop();
});

test('seek in pausa: resta in pausa e l\'audio riparte dal punto scelto alla ripresa', async () => {
  const g = new GuildMusic('g', opzioni());
  const avvii = botFinto(g);
  g.queue.push(track('A'));
  await g.playNext({ fromEnd: false });
  g.pause();
  const prima = avvii.length;

  assert.equal(g.seek(60).ok, true);
  assert.equal(g.paused, true);
  assert.equal(g.pendingSeek, true);
  assert.equal(g.position(), 60);
  assert.equal(avvii.length, prima, 'in pausa non riapre ancora l\'audio');
  g.checkStall(); // il controllo dei blocchi non deve scattare
  assert.equal(g.current.title, 'A');

  g.resume();
  await flush();
  assert.equal(g.paused, false);
  assert.equal(g.pendingSeek, false);
  assert.deepEqual(avvii.at(-1), { title: 'A', at: 60 });
  assert.ok(Math.abs(g.position() - 60) < 1);
  g.stop();
});

test('seek: chiudere il vecchio flusso non fa partire il brano dopo (player vero)', async () => {
  const g = new GuildMusic('g', opzioni());
  g.bot = { ready: true, isConnected: () => true, inVoice: () => true, countHumans: () => 1, leave() {}, join: async () => ({ subscribe() {} }) };
  g.channelId = 'voce-1';
  g.lib.getStream = async () => { throw new Error('niente yt-dlp nei test'); };
  // Audio finto: pacchetti Opus di silenzio da una PassThrough, al posto di ffmpeg
  const aperti = [];
  g.openAudio = async (_t, at) => {
    const stream = new PassThrough({ objectMode: true });
    for (let i = 0; i < 50; i++) stream.write(Buffer.from([0xf8, 0xff, 0xfe]));
    const a = { stream, at, tipo: StreamType.Opus, kill() { stream.end(); }, touch() {}, bytes: () => 1, idleMs: () => 0 };
    aperti.push(a);
    return a;
  };
  g.current = track('A');
  g.queue.push(track('B'));
  await g.restartAt(10);
  assert.ok(g.player, 'player creato');
  const avanti = mock.method(g, 'playNext');

  g.seek(100);
  await flush();
  await new Promise((r) => setTimeout(r, 100)); // lascia girare il ciclo audio del player
  assert.equal(avanti.mock.callCount(), 0);
  assert.equal(g.current.title, 'A');
  assert.deepEqual(aperti.map((a) => a.at), [10, 100]);
  assert.deepEqual(g.queue.map((t) => t.title), ['B']);
  g.stop();
});

test('chat: «vai 1:30» sposta il brano, «indietro» torna a quello prima', async () => {
  const g = new GuildMusic('g', opzioni());
  const music = { get: () => g };
  const risposte = [];
  const ctx = (text) => ({
    guildId: 'g', text, user: 'Prova', voiceChannelId: 'voce-1', botChannelId: 'voce-1', humansInBotChannel: 1,
    reply: (c) => risposte.push(c), react: () => {},
  });
  g.queue.push(track('A'), track('B'));
  await g.playNext({ fromEnd: false });
  await g.playNext({ fromEnd: true }); // suona B

  await handleTextMessage(ctx('vai 1:30'), { music });
  assert.match(risposte.at(-1), /Vado a 1:30/);
  assert.ok(Math.abs(g.position() - 90) < 1);
  await handleTextMessage(ctx('vai 9:00'), { music });
  assert.match(risposte.at(-1), /dura 3:20/);

  await handleTextMessage(ctx('indietro'), { music }); // a 90 s: ricomincia B
  assert.match(risposte.at(-1), /Ricomincio/);
  await handleTextMessage(ctx('indietro'), { music }); // a 0 s: torna ad A
  await flush();
  assert.match(risposte.at(-1), /Torno a/);
  assert.equal(g.current.title, 'A');
  g.stop();
});
