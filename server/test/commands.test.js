// Prova dei comandi slash con interazioni finte (senza Discord). Avvio: npm test
// /play usa yt-dlp vero con un link YouTube: serve la rete.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { COMMANDS, handleCommand } from '../src/commands.js';
import { MusicManager } from '../src/music.js';
import { Bot } from '../src/bot.js';

const notices = [];
const music = new MusicManager({ bot: null, onChange: () => {}, onNotice: () => {} });
const ctx = { music, notify: (g, m) => notices.push(m), isConnected: () => false };
after(() => {
  for (const g of music.guilds.values()) g.stop();
});

function fake(commandName, { opts = {}, voice = 'voce-1', guildId = 'g1' } = {}) {
  const calls = [];
  const i = {
    calls,
    commandName,
    guildId,
    inGuild: () => true,
    isChatInputCommand: () => true,
    user: { id: 'u1', username: 'prova', globalName: 'Prova' },
    member: { displayName: 'Prova', voice: { channelId: voice } },
    options: { getString: (k) => opts[k] ?? null },
    deferred: false,
    replied: false,
    reply: async (x) => { i.replied = true; calls.push(['reply', x]); },
    deferReply: async () => { i.deferred = true; calls.push(['defer']); },
    editReply: async (x) => calls.push(['edit', x]),
    deleteReply: async () => calls.push(['delete']),
    followUp: async (x) => calls.push(['followUp', x]),
  };
  return i;
}
const ephemeral = (x) => Boolean(x?.flags & MessageFlags.Ephemeral);
const track = (title) => ({ id: title, title, author: 'Test', url: 'https://www.youtube.com/watch?v=x', duration: 200, thumbnail: null, requestedBy: 'Test', query: null });

test('definizioni dei comandi valide', () => {
  assert.deepEqual(COMMANDS.map((c) => c.name), ['play', 'stop', 'skip', 'pausa', 'coda', 'vai', 'precedente', 'suono']);
  for (const c of COMMANDS) {
    assert.match(c.name, /^[a-z]{1,32}$/);
    assert.ok(c.description.length > 0 && c.description.length <= 100, c.name);
  }
  assert.equal(COMMANDS[0].options[0].name, 'brano');
  assert.equal(COMMANDS[0].options[0].required, true);
});

test('/play senza canale vocale: errore effimero', async () => {
  const i = fake('play', { opts: { brano: 'qualcosa' }, voice: null });
  await handleCommand(i, ctx);
  assert.equal(i.calls[0][0], 'reply');
  assert.ok(ephemeral(i.calls[0][1]));
  assert.match(i.calls[0][1].content, /canale vocale/);
});

test('/stop, /skip, /pausa, /coda con niente in riproduzione: effimeri', async () => {
  for (const name of ['stop', 'skip', 'pausa', 'coda']) {
    const i = fake(name, { guildId: 'vuoto' });
    await handleCommand(i, ctx);
    assert.ok(ephemeral(i.calls[0][1]), name);
  }
});

test('/pausa, /skip, /coda, /stop usano la stessa coda della GUI', async () => {
  const g = music.get('g2');
  g.addTrack(track('A'), { channelId: 'voce-1' });
  g.addTrack(track('B'));
  g.addTrack(track('C'));
  await new Promise((r) => setTimeout(r, 50)); // ensurePlayable è asincrono
  assert.equal(g.current.title, 'A');

  let i = fake('pausa', { guildId: 'g2' });
  await handleCommand(i, ctx);
  assert.equal(g.paused, true);
  assert.match(i.calls[0][1], /In pausa/);

  i = fake('pausa', { guildId: 'g2' });
  await handleCommand(i, ctx);
  assert.equal(g.paused, false);

  i = fake('skip', { guildId: 'g2' });
  await handleCommand(i, ctx);
  assert.match(i.calls[0][1], /Saltato: \*\*A\*\*/);
  assert.equal(g.current.title, 'B');

  i = fake('coda', { guildId: 'g2' });
  await handleCommand(i, ctx);
  assert.ok(ephemeral(i.calls[0][1]));
  assert.match(i.calls[0][1].content, /Ora:\*\* B[\s\S]*1\. C/);

  i = fake('stop', { guildId: 'g2' });
  await handleCommand(i, ctx);
  assert.equal(g.current, null);
  assert.deepEqual(g.queue.map((t) => t.title), ['B', 'C'], 'la coda resta, con il brano fermato in cima');
  assert.match(i.calls[0][1].content ?? i.calls[0][1], /la coda resta/);
});

test('playNow: il brano cliccato parte, la coda resta in ordine, con ripeti coda l\'interrotto va in fondo', async () => {
  const g = music.get('g3');
  for (const t of ['A', 'B', 'C', 'D']) g.addTrack(track(t));
  await new Promise((r) => setTimeout(r, 20));
  g.playNow('C');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(g.current.title, 'C');
  assert.deepEqual(g.queue.map((t) => t.title), ['B', 'D']);
  g.setLoop('queue');
  g.playNow('D');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(g.current.title, 'D');
  assert.deepEqual(g.queue.map((t) => t.title), ['B', 'C']);
  g.stop();
});

test('/play con link reale: risposta differita ed embed, la coda si aggiorna', async () => {
  const i = fake('play', { opts: { brano: 'https://www.youtube.com/watch?v=FGBhQbmPwH8' }, guildId: 'g4' });
  await handleCommand(i, ctx);
  assert.equal(i.calls[0][0], 'defer');
  const [kind, payload] = i.calls[1];
  assert.equal(kind, 'edit', JSON.stringify(i.calls[1]));
  const embed = payload.embeds[0].toJSON();
  assert.match(embed.title, /One More Time/i);
  assert.equal(embed.author.name, 'In riproduzione');
  assert.ok(embed.thumbnail?.url);
  assert.equal(music.get('g4').channelId, 'voce-1');
  assert.ok(notices.some((m) => /con \/play/.test(m)));
});

test('il bot registra i comandi per server e passa le interazioni', async () => {
  const bot = new Bot({ token: 'finto', textChannelId: '' });
  bot.commands = COMMANDS;
  let set = null;
  await bot.registerCommands({ name: 'Prova', commands: { set: async (c) => (set = c) } });
  assert.equal(set, COMMANDS);

  let ricevuta = null;
  bot.onCommand = async (i) => (ricevuta = i);
  const i = fake('skip');
  await bot.handleInteraction(i);
  assert.equal(ricevuta, i);

  // Errore nell'handler: risposta effimera invece di un'interazione "fallita"
  bot.onCommand = async () => { throw new Error('boom'); };
  const j = fake('skip');
  await bot.handleInteraction(j);
  assert.ok(ephemeral(j.calls[0][1]));
  await bot.client.destroy();
});
