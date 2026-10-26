// Uscita automatica dal canale vocale: stati vocali finti e orologio finto. Avvio: npm test
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { GuildMusic } from '../src/music.js';
import { handleCommand } from '../src/commands.js';

const flush = () => new Promise((r) => setImmediate(r));
const track = (title) => ({ id: title, title, author: 'Test', url: 'https://www.youtube.com/watch?v=x', duration: 600, thumbnail: null, requestedBy: 'Test', query: null });

/** Bot finto: tiene traccia di connessione, uscite e utenti nel canale. */
function fakeBot() {
  return {
    ready: true,
    connected: false,
    humans: 1,
    leaves: 0,
    isConnected() { return this.connected; },
    inVoice() { return this.connected; },
    countHumans() { return this.connected ? this.humans : null; },
    leave() { if (this.connected) this.leaves++; this.connected = false; },
  };
}

/** Musica con bot finto: niente yt-dlp né ffmpeg, "entrare" nel canale accende solo la connessione. */
function setup(opts = {}) {
  const bot = fakeBot();
  const notices = [];
  const g = new GuildMusic('g', { bot, onChange: () => {}, onNotice: (_id, n) => notices.push(n.message), ...opts });
  g.channelId = 'voce-1';
  g.kills = 0;
  g.startReal = async () => {
    bot.connected = true;
    g.audio = { kill: () => g.kills++ };
  };
  return { g, bot, notices };
}

async function playing(g, titles = ['A', 'B']) {
  for (const t of titles) g.addTrack(track(t));
  await flush();
  await flush();
  assert.equal(g.current?.title, titles[0]);
  assert.equal(g.loading, false);
}

beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'] }));
afterEach(() => mock.timers.reset());

test('canale vuoto: pausa subito, dopo 60 s esce e la coda resta', async () => {
  const { g, bot, notices } = setup();
  await playing(g);
  g.humansChanged(0);
  assert.equal(g.paused, true);
  assert.equal(g.autoPaused, true);
  assert.equal(g.snapshot().leaveReason, 'empty');
  assert.equal(Math.round(g.snapshot().leaveIn), 60);

  mock.timers.tick(45_000);
  assert.equal(Math.round(g.snapshot().leaveIn), 15);
  assert.equal(bot.leaves, 0);

  mock.timers.tick(15_000);
  assert.equal(bot.leaves, 1);
  assert.equal(g.current, null);
  assert.deepEqual(g.queue.map((t) => t.title), ['A', 'B']); // il brano interrotto torna in cima
  assert.equal(g.away, true);
  assert.equal(g.kills, 1); // processi audio chiusi
  assert.ok(notices.some((m) => /premi play/i.test(m)));

  // L'uscita decisa dal bot non viene scambiata per uno scollegamento a mano
  g.botVoiceChanged(null);
  assert.equal(g.away, true);
  assert.equal(notices.filter((m) => /scollegato/.test(m)).length, 0);
});

test('qualcuno rientra prima della scadenza: annulla e riprende', async () => {
  const { g, bot } = setup();
  await playing(g);
  g.humansChanged(0);
  mock.timers.tick(30_000);
  g.humansChanged(1);
  assert.equal(g.paused, false);
  assert.equal(g.autoPaused, false);
  assert.equal(g.snapshot().leaveReason, null);
  mock.timers.tick(120_000);
  assert.equal(bot.leaves, 0);
  assert.equal(g.current.title, 'A');
});

test('pausa messa da un utente: al rientro resta in pausa', async () => {
  const { g } = setup();
  await playing(g);
  g.togglePause(); // pausa dell'utente
  g.humansChanged(0);
  assert.equal(g.autoPaused, false);
  g.humansChanged(2);
  assert.equal(g.paused, true);
});

test('pausa del bot, poi l\'utente fa play a canale vuoto: il timer resta, al rientro nessuna doppia ripresa', async () => {
  const { g, bot } = setup();
  await playing(g);
  g.humansChanged(0);
  g.togglePause(); // play manuale
  assert.equal(g.paused, false);
  assert.equal(g.autoPaused, false);
  mock.timers.tick(60_000);
  assert.equal(bot.leaves, 1);
});

test('USCITA_CANALE_VUOTO_SECONDI=0: né pausa né uscita', async () => {
  const { g, bot } = setup({ emptySeconds: 0 });
  await playing(g);
  g.humansChanged(0);
  assert.equal(g.paused, false);
  mock.timers.tick(3_600_000);
  assert.equal(bot.leaves, 0);
  assert.equal(g.current.title, 'A');
});

test('coda finita: esce dopo 5 minuti di inattività', async () => {
  const { g, bot, notices } = setup();
  await playing(g, ['A']);
  g.skip(); // coda finita, il bot resta nel canale
  await flush();
  assert.equal(g.current, null);
  assert.equal(g.snapshot().leaveReason, 'idle');
  mock.timers.tick(4 * 60_000);
  assert.equal(bot.leaves, 0);
  mock.timers.tick(60_000);
  assert.equal(bot.leaves, 1);
  assert.equal(g.away, false); // niente da riprendere
  assert.ok(notices.some((m) => /5 min/.test(m)));
});

