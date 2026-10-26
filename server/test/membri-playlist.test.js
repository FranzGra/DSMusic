// Persone nel canale vocale (members, chi parla) e libreria di playlist condivisa.
// Niente Discord: stati vocali, ricevitore e cartella dati sono finti. Avvio: npm test
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Bot, MEMBRI_ATTESA_MS, ascoltaParlanti, elencoMembri } from '../src/bot.js';
import { GuildMusic } from '../src/music.js';
import {
  BRANI_MAX, NOME_MAX, PLAYLIST_MAX, PlaylistError, PlaylistLibrary, branoDaSalvare, puoEliminarePlaylist, puoModificarePlaylist,
} from '../src/playlists.js';

afterEach(() => mock.timers.reset());

// ---------- persone nel canale ----------
const utente = (id, { bot = false, displayName = null, username = `u${id}` } = {}) => {
  const user = { id, bot, username, globalName: null, displayAvatarURL: ({ size }) => `https://cdn.discordapp.com/avatars/${id}/a.png?size=${size}` };
  return { user, displayName: displayName ?? username, displayAvatarURL: user.displayAvatarURL };
};
const statoVocale = (id, channelId, member, extra = {}) => ({
  id, channelId, member, selfMute: false, serverMute: false, selfDeaf: false, serverDeaf: false, streaming: false, selfVideo: false, ...extra,
});
function finto(states) {
  return { id: 'g', voiceStates: { cache: new Map(states.map((s) => [s.id, s])) }, members: { cache: new Map() } };
}

test('members: solo persone (non bot) del canale, ordinate, con avatar via proxy, muto e chi parla', () => {
  const guild = finto([
    statoVocale('1', 'voce', utente('1', { displayName: 'Zoe' }), { selfMute: true }),
    statoVocale('2', 'voce', utente('2', { displayName: 'anna' }), { serverMute: true, serverDeaf: true }),
    statoVocale('3', 'voce', utente('3', { bot: true, displayName: 'FranzDSMusic' })),
    statoVocale('4', 'altro', utente('4', { displayName: 'Bruno' })),
    statoVocale('5', 'voce', utente('5', { displayName: 'Carlo' })),
  ]);
  const { members, mancanti } = elencoMembri(guild, 'voce', { parlanti: new Set(['5']) });
  assert.deepEqual(members.map((m) => m.name), ['anna', 'Carlo', 'Zoe']);
  assert.deepEqual(mancanti, []);
  const [anna, carlo, zoe] = members;
  assert.deepEqual(Object.keys(carlo).sort(), ['avatar', 'avatarUrl', 'deaf', 'id', 'muted', 'name', 'serverDeaf', 'serverMuted', 'speaking', 'streaming', 'video']);
  assert.equal(carlo.speaking, true);
  assert.equal(carlo.muted, false);
  assert.equal(zoe.muted, true);
  assert.equal(anna.muted, true);
  assert.equal(anna.deaf, true);
  assert.equal(anna.serverMuted, true);
  assert.equal(anna.serverDeaf, true);
  assert.equal(zoe.serverMuted, false); // muta da sé, non dal server
  assert.equal(carlo.streaming, false);
  assert.equal(carlo.video, false);
  assert.equal(carlo.avatarUrl, 'https://cdn.discordapp.com/avatars/5/a.png?size=64');
  assert.equal(carlo.avatar, `/api/thumb?u=${encodeURIComponent(carlo.avatarUrl)}`);
});

test('members: chi condivide lo schermo (Go Live) e chi ha la videocamera; null di discord.js = false', () => {
  const guild = finto([
    statoVocale('1', 'voce', utente('1', { displayName: 'Ada' }), { streaming: true }),
    statoVocale('2', 'voce', utente('2', { displayName: 'Bea' }), { selfVideo: true }),
    statoVocale('3', 'voce', utente('3', { displayName: 'Cid' }), { streaming: true, selfVideo: true }),
    statoVocale('4', 'voce', utente('4', { displayName: 'Dan' }), { streaming: null, selfVideo: null, serverMute: null }),
  ]);
  const stati = elencoMembri(guild, 'voce').members.map((m) => [m.name, m.streaming, m.video, m.serverMuted]);
  assert.deepEqual(stati, [['Ada', true, false, false], ['Bea', false, true, false], ['Cid', true, true, false], ['Dan', false, false, false]]);
});

