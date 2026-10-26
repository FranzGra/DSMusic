// Messaggi in chat (canali musica e menzioni) e bot rimasto solo nel canale vocale. Avvio: npm test
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayIntentBits } from 'discord.js';
import { handleTextMessage, parseText } from '../src/commands.js';
import { GuildMusic, MusicManager } from '../src/music.js';
import { Bot } from '../src/bot.js';

afterEach(() => mock.timers.reset());

const flush = () => new Promise((r) => setImmediate(r));
const track = (title) => ({ id: title, title, author: 'Test', url: `https://www.youtube.com/watch?v=${title}`, duration: 200, thumbnail: null, requestedBy: 'Test', query: null });

/** Bot finto: un canale vocale alla volta, join sposta il bot. */
function fakeBot() {
  return {
    ready: true,
    channel: null,
    joins: [],
    leaves: 0,
    isConnected() { return Boolean(this.channel); },
    inVoice() { return Boolean(this.channel); },
    countHumans: () => 1,
    async join(_g, ch) { this.joins.push(ch); this.channel = ch; },
    leave() { if (this.channel) this.leaves++; this.channel = null; },
  };
}

/** Musica senza yt-dlp: add() mette in coda un brano finto con lo stesso percorso della GUI. */
function setup() {
  const bot = fakeBot();
  const music = new MusicManager({ bot, onChange: () => {}, onNotice: () => {}, emptySeconds: 0, idleMinutes: 0 });
  const g = music.get('g');
  g.startReal = async () => { await bot.join('g', g.channelId); g.audio = { kill() {} }; };
  g.add = async (q, { channelId, user } = {}) => {
    const t = { ...track(q), requestedBy: user };
    g.addTrack(t, { channelId });
    return { tracks: [t], count: 1, message: `Aggiunto: ${t.title}` };
  };
  return { bot, music, g };
}

function ctx(over = {}) {
  const replies = [];
  const reacts = [];
  return {
    replies,
    reacts,
    guildId: 'g',
    text: 'una canzone',
    user: 'Prova',
    voiceChannelId: 'voce-1',
    botChannelId: null,
    humansInBotChannel: null,
    reply: async (c) => replies.push(c),
    react: async (e) => reacts.push(e),
    ...over,
  };
}

// ---------- parole comando ----------
test('parole comando in italiano; il resto è una ricerca', () => {
  assert.deepEqual(parseText('skip'), { command: 'skip' });
  assert.deepEqual(parseText('Salta!'), { command: 'skip' });
  assert.deepEqual(parseText('  PAUSA '), { command: 'pausa' });
  assert.deepEqual(parseText('riprendi.'), { command: 'riprendi' });
  assert.deepEqual(parseText('stop'), { command: 'stop' });
  assert.deepEqual(parseText('coda?'), { command: 'coda' });
  assert.deepEqual(parseText('salta la corda'), { query: 'salta la corda' });
  assert.deepEqual(parseText('https://youtu.be/x'), { query: 'https://youtu.be/x' });
  assert.deepEqual(parseText(''), { query: '' });
});

// ---------- canale vocale di chi scrive ----------
test('chi scrive non è in un canale vocale: risposta breve, niente in coda', async () => {
  const { music, g } = setup();
  const c = ctx({ voiceChannelId: null });
  await handleTextMessage(c, { music });
  assert.deepEqual(c.replies, ['Entra in un canale vocale e riscrivi.']);
  assert.equal(g.queue.length + (g.current ? 1 : 0), 0);
});

test('bot non collegato: entra nel canale di chi scrive, reazione e titolo', async () => {
  const { bot, music, g } = setup();
  const notes = [];
  const c = ctx({ text: 'Bohemian Rhapsody' });
  await handleTextMessage(c, { music, notify: (_g, m) => notes.push(m) });
  await flush();
  assert.equal(g.current?.title, 'Bohemian Rhapsody');
  assert.deepEqual(bot.joins, ['voce-1']);
  assert.deepEqual(c.reacts, ['🎵']);
  assert.match(c.replies[0], /In riproduzione: \*\*Bohemian Rhapsody\*\*/);
  assert.match(notes[0], /da Prova in chat/);

  // secondo brano: posizione in coda
  const c2 = ctx({ text: 'Altro', botChannelId: 'voce-1', humansInBotChannel: 1 });
  await handleTextMessage(c2, { music });
  assert.match(c2.replies[0], /In coda: \*\*Altro\*\* \(posizione 1\)/);
});