test('un brano nuovo annulla il conto dell\'inattività', async () => {
  const { g, bot } = setup();
  await playing(g, ['A']);
  g.skip();
  await flush();
  mock.timers.tick(4 * 60_000);
  g.addTrack(track('C'));
  await flush();
  await flush();
  assert.equal(g.snapshot().leaveReason, null);
  mock.timers.tick(10 * 60_000);
  assert.equal(bot.leaves, 0);
});

test('USCITA_INATTIVITA_MINUTI=0: resta nel canale', async () => {
  const { g, bot } = setup({ idleMinutes: 0 });
  await playing(g, ['A']);
  g.skip();
  await flush();
  mock.timers.tick(24 * 3_600_000);
  assert.equal(bot.leaves, 0);
  assert.equal(g.snapshot().leaveReason, null);
});

test('scollegato a mano: audio fermato, brano in cima alla coda, play lo fa rientrare', async () => {
  const { g, bot, notices } = setup();
  await playing(g);
  bot.connected = false; // un utente l'ha scollegato
  g.botVoiceChanged(null);
  assert.equal(g.current, null);
  assert.equal(g.kills, 1);
  assert.deepEqual(g.queue.map((t) => t.title), ['A', 'B']);
  assert.equal(g.away, true);
  assert.ok(notices.some((m) => /scollegato/.test(m)));

  g.togglePause({ channelId: 'voce-2' }); // play dall'Activity
  await flush();
  await flush();
  assert.equal(g.channelId, 'voce-2');
  assert.equal(g.current.title, 'A');
  assert.equal(g.away, false);
  assert.equal(bot.connected, true);
});

test('spostato in un altro canale: aggiorna il canale', async () => {
  const { g } = setup();
  await playing(g);
  g.botVoiceChanged('voce-9');
  assert.equal(g.channelId, 'voce-9');
  assert.equal(g.current.title, 'A');
});

function fakeInteraction(commandName) {
  const calls = [];
  return {
    calls,
    commandName,
    guildId: 'g',
    inGuild: () => true,
    user: { id: 'u1', username: 'prova' },
    member: { displayName: 'Prova', voice: { channelId: 'voce-1' } },
    options: { getString: () => null },
    reply: async (x) => calls.push(x),
  };
}

test('/stop a coda finita con il bot ancora nel canale: esce', async () => {
  const { g, bot } = setup();
  await playing(g, ['A']);
  g.skip();
  await flush();
  assert.equal(g.current, null);
  assert.equal(bot.connected, true);
  const music = { get: () => g };
  const i = fakeInteraction('stop');
  await handleCommand(i, { music });
  assert.equal(bot.leaves, 1);
  assert.equal(bot.connected, false);
  assert.equal(typeof i.calls[0], 'string'); // risposta pubblica, non effimera
  assert.equal(g.snapshot().leaveReason, null); // nessun timer rimasto

  // Ora non è più in nessun canale
  const j = fakeInteraction('stop');
  await handleCommand(j, { music });
  assert.ok(j.calls[0].flags & MessageFlags.Ephemeral);
  assert.match(j.calls[0].content, /Non sono in nessun canale vocale/);
});

test('il bot conta solo gli utenti veri del suo canale e segnala spostamenti e scollegamenti', async () => {
  const { Bot } = await import('../src/bot.js');
  const bot = new Bot({ token: 'finto', textChannelId: '' });
  bot.client.user = { id: 'bot' };
  const members = new Map([
    ['u1', { user: { bot: false } }],
    ['altrobot', { user: { bot: true } }],
  ]);
  members.filter = (fn) => ({ size: [...members.values()].filter(fn).length });
  const me = { voice: { channelId: 'v1', channel: { members } } };
  const guild = { id: 'g', members: { me } };
  bot.client.guilds.cache.set('g', guild);
  const st = (id, channelId) => ({ id, channelId, guild });
  const humans = [];
  const moves = [];
  bot.onHumans = (_g, n) => humans.push(n);
  bot.onBotVoice = (_g, ch) => moves.push(ch);

  members.delete('u1');
  bot.handleVoiceState(st('u1', 'v1'), st('u1', null)); // l'utente esce
  assert.deepEqual(humans, [0]);
  bot.handleVoiceState(st('u2', 'v5'), st('u2', 'v6')); // altro canale: ignorato
  assert.deepEqual(humans, [0]);
  members.set('u3', { user: { bot: false } });
  bot.handleVoiceState(st('u3', null), st('u3', 'v1')); // qualcuno rientra
  assert.deepEqual(humans, [0, 1]);
  bot.handleVoiceState(st('u3', 'v1'), st('u3', 'v1')); // si mette muto: ignorato
  assert.deepEqual(humans, [0, 1]);

  me.voice.channelId = null;
  bot.handleVoiceState(st('bot', 'v1'), st('bot', null)); // bot scollegato a mano
  assert.deepEqual(moves, [null]);
  await bot.client.destroy();
});