test('GuildMusic: iniziare a condividere lo schermo manda di nuovo lo stato', () => {
  let elenco = [{ id: '1', name: 'A', avatar: null, speaking: false, muted: false, streaming: false, video: false }];
  const bot = { ready: true, isConnected: () => false, inVoice: () => false, members: () => elenco };
  const stati = [];
  const g = new GuildMusic('g', { bot, onChange: (_id, s) => stati.push(s), onNotice: () => {}, onMembers: () => {} });
  g.channelId = 'voce';
  g.snapshot();
  g.membersChanged({ voce: true });
  assert.equal(stati.length, 0);
  elenco = [{ ...elenco[0], streaming: true }];
  g.membersChanged({ voce: true });
  assert.equal(stati.length, 1);
  assert.equal(stati[0].members[0].streaming, true);
  elenco = [{ ...elenco[0], video: true }];
  g.membersChanged({ voce: true });
  assert.equal(stati.length, 2);
});

test('members: senza canale è vuoto; membro non in cache resta con il nome utente ed è da chiedere', () => {
  assert.deepEqual(elencoMembri(finto([]), null).members, []);
  const guild = finto([statoVocale('9', 'voce', null)]);
  const users = new Map([['9', { id: '9', bot: false, username: 'nove', globalName: 'Nove' }]]);
  const { members, mancanti } = elencoMembri(guild, 'voce', { users });
  assert.equal(members[0].name, 'Nove');
  assert.equal(members[0].avatar, null);
  assert.deepEqual(mancanti, ['9']);
});

test('chi parla: solo eventi start/end, nessun subscribe all\'audio; alla chiusura si svuota', () => {
  const speaking = new EventEmitter();
  const receiver = { speaking, subscribe: mock.fn() };
  const conn = new EventEmitter();
  conn.receiver = receiver;
  const cambi = mock.fn();
  const parlanti = ascoltaParlanti(conn, cambi);
  speaking.emit('start', 'a');
  speaking.emit('start', 'a'); // doppio: ignorato
  speaking.emit('start', 'b');
  assert.deepEqual([...parlanti], ['a', 'b']);
  speaking.emit('end', 'a');
  speaking.emit('end', 'x'); // mai iniziato: ignorato
  assert.deepEqual([...parlanti], ['b']);
  assert.equal(cambi.mock.callCount(), 3);
  conn.emit('stateChange', {}, { status: 'destroyed' });
  assert.equal(parlanti.size, 0);
  assert.equal(cambi.mock.callCount(), 4);
  assert.equal(receiver.subscribe.mock.callCount(), 0);
});

test('Bot: tanti eventi in 200 ms diventano una sola notifica; voce=true se c\'è un cambio di stato vocale', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const bot = new Bot({ token: 'x' }); // nessun login
  assert.equal(bot.mostraParlanti, true);
  const calls = [];
  bot.onMembers = (guildId, info) => calls.push([guildId, info.voce]);
  for (let i = 0; i < 30; i++) bot.segnalaMembri('g', false);
  mock.timers.tick(MEMBRI_ATTESA_MS - 1);
  assert.equal(calls.length, 0);
  mock.timers.tick(1);
  assert.deepEqual(calls, [['g', false]]);
  bot.segnalaMembri('g', false);
  bot.segnalaMembri('g', true);
  bot.segnalaMembri('h', false);
  mock.timers.tick(MEMBRI_ATTESA_MS);
  assert.deepEqual(calls.slice(1), [['g', true], ['h', false]]);
  bot.client.destroy();
});

test('Bot: con MOSTRA_CHI_PARLA spento non aggancia l\'ascolto', () => {
  const bot = new Bot({ token: 'x', mostraParlanti: false });
  const conn = new EventEmitter();
  conn.receiver = { speaking: new EventEmitter() };
  bot.ascolta(conn, 'g');
  assert.equal(conn.receiver.speaking.listenerCount('start'), 0);
  bot.client.destroy();
});