test('bot in un altro canale con persone: non si sposta e dice dove si trova', async () => {
  const { bot, music, g } = setup();
  bot.channel = 'voce-A';
  g.channelId = 'voce-A';
  const c = ctx({ voiceChannelId: 'voce-B', botChannelId: 'voce-A', humansInBotChannel: 2 });
  await handleTextMessage(c, { music });
  assert.match(c.replies[0], /Sono già in <#voce-A>/);
  assert.equal(g.queue.length, 0);
  assert.equal(bot.channel, 'voce-A');
});

test('bot in un altro canale vuoto: viene nel canale di chi scrive', async () => {
  const { bot, music, g } = setup();
  bot.channel = 'voce-A';
  g.channelId = 'voce-A';
  const c = ctx({ voiceChannelId: 'voce-B', botChannelId: 'voce-A', humansInBotChannel: 0 });
  await handleTextMessage(c, { music });
  await flush();
  assert.equal(bot.channel, 'voce-B');
  assert.equal(g.channelId, 'voce-B');
  assert.equal(g.current?.title, 'una canzone');
});

test('parole comando: skip, pausa, riprendi, coda, stop con la stessa coda della GUI', async () => {
  const { bot, music, g } = setup();
  g.addTrack(track('A'), { channelId: 'voce-1' });
  g.addTrack(track('B'));
  await flush();
  await flush();
  const run = async (text) => {
    const c = ctx({ text, botChannelId: bot.channel, humansInBotChannel: 1 });
    await handleTextMessage(c, { music });
    return c.replies[0];
  };
  assert.match(await run('pausa'), /In pausa: \*\*A\*\*/);
  assert.equal(g.paused, true);
  assert.match(await run('pausa'), /già in pausa/);
  assert.match(await run('riprendi'), /Riprendo: \*\*A\*\*/);
  assert.equal(g.paused, false);
  assert.match(await run('coda'), /\*\*Ora:\*\* A[\s\S]*1\. B/);
  assert.match(await run('salta'), /Saltato: \*\*A\*\*/);
  await flush();
  await flush();
  assert.equal(g.current?.title, 'B');
  assert.match(await run('stop'), /Fermato/);
  assert.equal(g.current, null);
  assert.equal(bot.channel, null);
  assert.match(await run('stop'), /Non sono in nessun canale vocale/);
  assert.match(await run('skip'), /Non sto suonando niente/);
});

test('menzione senza testo: breve aiuto; errore di ricerca: risposta, niente crash', async () => {
  const { music, g } = setup();
  const vuoto = ctx({ text: '' });
  await handleTextMessage(vuoto, { music });
  assert.match(vuoto.replies[0], /link o un titolo/);

  g.add = async () => { throw new Error('nessun risultato'); };
  const c = ctx({ text: 'zzzz' });
  await handleTextMessage(c, { music });
  assert.match(c.replies[0], /Non riesco ad aggiungere «zzzz»: nessun risultato/);
  assert.deepEqual(c.reacts, []);
});

// ---------- il bot legge i messaggi ----------
function fakeMessage({ channelId = 'altro', content = '', authorBot = false, mentionsBot = false, member = { displayName: 'Prova', voice: { channelId: 'voce-1' } }, voiceStates = new Map() } = {}) {
  const replies = [];
  return {
    replies,
    guildId: 'g',
    channelId,
    content,
    author: { id: 'u1', bot: authorBot, username: 'prova' },
    member,
    mentions: { users: new Map(mentionsBot ? [['bot', {}]] : []) },
    guild: { voiceStates: { cache: voiceStates }, members: { fetch: async () => null } },
    reply: async (x) => replies.push(x),
    react: async () => {},
  };
}

test('il bot ascolta i canali musica (anche più di uno) e le menzioni ovunque', async () => {
  const bot = new Bot({ token: 'finto', textChannelId: 'm1, m2' });
  bot.client.user = { id: 'bot' };
  const seen = [];
  bot.onText = async (c) => seen.push(c);
  assert.ok(bot.client.options.intents.has(GatewayIntentBits.MessageContent), 'Message Content sempre attivo');
  assert.ok(bot.client.options.intents.has(GatewayIntentBits.GuildMessages));

  await bot.handleMessage(fakeMessage({ channelId: 'altro', content: 'ciao a tutti' }));
  assert.equal(seen.length, 0, 'senza menzione fuori dai canali musica: ignorato');
  await bot.handleMessage(fakeMessage({ channelId: 'm2', content: 'Bella canzone', authorBot: true }));
  assert.equal(seen.length, 0, 'messaggi dei bot ignorati');

  await bot.handleMessage(fakeMessage({ channelId: 'm2', content: 'Vasco Rossi Albachiara' }));
  assert.equal(seen.at(-1).text, 'Vasco Rossi Albachiara');
  assert.equal(seen.at(-1).voiceChannelId, 'voce-1');

  await bot.handleMessage(fakeMessage({ channelId: 'chat-vocale', content: '<@bot> https://youtu.be/x', mentionsBot: true }));
  assert.equal(seen.at(-1).text, 'https://youtu.be/x');

  // member non in cache: il canale vocale arriva dagli stati vocali del server
  await bot.handleMessage(fakeMessage({ channelId: 'm1', content: 'skip', member: null, voiceStates: new Map([['u1', { channelId: 'voce-9' }]]) }));
  assert.equal(seen.at(-1).voiceChannelId, 'voce-9');
  assert.equal(seen.at(-1).user, 'prova');

  // un errore nel gestore diventa una risposta, non un crash
  bot.onText = async () => { throw new Error('rotto'); };
  const m = fakeMessage({ channelId: 'm1', content: 'x' });
  const err = mock.method(console, 'error', () => {});
  await bot.handleMessage(m);
  err.mock.restore();
  assert.match(m.replies[0].content, /Errore: rotto/);
  await bot.client.destroy();
});

// ---------- bot rimasto solo nel canale vocale ----------
test('spostato in un canale con soli bot: pausa subito, poi esce con audio fermo e processi chiusi', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const bot = { ready: true, connected: true, leaves: 0, isConnected() { return this.connected; }, inVoice() { return this.connected; }, countHumans: () => 1, leave() { this.leaves++; this.connected = false; } };
  const notices = [];
  const g = new GuildMusic('g', { bot, onChange: () => {}, onNotice: (_id, n) => notices.push(n.message), emptySeconds: 60, idleMinutes: 0 });
  g.channelId = 'voce-1';
  let kills = 0;
  let playerStops = 0;
  g.player = { stop: () => playerStops++, pause() {}, unpause() {} };
  g.startReal = async () => { g.audio = { kill: () => kills++ }; };
  g.addTrack(track('A'));
  g.addTrack(track('B'));
  await flush();
  await flush();
  assert.equal(g.current?.title, 'A');

  // Discord sposta il bot in un canale dove ci sono solo bot
  g.botVoiceChanged('voce-2');
  g.humansChanged(0);
  assert.equal(g.channelId, 'voce-2');
  assert.equal(g.paused, true);
  assert.equal(g.autoPaused, true);

  mock.timers.tick(60_000);
  assert.equal(bot.leaves, 1, 'uscito');
  assert.equal(g.current, null, 'niente in riproduzione');
  assert.ok(kills >= 1, 'processi audio chiusi');
  assert.ok(playerStops >= 1, 'player fermato');
  assert.deepEqual(g.queue.map((t) => t.title), ['A', 'B'], 'la coda resta');
  assert.match(notices.at(-1), /Canale vuoto/);
});

test('spostato da un canale vuoto a uno con persone: annulla l\'uscita e riprende', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const bot = { ready: true, connected: true, leaves: 0, isConnected() { return this.connected; }, inVoice() { return this.connected; }, countHumans: () => 1, leave() { this.leaves++; this.connected = false; } };
  const g = new GuildMusic('g', { bot, onChange: () => {}, onNotice: () => {}, emptySeconds: 60, idleMinutes: 0 });
  g.channelId = 'voce-1';
  g.startReal = async () => { g.audio = { kill() {} }; };
  g.addTrack(track('A'));
  await flush();
  await flush();
  g.humansChanged(0);
  assert.equal(g.paused, true);
  g.botVoiceChanged('voce-2');
  g.humansChanged(2);
  assert.equal(g.paused, false);
  mock.timers.tick(120_000);
  assert.equal(bot.leaves, 0);
  g.stop();
});

test('il bot conta solo gli umani anche dopo essere stato spostato', () => {
  const bot = new Bot({ token: 'finto' });
  bot.client.user = { id: 'bot' };
  const canali = {
    v1: new Map([['u1', { user: { bot: false } }]]),
    v2: new Map([['altrobot', { user: { bot: true } }], ['bot', { user: { bot: true } }]]),
  };
  for (const m of Object.values(canali)) m.filter = (fn) => ({ size: [...m.values()].filter(fn).length });
  const me = { voice: { channelId: 'v1', channel: { members: canali.v1 } } };
  const guild = { id: 'g', members: { me } };
  bot.client.guilds.cache.set('g', guild);
  const st = (id, channelId) => ({ id, channelId, guild });
  const humans = [];
  const moves = [];
  bot.onHumans = (_g, n) => humans.push(n);
  bot.onBotVoice = (_g, ch) => moves.push(ch);

  me.voice = { channelId: 'v2', channel: { members: canali.v2 } };
  bot.handleVoiceState(st('bot', 'v1'), st('bot', 'v2'));
  assert.deepEqual(moves, ['v2']);
  assert.deepEqual(humans, [0], 'nel nuovo canale ci sono solo bot');
  void bot.client.destroy();
});