test('GuildMusic: members nello stato; cambio di voce = stato completo, solo «parla» = messaggio leggero', () => {
  let elenco = [{ id: '1', name: 'A', avatar: null, speaking: false, muted: false }];
  const bot = { ready: true, isConnected: () => false, inVoice: () => false, members: (_g, ch) => (ch ? elenco : []) };
  const stati = [];
  const leggeri = [];
  const g = new GuildMusic('g', { bot, onChange: (_id, s) => stati.push(s), onNotice: () => {}, onMembers: (_id, m) => leggeri.push(m) });
  assert.deepEqual(g.snapshot().members, []); // nessun canale
  g.channelId = 'voce';
  assert.deepEqual(g.snapshot().members, elenco);
  g.membersChanged({ voce: true }); // uguale a quello già mandato: niente
  assert.equal(stati.length + leggeri.length, 0);
  elenco = [{ ...elenco[0], speaking: true }];
  g.membersChanged({ voce: false });
  assert.equal(leggeri.length, 1);
  assert.equal(leggeri[0][0].speaking, true);
  elenco = [...elenco, { id: '2', name: 'B', avatar: null, speaking: false, muted: true }];
  g.membersChanged({ voce: true });
  assert.equal(stati.length, 1);
  assert.equal(stati[0].members.length, 2);
  // Senza bot (modalità prova) l'elenco non si conosce
  const prova = new GuildMusic('p', { bot: null, onChange: () => {}, onNotice: () => {} });
  assert.equal(prova.snapshot().members, null);
});

// ---------- libreria di playlist ----------
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'playlist-test-'));
const brano = (n, extra = {}) => ({
  id: `id${n}`, title: `Brano ${n}`, author: 'X', url: `https://www.youtube.com/watch?v=${n}`, duration: 100,
  live: false, thumbnail: null, source: 'Youtube', requestedBy: 'Prova', query: null, ...extra,
});
const utenteProva = { id: '111', name: 'Prova', isAdmin: false };
const luca = { id: '222', name: 'Luca', isAdmin: false };
const admin = { id: '333', name: 'Capo', isAdmin: true };

async function rifiuta(p, code) {
  await assert.rejects(p, (err) => err instanceof PlaylistError && err.code === code);
}

test('playlist: salva, elenca senza i brani e ritrova tutto dopo un riavvio (scrittura atomica)', async () => {
  const dir = tmpDir();
  const lib = new PlaylistLibrary({ dir, now: () => Date.UTC(2026, 9, 25, 12) });
  const r = await lib.save('g', { name: '  Serata   rock ', tracks: [brano(1), brano(2, { live: true, duration: null })], user: utenteProva });
  assert.equal(r.playlist.name, 'Serata rock');
  assert.equal(r.overwritten, false);
  const [p] = lib.list('g');
  assert.deepEqual(Object.keys(p).sort(), ['count', 'createdAt', 'createdBy', 'duration', 'id', 'name', 'updatedAt']);
  assert.equal(p.count, 2);
  assert.equal(p.duration, 100);
  assert.deepEqual(p.createdBy, { id: '111', name: 'Prova' });
  assert.equal(p.createdAt, '2026-10-25T12:00:00.000Z');
  const files = fs.readdirSync(dir);
  assert.deepEqual(files, ['playlist-g.json']); // nessun .tmp rimasto
  const salvati = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8')).playlists[0].tracks;
  assert.deepEqual(Object.keys(salvati[0]).sort(), ['author', 'duration', 'live', 'query', 'source', 'thumbnail', 'title', 'url']);
  const dopo = new PlaylistLibrary({ dir });
  assert.deepEqual(dopo.list('g'), lib.list('g'));
  assert.deepEqual(dopo.list('altro-server'), []); // una libreria per server
  fs.rmSync(dir, { recursive: true, force: true });
});

test('playlist: nome già usato (anche con maiuscole diverse) → errore; overwrite:true sostituisce', async () => {
  const dir = tmpDir();
  const lib = new PlaylistLibrary({ dir });
  const { playlist } = await lib.save('g', { name: 'Mix', tracks: [brano(1)], user: utenteProva });
  await rifiuta(lib.save('g', { name: 'mix', tracks: [brano(2)], user: luca }), 'nome_usato');
  const r = await lib.save('g', { name: 'mix', tracks: [brano(2), brano(3)], user: utenteProva, overwrite: true });
  assert.equal(r.overwritten, true);
  assert.equal(r.playlist.id, playlist.id);
  assert.equal(r.playlist.count, 2);
  assert.deepEqual(r.playlist.createdBy, { id: '111', name: 'Prova' }); // resta di chi l'ha creata
  assert.equal(lib.list('g').length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('playlist: sovrascrivere la playlist di un altro è negato (permesso); l\'amministratore può', async () => {
  const dir = tmpDir();
  const lib = new PlaylistLibrary({ dir });
  await lib.save('g', { name: 'Mix', tracks: [brano(1)], user: utenteProva });
  await assert.rejects(lib.save('g', { name: 'mix', tracks: [brano(2), brano(3)], user: luca, overwrite: true }), (err) =>
    err instanceof PlaylistError && err.code === 'permesso' && err.message === 'Questo nome è di una playlist di Prova: scegli un altro nome');
  assert.equal(new PlaylistLibrary({ dir }).list('g')[0].count, 1); // sul disco non è cambiato niente
  const r = await lib.save('g', { name: 'Mix', tracks: [brano(2), brano(3)], user: admin, overwrite: true });
  assert.equal(r.overwritten, true);
  assert.equal(r.playlist.count, 2);
  assert.deepEqual(r.playlist.createdBy, { id: '111', name: 'Prova' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('playlist: validazione di nome, coda vuota, limite di playlist e di brani', async () => {
  const dir = tmpDir();
  const lib = new PlaylistLibrary({ dir });
  await rifiuta(lib.save('g', { name: '   ', tracks: [brano(1)], user: utenteProva }), 'nome_vuoto');
  await rifiuta(lib.save('g', { name: 'x'.repeat(NOME_MAX + 1), tracks: [brano(1)], user: utenteProva }), 'nome_lungo');
  await lib.save('g', { name: 'è'.repeat(NOME_MAX), tracks: [brano(1)], user: utenteProva });
  await rifiuta(lib.save('g', { name: 'Vuota', tracks: [], user: utenteProva }), 'coda_vuota');
  await rifiuta(lib.save('g', { name: 'Rotti', tracks: [{ title: 'senza link' }], user: utenteProva }), 'coda_vuota');
  const lunga = await lib.save('g', { name: 'Lunga', tracks: Array.from({ length: BRANI_MAX + 5 }, (_, i) => brano(i)), user: utenteProva });
  assert.equal(lunga.truncated, true);
  assert.equal(lunga.playlist.count, BRANI_MAX);
  for (let i = lib.list('g').length; i < PLAYLIST_MAX; i++) await lib.save('g', { name: `P${i}`, tracks: [brano(1)], user: utenteProva });
  await rifiuta(lib.save('g', { name: 'Una di troppo', tracks: [brano(1)], user: utenteProva }), 'piena');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('playlist: rinomina solo chi l\'ha creata o un amministratore; nome doppio rifiutato, id sconosciuto', async () => {
  const dir = tmpDir();
  const lib = new PlaylistLibrary({ dir });
  const a = (await lib.save('g', { name: 'A', tracks: [brano(1)], user: utenteProva })).playlist;
  await lib.save('g', { name: 'B', tracks: [brano(1)], user: utenteProva });
  await rifiuta(lib.rename('g', { id: a.id, name: 'Di Luca', user: luca }), 'permesso');
  await rifiuta(lib.rename('g', { id: a.id, name: 'Senza utente' }), 'permesso');
  assert.equal(lib.get('g', a.id).name, 'A');
  assert.equal((await lib.rename('g', { id: a.id, name: 'Dal capo', user: admin })).name, 'Dal capo');
  const r = await lib.rename('g', { id: a.id, name: 'Nuovo nome', user: utenteProva });
  assert.equal(r.name, 'Nuovo nome');
  await rifiuta(lib.rename('g', { id: a.id, name: 'b', user: utenteProva }), 'nome_usato');
  await rifiuta(lib.rename('g', { id: 'nessuno', name: 'C', user: admin }), 'non_trovata');
  assert.equal(new PlaylistLibrary({ dir }).get('g', a.id).name, 'Nuovo nome');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('playlist: elimina solo chi l\'ha creata o un amministratore', async () => {
  assert.equal(puoEliminarePlaylist(utenteProva, { createdBy: { id: '111' } }), true);
  assert.equal(puoEliminarePlaylist(luca, { createdBy: { id: '111' } }), false);
  assert.equal(puoEliminarePlaylist(admin, { createdBy: { id: '111' } }), true);
  assert.equal(puoEliminarePlaylist(luca, { createdBy: null }), false);
  assert.equal(puoEliminarePlaylist(null, { createdBy: { id: '111' } }), false);
  assert.equal(puoModificarePlaylist(utenteProva, { createdBy: { id: '111' } }), true);
  assert.equal(puoModificarePlaylist(luca, { createdBy: { id: '111' } }), false);
  assert.equal(puoModificarePlaylist(admin, { createdBy: { id: '111' } }), true);

  const dir = tmpDir();
  const lib = new PlaylistLibrary({ dir });
  const p1 = (await lib.save('g', { name: 'Di Prova', tracks: [brano(1)], user: utenteProva })).playlist;
  const p2 = (await lib.save('g', { name: 'Anche di Prova', tracks: [brano(1)], user: utenteProva })).playlist;
  await rifiuta(lib.delete('g', { id: p1.id, user: luca }), 'permesso');
  assert.equal(lib.list('g').length, 2);
  await lib.delete('g', { id: p1.id, user: utenteProva });
  await lib.delete('g', { id: p2.id, user: admin });
  assert.deepEqual(new PlaylistLibrary({ dir }).list('g'), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('playlist: file rovinato messo da parte, la libreria riparte vuota', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'playlist-g.json'), '{rotto');
  const warn = mock.method(console, 'warn', () => {});
  assert.deepEqual(new PlaylistLibrary({ dir }).list('g'), []);
  warn.mock.restore();
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('playlist-g.json.rovinato-')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('playlist: salvare la coda (brano in corso + coda) e caricarla in fondo o al posto della coda', () => {
  const g = new GuildMusic('g', { bot: null, onChange: () => {}, onNotice: () => {} });
  g.current = brano(0);
  g.queue = [brano(1), brano(2)];
  const salvati = g.braniPerPlaylist().map(branoDaSalvare);
  assert.deepEqual(salvati.map((t) => t.title), ['Brano 0', 'Brano 1', 'Brano 2']);
  // Brano di Spotify non ancora cercato: niente link ma il testo da cercare basta
  assert.equal(branoDaSalvare(brano(9, { url: null, query: 'Artista Titolo' })).query, 'Artista Titolo');

  assert.equal(g.loadPlaylist(salvati, { mode: 'append', user: 'Luca' }), 3);
  assert.equal(g.queue.length, 5);
  assert.equal(g.current.title, 'Brano 0'); // il brano in corso continua
  assert.equal(g.queue[4].requestedBy, 'Luca');
  assert.equal(new Set(g.queue.map((t) => t.id)).size, 5); // id nuovi: niente doppioni
  g.loadPlaylist(salvati.slice(1), { mode: 'replace', user: 'Luca' });
  assert.deepEqual(g.queue.map((t) => t.title), ['Brano 1', 'Brano 2']);
  assert.equal(g.current.title, 'Brano 0');
  g.clearSim();
});

test('playlist: rinomina negata ad altri → errore «permesso» con testo chiaro; caricare resta per tutti', async () => {
  const dir = tmpDir();
  const lib = new PlaylistLibrary({ dir });
  const p = (await lib.save('g', { name: 'Mia', tracks: [brano(1)], user: utenteProva })).playlist;
  await assert.rejects(lib.rename('g', { id: p.id, name: 'Tua', user: luca }), (err) =>
    err instanceof PlaylistError && err.code === 'permesso' && /rinominarla o eliminarla/.test(err.message));
  assert.equal(new PlaylistLibrary({ dir }).get('g', p.id).name, 'Mia'); // sul disco non è cambiato niente
  const g = new GuildMusic('g', { bot: null, onChange: () => {}, onNotice: () => {} });
  g.current = brano(0);
  assert.equal(g.loadPlaylist(lib.get('g', p.id).tracks, { user: luca.name }), 1);
  g.clearSim();
  fs.rmSync(dir, { recursive: true, force: true });
});
