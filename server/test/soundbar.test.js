// Soundbar: libreria dei suoni, durata e conversione, biglietti, anti-spam, player dei suoni con la
// musica (player e connessione finti) e caricamento HTTP. Niente Discord. Avvio: npm test
// I test con ffmpeg vero si saltano se ffmpeg non c'è.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import express from 'express';
import { StreamType, createAudioResource } from '@discordjs/voice';
import { GuildMusic } from '../src/music.js';
import {
  NOME_MAX, SUONI_MAX, SoundError, SoundLibrary, argomentiFfmpeg, argomentiVolume, creaBiglietti, creaConvertitore,
  creaLimitatore, creaRouteSuoni, creaVolumizzatore, durataDaFfmpeg, durataDaFfprobe, haUnRuolo, nomeValido, puoCaricare,
  puoModificareSuono, volumeDaHeader, volumeValido,
} from '../src/suoni.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsmusic-suoni-'));
const flush = () => new Promise((r) => setImmediate(r));
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const utenteProva = { id: 'u1', name: 'Prova', isAdmin: false };
const altro = { id: 'u2', name: 'Altro', isAdmin: false };
const admin = { id: 'u3', name: 'Admin', isAdmin: true };

/** Conversione finta: scrive un file e dice la durata scelta. */
const convertiFinto = (duration = 2) => async (_buf, { out }) => {
  await fs.promises.writeFile(out, 'OggS finto');
  return { duration };
};

/** Copia col volume finta: scrive «vol X di» + il file di partenza e conta le chiamate. */
const volumizzaFinto = (chiamate = []) => async (input, out, volume) => {
  chiamate.push(volume);
  await fs.promises.writeFile(out, `vol ${volume} di ${fs.readFileSync(input, 'utf8')}`);
};

const creati = [];
afterEach(() => {
  mock.timers.reset();
  for (const g of creati.splice(0)) g.stop();
});

// ---------- funzioni pure ----------
test('durata: uscita di ffprobe e riga Duration di ffmpeg', () => {
  assert.equal(durataDaFfprobe('2.040000\n'), 2.04);
  assert.equal(durataDaFfprobe('N/A'), null);
  assert.equal(durataDaFfprobe(''), null);
  assert.equal(durataDaFfprobe('0'), null);
  assert.equal(durataDaFfmpeg('  Duration: 00:00:02.50, start: 0.000000, bitrate: 128 kb/s'), 2.5);
  assert.equal(durataDaFfmpeg('Duration: 01:02:03.00'), 3723);
  assert.equal(durataDaFfmpeg('Duration: N/A, start: 0'), null);
  assert.equal(durataDaFfmpeg('niente'), null);
});

test('chi può caricare: admin o ruolo Soundbar', () => {
  assert.equal(puoCaricare({ isAdmin: true }), true);
  assert.equal(puoCaricare({ haRuolo: true }), true);
  assert.equal(puoCaricare({ isAdmin: false, haRuolo: false }), false);
  assert.equal(puoCaricare(), false);
  const ruoli = new Map([['ruolo-dj', {}], ['999', {}]]);
  assert.equal(haUnRuolo(ruoli, ['ruolo-dj']), true);
  assert.equal(haUnRuolo(ruoli, ['123', '999']), true);
  assert.equal(haUnRuolo(ruoli, ['123']), false);
  assert.equal(haUnRuolo(ruoli, []), false, 'lista vuota = solo admin');
  assert.equal(haUnRuolo(['5', '6'], ['6']), true);
  assert.equal(haUnRuolo(null, ['6']), false);
});

test('rinomina/elimina: chi ha caricato o admin', () => {
  const s = { createdBy: { id: 'u1', name: 'Prova' } };
  assert.equal(puoModificareSuono(utenteProva, s), true);
  assert.equal(puoModificareSuono(altro, s), false);
  assert.equal(puoModificareSuono(admin, s), true);
  assert.equal(puoModificareSuono(altro, { createdBy: null }), false);
});

test('nome: spazi puliti, vuoto e troppo lungo rifiutati', () => {
  assert.equal(nomeValido('  ciao   mondo '), 'ciao mondo');
  assert.throws(() => nomeValido('   '), (e) => e instanceof SoundError && e.code === 'nome_vuoto');
  assert.equal(nomeValido('x'.repeat(NOME_MAX)).length, NOME_MAX);
  assert.throws(() => nomeValido('x'.repeat(NOME_MAX + 1)), (e) => e.code === 'nome_lungo');
});

test('argomenti di ffmpeg: taglio a max + 0,3 s, loudnorm, Opus 48 kHz stereo in Ogg', () => {
  const a = argomentiFfmpeg({ input: 'in', output: 'out.tmp', maxSec: 20 });
  const dopo = (k) => a[a.indexOf(k) + 1];
  assert.equal(dopo('-i'), 'in');
  assert.equal(dopo('-t'), '20.3');
  assert.equal(dopo('-af'), 'loudnorm=I=-16:TP=-1.5');
  assert.equal(dopo('-ar'), '48000');
  assert.equal(dopo('-ac'), '2');
  assert.equal(dopo('-c:a'), 'libopus');
  assert.equal(dopo('-b:a'), '96k');
  assert.equal(dopo('-frame_duration'), '20');
  assert.equal(dopo('-f'), 'ogg');
  assert.equal(dopo('-map_metadata'), '-1');
  assert.ok(a.includes('-vn'));
  assert.equal(a.at(-1), 'out.tmp');
});

test('anti-spam: 1,5 s per utente e massimo 6 suoni in 10 s per server', () => {
  let t = 1_000_000;
  const lim = creaLimitatore({ now: () => t });
  assert.equal(lim.prova('g', 'a'), true);
  assert.equal(lim.prova('g', 'a'), false, 'stesso utente subito dopo');
  t += 1500;
  assert.equal(lim.prova('g', 'a'), true);
  // altri utenti: arriva a 6 nella finestra
  for (const u of ['b', 'c', 'd', 'e']) assert.equal(lim.prova('g', u), true);
  assert.equal(lim.prova('g', 'f'), false, 'settimo in 10 s: «Piano con i suoni»');
  assert.equal(lim.prova('altro-server', 'f'), true, 'il limite è per server');
  t += 10_000;
  assert.equal(lim.prova('g', 'f'), true, 'finestra passata');
});

test('anti-spam con mock.timers (Date finto)', () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  const lim = creaLimitatore();
  assert.equal(lim.prova('g', 'a'), true);
  mock.timers.tick(1000);
  assert.equal(lim.prova('g', 'a'), false);
  mock.timers.tick(500);
  assert.equal(lim.prova('g', 'a'), true);
});

test('biglietti: monouso, scadenza a 60 s, legati a server e utente', () => {
  let t = 0;
  const b = creaBiglietti({ now: () => t });
  const k = b.crea('g1', utenteProva);
  assert.equal(typeof k, 'string');
  assert.deepEqual(b.usa(k), { guildId: 'g1', user: { id: 'u1', name: 'Prova' } });
  assert.equal(b.usa(k), null, 'già usato');
  const k2 = b.crea('g2', altro);
  t += 60_000;
  assert.equal(b.usa(k2), null, 'scaduto');
  assert.equal(b.usa('inventato'), null);
  assert.equal(b.usa(undefined), null);
  const k3 = b.crea('g2', altro);
  t += 59_000;
  assert.equal(b.usa(k3).guildId, 'g2');
});

// ---------- libreria ----------
test('libreria: aggiunta, elenco, rinomina, elimina', async () => {
  const dir = tmpDir();
  const lib = new SoundLibrary({ dir, now: () => Date.UTC(2026, 9, 25) });
  const s = await lib.carica('g', { name: ' Applauso ', user: utenteProva, buffer: Buffer.from('x'), converti: convertiFinto(2.5) });
  assert.equal(s.name, 'Applauso');
  assert.equal(s.duration, 2.5);
  assert.equal(s.by, 'Prova');
  assert.equal(s.byId, 'u1');
  assert.equal(s.createdAt, '2026-10-25T00:00:00.000Z');
  assert.deepEqual(Object.keys(s).sort(), ['by', 'byId', 'createdAt', 'duration', 'id', 'name', 'volume']);
  assert.equal(s.volume, 1, 'volume di partenza 100%');
  const file = lib.percorso('g', lib.get('g', s.id));
  assert.ok(fs.existsSync(file));
  assert.equal(path.dirname(file), path.join(dir, 'suoni', 'g'));
  assert.ok(!fs.existsSync(`${file}.tmp`));
  assert.equal(lib.list('g').length, 1);

  const r = await lib.rinomina('g', { id: s.id, name: 'Applausi', user: utenteProva });
  assert.equal(r.name, 'Applausi');
  await assert.rejects(lib.rinomina('g', { id: s.id, name: 'X', user: altro }), (e) => e.code === 'permesso');
  await assert.rejects(lib.elimina('g', { id: s.id, user: altro }), (e) => e.code === 'permesso');
  await lib.elimina('g', { id: s.id, user: admin });
  assert.equal(lib.list('g').length, 0);
  assert.ok(!fs.existsSync(file), 'file tolto dal disco');
  await assert.rejects(lib.elimina('g', { id: s.id, user: admin }), (e) => e.code === 'non_trovato');
});

test('libreria: nomi non validi o già usati (anche con maiuscole diverse)', async () => {
  const lib = new SoundLibrary({ dir: tmpDir() });
  const c = convertiFinto();
  const a = await lib.carica('g', { name: 'Tromba', user: utenteProva, buffer: Buffer.from('x'), converti: c });
  await lib.carica('g', { name: 'Gong', user: utenteProva, buffer: Buffer.from('x'), converti: c });
  await assert.rejects(lib.carica('g', { name: 'tromba', user: altro, buffer: Buffer.from('x'), converti: c }), (e) => e.code === 'nome_usato');
  await assert.rejects(lib.carica('g', { name: '  ', user: altro, buffer: Buffer.from('x'), converti: c }), (e) => e.code === 'nome_vuoto');
  await assert.rejects(lib.carica('g', { name: 'x'.repeat(41), user: altro, buffer: Buffer.from('x'), converti: c }), (e) => e.code === 'nome_lungo');
  await assert.rejects(lib.rinomina('g', { id: a.id, name: 'GONG', user: utenteProva }), (e) => e.code === 'nome_usato');
  await assert.rejects(lib.carica('g', { name: 'Vuoto', user: utenteProva, buffer: Buffer.alloc(0), converti: c }), (e) => e.code === 'formato');
  assert.equal(lib.list('g').length, 2);
});

test('libreria: piena a 100 suoni', async () => {
  const lib = new SoundLibrary({ dir: tmpDir() });
  const c = convertiFinto();
  for (let i = 0; i < SUONI_MAX; i++) await lib.carica('g', { name: `s${i}`, user: utenteProva, buffer: Buffer.from('x'), converti: c });
  await assert.rejects(lib.carica('g', { name: 'uno di troppo', user: utenteProva, buffer: Buffer.from('x'), converti: c }), (e) => e.code === 'pieno');
});

test('libreria: errore di conversione = nessun file e nessuna voce', async () => {
  const dir = tmpDir();
  const lib = new SoundLibrary({ dir });
  const rotto = async (_b, { out }) => {
    await fs.promises.writeFile(out, 'mezzo');
    throw new SoundError('Formato non riconosciuto', 'formato');
  };
  await assert.rejects(lib.carica('g', { name: 'Rotto', user: utenteProva, buffer: Buffer.from('x'), converti: rotto }), (e) => e.code === 'formato');
  assert.equal(lib.list('g').length, 0);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'suoni', 'g')), []);
});

test('libreria: un caricamento alla volta per server', async () => {
  const lib = new SoundLibrary({ dir: tmpDir() });
  let dentro = 0;
  let max = 0;
  const lento = async (_b, { out }) => {
    max = Math.max(max, ++dentro);
    await pausa(20);
    await fs.promises.writeFile(out, 'x');
    dentro--;
    return { duration: 1 };
  };
  await Promise.all(['a', 'b', 'c'].map((name) => lib.carica('g', { name, user: utenteProva, buffer: Buffer.from('x'), converti: lento })));
  assert.equal(max, 1);
  assert.equal(lib.list('g').length, 3);
});

test('libreria: persistenza dopo il riavvio e pulizia dei file rimasti', async () => {
  const dir = tmpDir();
  const lib = new SoundLibrary({ dir });
  const s = await lib.carica('123', { name: 'Resta', user: utenteProva, buffer: Buffer.from('x'), converti: convertiFinto(3) });
  const cartella = path.join(dir, 'suoni', '123');
  fs.writeFileSync(path.join(cartella, 'orfano.ogg'), 'x');
  fs.writeFileSync(path.join(cartella, 'mezzo.ogg.tmp'), 'x');
  const dopo = new SoundLibrary({ dir });
  assert.equal(dopo.pulisci(), 2);
  assert.deepEqual(dopo.list('123').map((x) => [x.id, x.name, x.duration]), [[s.id, 'Resta', 3]]);
  assert.deepEqual(fs.readdirSync(cartella), [`${s.id}.ogg`]);
  const indice = JSON.parse(fs.readFileSync(path.join(dir, 'suoni-123.json'), 'utf8'));
  assert.equal(indice.v, 1);
  assert.equal(indice.suoni[0].file, `${s.id}.ogg`);
});

test('libreria: indice rovinato messo da parte, si riparte da zero', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'suoni-g.json'), '{rotto');
  const avvisi = mock.method(console, 'warn', () => {});
  const lib = new SoundLibrary({ dir });
  assert.deepEqual(lib.list('g'), []);
  avvisi.mock.restore();
  const files = fs.readdirSync(dir);
  assert.ok(files.some((f) => f.startsWith('suoni-g.json.rovinato-')), files.join(', '));
});

test('libreria: suono col file cancellato a mano sparisce dall\'elenco', async () => {
  const dir = tmpDir();
  const lib = new SoundLibrary({ dir });
  const a = await lib.carica('g', { name: 'A', user: utenteProva, buffer: Buffer.from('x'), converti: convertiFinto() });
  const b = await lib.carica('g', { name: 'B', user: utenteProva, buffer: Buffer.from('x'), converti: convertiFinto() });
  fs.rmSync(lib.percorso('g', lib.get('g', a.id)));
  const avvisi = mock.method(console, 'warn', () => {});
  const dopo = new SoundLibrary({ dir });
  assert.deepEqual(dopo.list('g').map((x) => x.id), [b.id]);
  avvisi.mock.restore();
  await dopo.writing.get('g');
  const indice = JSON.parse(fs.readFileSync(path.join(dir, 'suoni-g.json'), 'utf8'));
  assert.equal(indice.suoni.length, 1, 'indice ripulito');
});

// ---------- volume per suono ----------
test('volume: numero tra 0,1 e 2 arrotondato a 0,05, header del caricamento', () => {
  assert.equal(volumeValido(1), 1);
  assert.equal(volumeValido(0.83), 0.85);
  assert.equal(volumeValido(0.82), 0.8);
  assert.equal(volumeValido(1.234), 1.25);
  assert.equal(volumeValido(0.01), 0.1, 'sotto il minimo: 0,1');
  assert.equal(volumeValido(5), 2, 'sopra il massimo: 2');
  assert.equal(volumeValido('0.7'), 0.7);
  assert.equal(volumeValido('0,7'), 0.7);
  for (const x of [NaN, Infinity, null, undefined, 'tanto', '', {}, true]) {
    assert.throws(() => volumeValido(x), (e) => e instanceof SoundError && e.code === 'volume', String(x));
  }
  assert.equal(volumeDaHeader(undefined), 1);
  assert.equal(volumeDaHeader(''), 1);
  assert.equal(volumeDaHeader('0.8'), 0.8);
  assert.equal(volumeDaHeader('3'), 2);
  assert.equal(volumeDaHeader('forte'), 1, 'non valido: 100%');
});

test('volume: argomenti di ffmpeg, limitatore solo sopra il 100%', () => {
  const giu = argomentiVolume({ input: 'base.ogg', output: 'v.tmp', volume: 0.5 });
  const dopo = (a, k) => a[a.indexOf(k) + 1];
  assert.equal(dopo(giu, '-i'), 'base.ogg');
  assert.equal(dopo(giu, '-af'), 'volume=0.50');
  assert.equal(dopo(giu, '-c:a'), 'libopus');
  assert.equal(dopo(giu, '-frame_duration'), '20');
  assert.equal(dopo(giu, '-f'), 'ogg');
  assert.equal(giu.at(-1), 'v.tmp');
  const su = argomentiVolume({ input: 'b', output: 'o', volume: 1.5 });
  assert.equal(dopo(su, '-af'), 'volume=1.50,alimiter=limit=0.84:level=false');
});

test('volume: regola, copia dal file normalizzato, ritorno a 1, elimina', async () => {
  const dir = tmpDir();
  const chiamate = [];
  const lib = new SoundLibrary({ dir, volumizza: volumizzaFinto(chiamate) });
  const s = await lib.carica('g', { name: 'Gong', user: utenteProva, buffer: Buffer.from('x'), converti: convertiFinto() });
  const base = lib.percorso('g', lib.get('g', s.id));
  assert.equal(lib.daSuonare('g', lib.get('g', s.id)), base, 'a 1 si suona il file normalizzato');
  assert.deepEqual(chiamate, [], 'a 1 niente ffmpeg');

  let r = await lib.regolaVolume('g', { id: s.id, volume: 0.83, user: utenteProva });
  assert.equal(r.volume, 0.85);
  const copia = lib.daSuonare('g', lib.get('g', s.id));
  assert.equal(path.basename(copia), `${s.id}-v85.ogg`);
  assert.equal(fs.readFileSync(copia, 'utf8'), 'vol 0.85 di OggS finto', 'copia fatta dal file normalizzato');
  assert.equal(fs.readFileSync(base, 'utf8'), 'OggS finto', 'il file normalizzato resta uguale');
  assert.equal(lib.list('g')[0].volume, 0.85);

  r = await lib.regolaVolume('g', { id: s.id, volume: 1.5, user: admin });
  assert.equal(r.volume, 1.5);
  assert.equal(fs.readFileSync(lib.daSuonare('g', lib.get('g', s.id)), 'utf8'), 'vol 1.5 di OggS finto', 'sempre dal normalizzato');
  assert.ok(!fs.existsSync(copia), 'la copia vecchia è tolta');
  await lib.regolaVolume('g', { id: s.id, volume: 1.5, user: utenteProva });
  assert.deepEqual(chiamate, [0.85, 1.5], 'stesso volume: niente da rifare');

  r = await lib.regolaVolume('g', { id: s.id, volume: 1, user: utenteProva });
  assert.equal(r.volume, 1);
  assert.equal(lib.daSuonare('g', lib.get('g', s.id)), base);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'suoni', 'g')), [`${s.id}.ogg`], 'a 1 nessuna copia');

  await lib.regolaVolume('g', { id: s.id, volume: 0.5, user: utenteProva });
  await lib.elimina('g', { id: s.id, user: utenteProva });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'suoni', 'g')), [], 'eliminato con la sua copia');
});

test('volume: permessi, valori non validi, suono sparito, ffmpeg in errore', async () => {
  const dir = tmpDir();
  const lib = new SoundLibrary({ dir, volumizza: volumizzaFinto() });
  const s = await lib.carica('g', { name: 'Gong', user: utenteProva, buffer: Buffer.from('x'), converti: convertiFinto() });
  await assert.rejects(lib.regolaVolume('g', { id: s.id, volume: 0.5, user: altro }), (e) => e.code === 'permesso' && /volume/.test(e.message));
  await assert.rejects(lib.regolaVolume('g', { id: s.id, volume: 'forte', user: utenteProva }), (e) => e.code === 'volume');
  await assert.rejects(lib.regolaVolume('g', { id: 'nessuno', volume: 0.5, user: admin }), (e) => e.code === 'non_trovato');
  assert.equal((await lib.regolaVolume('g', { id: s.id, volume: 9, user: utenteProva })).volume, 2, 'portato al massimo');
  const rotta = new SoundLibrary({
    dir: tmpDir(),
    volumizza: async (_i, out) => {
      await fs.promises.writeFile(out, 'mezzo');
      throw new SoundError('Non riesco a cambiare il volume del suono', 'altro');
    },
  });
  const t = await rotta.carica('g', { name: 'T', user: utenteProva, buffer: Buffer.from('x'), converti: convertiFinto() });
  await assert.rejects(rotta.regolaVolume('g', { id: t.id, volume: 0.5, user: utenteProva }), (e) => e.code === 'altro');
  assert.equal(rotta.list('g')[0].volume, 1, 'errore: resta come prima');
  assert.deepEqual(fs.readdirSync(rotta.cartella('g')), [`${t.id}.ogg`], 'niente .tmp rimasti');
});

test('volume: persistenza, suoni vecchi senza campo, copia sparita, pulizia', async () => {
  const dir = tmpDir();
  const lib = new SoundLibrary({ dir, volumizza: volumizzaFinto() });
  const a = await lib.carica('g', { name: 'A', user: utenteProva, buffer: Buffer.from('x'), converti: convertiFinto() });
  const b = await lib.carica('g', { name: 'B', user: utenteProva, buffer: Buffer.from('x'), converti: convertiFinto() });
  await lib.regolaVolume('g', { id: a.id, volume: 0.6, user: utenteProva });
  await lib.regolaVolume('g', { id: b.id, volume: 1.4, user: utenteProva });

  const dopo = new SoundLibrary({ dir });
  assert.equal(dopo.pulisci(), 0, 'le copie col volume non sono file orfani');
  assert.deepEqual(dopo.list('g').map((x) => x.volume), [0.6, 1.4]);
  assert.equal(path.basename(dopo.daSuonare('g', dopo.get('g', a.id))), `${a.id}-v60.ogg`);

  // indice vecchio (senza volume) e copia cancellata a mano
  const file = path.join(dir, 'suoni-g.json');
  const indice = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete indice.suoni[0].volume;
  delete indice.suoni[0].fileVol;
  fs.writeFileSync(file, JSON.stringify(indice));
  fs.rmSync(path.join(dir, 'suoni', 'g', `${b.id}-v140.ogg`));
  fs.rmSync(path.join(dir, 'suoni', 'g', `${a.id}-v60.ogg`));
  const avvisi = mock.method(console, 'warn', () => {});
  const terza = new SoundLibrary({ dir });
  assert.deepEqual(terza.list('g').map((x) => x.volume), [1, 1], 'senza campo = 1; copia sparita = torna a 1');
  avvisi.mock.restore();
  await terza.writing.get('g');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).suoni.map((x) => x.volume), [1, 1], 'indice sistemato');
  assert.equal(terza.daSuonare('g', terza.get('g', b.id)), terza.percorso('g', terza.get('g', b.id)));
});

test('volume al caricamento: copia fatta subito; se ffmpeg sbaglia il suono resta al 100%', async () => {
  const lib = new SoundLibrary({ dir: tmpDir(), volumizza: volumizzaFinto() });
  const s = await lib.carica('g', { name: 'Piano', user: utenteProva, buffer: Buffer.from('x'), converti: convertiFinto(), volume: 0.7 });
  assert.equal(s.volume, 0.7);
  assert.equal(fs.readFileSync(lib.daSuonare('g', lib.get('g', s.id)), 'utf8'), 'vol 0.7 di OggS finto');
  const rotta = new SoundLibrary({ dir: tmpDir(), volumizza: async () => { throw new SoundError('no', 'altro'); } });
  const avvisi = mock.method(console, 'warn', () => {});
  const t = await rotta.carica('g', { name: 'T', user: utenteProva, buffer: Buffer.from('x'), converti: convertiFinto(), volume: 0.7 });
  avvisi.mock.restore();
  assert.equal(t.volume, 1);
  assert.equal(rotta.list('g').length, 1);
});

// ---------- conversione vera (solo con ffmpeg) ----------
const haFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }).status === 0;
const haFfprobe = spawnSync('ffprobe', ['-hide_banner', '-version'], { stdio: 'ignore' }).status === 0;
const tono = (sec, fmt = 'wav') => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`, '-f', fmt, '-'], { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
};

test('conversione vera: tono di 2 s in Ogg/Opus, durata giusta', { skip: !haFfmpeg && 'ffmpeg non installato' }, async () => {
  const dir = tmpDir();
  const converti = creaConvertitore({ ffprobe: haFfprobe ? 'ffprobe' : 'ffprobe-assente', tmpDir: dir });
  const out = path.join(dir, 'uscita.ogg.tmp');
  const r = await converti(tono(2, 'mp3'), { out, maxSec: 20 });
  assert.ok(Math.abs(r.duration - 2) < 0.15, `durata ${r.duration}`);
  assert.equal(fs.readFileSync(out).subarray(0, 4).toString(), 'OggS');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.in')), [], 'file caricato tolto da /tmp');
});

test('conversione vera: 22 s rifiutato, file illeggibile = formato', { skip: !haFfmpeg && 'ffmpeg non installato' }, async () => {
  const dir = tmpDir();
  const converti = creaConvertitore({ tmpDir: dir });
  const out = path.join(dir, 'uscita.ogg.tmp');
  await assert.rejects(converti(tono(22), { out, maxSec: 20 }), (e) => e.code === 'troppo_lungo' && /massimo 20 secondi/.test(e.message));
  assert.ok(!fs.existsSync(out));
  const avvisi = mock.method(console, 'warn', () => {});
  await assert.rejects(converti(Buffer.from('questo non è audio'.repeat(50)), { out, maxSec: 20 }), (e) => e.code === 'formato');
  avvisi.mock.restore();
  assert.ok(!fs.existsSync(out));
});

test('conversione vera: 20,2 s passa (tolleranza 0,25 s)', { skip: !haFfmpeg && 'ffmpeg non installato' }, async () => {
  const dir = tmpDir();
  const converti = creaConvertitore({ tmpDir: dir });
  const r = await converti(tono(20.2), { out: path.join(dir, 'u.ogg.tmp'), maxSec: 20 });
  assert.ok(r.duration <= 20.25 && r.duration > 20, `durata ${r.duration}`);
});

/** Volume medio e massimo (dB) di un file con il filtro volumedetect di ffmpeg. */
const volumeMedio = (file) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  const p = /max_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  return { medio: Number(m?.[1]), massimo: Number(p?.[1]) };
};

test('volume vero: a 0,5 circa 6 dB più piano, a 2 senza distorsione, suonabile come OggOpus', { skip: !haFfmpeg && 'ffmpeg non installato' }, async () => {
  const dir = tmpDir();
  const lib = new SoundLibrary({ dir, volumizza: creaVolumizzatore() });
  const converti = creaConvertitore({ ffprobe: haFfprobe ? 'ffprobe' : 'ffprobe-assente', tmpDir: dir });
  const s = await lib.carica('g', { name: 'Tono', user: utenteProva, buffer: tono(2), converti });
  const base = volumeMedio(lib.percorso('g', lib.get('g', s.id)));
  await lib.regolaVolume('g', { id: s.id, volume: 0.5, user: utenteProva });
  const giu = volumeMedio(lib.daSuonare('g', lib.get('g', s.id)));
  assert.ok(Math.abs(base.medio - giu.medio - 6) < 1, `base ${base.medio} dB, a 0,5 ${giu.medio} dB`);
  await lib.regolaVolume('g', { id: s.id, volume: 2, user: utenteProva });
  const file = lib.daSuonare('g', lib.get('g', s.id));
  const su = volumeMedio(file);
  assert.ok(su.medio > base.medio + 1, `a 2 più forte: ${su.medio} dB contro ${base.medio} dB`);
  assert.ok(su.massimo <= -0.5, `limitatore: picco ${su.massimo} dB`);
  // La copia si legge con lo stesso percorso di riproduzione (OggOpus, senza ffmpeg né codificatore Opus)
  const risorsa = createAudioResource(fs.createReadStream(file), { inputType: StreamType.OggOpus });
  const pacchetto = await new Promise((resolve, reject) => {
    risorsa.playStream.once('error', reject);
    risorsa.playStream.once('readable', () => resolve(risorsa.playStream.read()));
  });
  risorsa.playStream.destroy();
  assert.ok(Buffer.isBuffer(pacchetto) && pacchetto.length > 0, 'pacchetto Opus letto');
});

// ---------- player dei suoni con la musica ----------
class PlayerFinto extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle';
    this.resource = null;
    this.paused = false;
  }
  play(r) {
    const old = { status: this.status, resource: this.resource };
    this.resource = r;
    this.status = 'playing';
    this.paused = false;
    this.emit('stateChange', old, { status: 'playing', resource: r });
  }
  pause() { this.paused = true; return true; }
  unpause() { this.paused = false; return true; }
  stop() {
    if (this.status === 'idle') return false;
    const old = { status: this.status, resource: this.resource };
    this.status = 'idle';
    this.resource = null;
    this.emit('stateChange', old, { status: 'idle' });
    return true;
  }
}

let nt = 0;
const track = (title) => ({ id: `${title}-${++nt}`, title, author: 'Test', url: `https://soundcloud.com/x/${title}`, duration: 200, thumbnail: null, requestedBy: 'Test', query: null });

/** Musica con bot, connessione e player finti; il bot è in `canale` (null = fuori). */
function setup({ canale = 'voce-1' } = {}) {
  const g = new GuildMusic('g', { bot: null, onChange() {}, onNotice() {}, idleMinutes: 0, emptySeconds: 0 });
  creati.push(g);
  const stato = { canale, joins: [] };
  const conn = { sub: null, subscribe(p) { this.sub = p; } };
  g.bot = {
    ready: true,
    isConnected: () => stato.canale !== null,
    inVoice: () => stato.canale !== null,
    canaleBot: () => stato.canale,
    countHumans: () => 1,
    leave() { stato.canale = null; },
    join: async (_g, ch) => { stato.canale = ch; stato.joins.push(ch); return conn; },
  };
  g.channelId = canale;
  const musica = new PlayerFinto();
  g.player = musica;
  g.prefetch = async () => {}; // niente rete nei test
  g.lib.getStream = async () => { throw new Error('niente yt-dlp nei test'); };
  const aperti = [];
  g.openAudio = async (_t, at) => {
    const stream = new PassThrough({ objectMode: true });
    const a = { stream, at, tipo: StreamType.Opus, tocchi: 0, kill() { stream.end(); }, touch() { this.tocchi++; }, bytes: () => 1, idleMs: () => 0 };
    aperti.push(a);
    return a;
  };
  let suoni = null;
  g.suoni.crea = { player: () => (suoni = new PlayerFinto()), risorsa: (file) => ({ file }) };
  const file = path.join(tmpDir(), 'suono.ogg');
  fs.writeFileSync(file, 'OggS');
  const suono = (name = 'Gong', duration = 2) => ({ id: name, name, duration });
  return { g, conn, musica, stato, aperti, file, suono, suoni: () => suoni };
}

/** Fa suonare il brano A dal secondo 30. */
async function conMusica(ctx) {
  ctx.g.current = track('A');
  ctx.g.queue.push(track('B'));
  await ctx.g.restartAt(30);
  assert.equal(ctx.conn.sub, ctx.musica);
}

test('suono: la musica va in pausa e riprende dal punto esatto', async () => {
  const ctx = setup();
  const { g, conn, musica, file, suono } = ctx;
  await conMusica(ctx);
  const r = await g.suona(suono('Gong', 2), { file, by: 'Prova', channelId: 'voce-1' });
  assert.deepEqual(r, { ok: true, prova: false });
  assert.equal(musica.paused, true, 'pausa esplicita prima di cambiare iscrizione');
  assert.equal(conn.sub, ctx.suoni(), 'la connessione ascolta il player dei suoni');
  assert.equal(ctx.suoni().resource.file, file);
  const fermo = g.position();
  assert.ok(Math.abs(fermo - 30) < 0.5, `posizione ${fermo}`);
  const st = g.snapshot().suono;
  assert.equal(st.name, 'Gong');
  assert.equal(st.by, 'Prova');
  assert.ok(st.fine > Date.now() && st.fine <= Date.now() + 2000);
  await pausa(60);
  assert.equal(g.position(), fermo, 'il tempo del brano resta fermo');
  ctx.suoni().stop(); // il suono finisce
  assert.equal(g.snapshot().suono, null);
  assert.equal(conn.sub, musica, 'torna la musica');
  assert.equal(musica.paused, false);
  assert.ok(Math.abs(g.position() - fermo) < 0.05, `riprende da ${fermo}, ora ${g.position()}`);
  assert.ok(ctx.aperti.at(-1).tocchi >= 1, 'controllo dei blocchi azzerato');
});

test('suono: musica già in pausa dall\'utente resta in pausa', async () => {
  const ctx = setup();
  const { g, musica, file, suono } = ctx;
  await conMusica(ctx);
  g.pause();
  const pos = g.position();
  await g.suona(suono(), { file, channelId: 'voce-1' });
  ctx.suoni().stop();
  assert.equal(g.paused, true);
  assert.equal(musica.paused, true);
  assert.equal(g.position(), pos);
});

test('suono: pausa durante il suono = alla fine la musica resta in pausa', async () => {
  const ctx = setup();
  const { g, musica, file, suono } = ctx;
  await conMusica(ctx);
  await g.suona(suono(), { file, channelId: 'voce-1' });
  const pos = g.position();
  g.togglePause();
  assert.equal(g.paused, true);
  ctx.suoni().stop();
  assert.equal(g.paused, true);
  assert.equal(musica.paused, true);
  assert.equal(g.position(), pos);
  g.togglePause(); // riprende normalmente
  assert.equal(musica.paused, false);
  assert.ok(Math.abs(g.position() - pos) < 0.05);
});

test('suono: ripresa durante il suono = la musica riparte alla fine del suono', async () => {
  const ctx = setup();
  const { g, musica, file, suono } = ctx;
  await conMusica(ctx);
  g.pause();
  await g.suona(suono(), { file, channelId: 'voce-1' });
  g.togglePause();
  assert.equal(g.paused, false);
  assert.equal(musica.paused, true, 'la musica non suona sotto il suono');
  ctx.suoni().stop();
  assert.equal(musica.paused, false);
});

test('suono: due suoni di fila, il secondo interrompe il primo, la musica riprende una volta', async () => {
  const ctx = setup();
  const { g, conn, musica, file, suono } = ctx;
  await conMusica(ctx);
  await g.suona(suono('Uno', 2), { file, channelId: 'voce-1' });
  const pos = g.position();
  await g.suona(suono('Due', 3), { file, channelId: 'voce-1' });
  assert.equal(g.snapshot().suono.name, 'Due', 'l\'interruzione del primo non conta come fine');
  assert.equal(musica.paused, true);
  assert.equal(g.position(), pos);
  assert.equal(conn.sub, ctx.suoni());
  ctx.suoni().stop();
  assert.equal(g.snapshot().suono, null);
  assert.equal(musica.paused, false);
  assert.ok(Math.abs(g.position() - pos) < 0.05);
});

test('suono: salto durante il suono, il brano nuovo parte in pausa e riprende alla fine', async () => {
  const ctx = setup();
  const { g, conn, musica, file, suono } = ctx;
  await conMusica(ctx);
  await g.suona(suono(), { file, channelId: 'voce-1' });
  g.skip();
  await flush();
  await flush();
  assert.equal(g.current.title, 'B');
  assert.equal(g.loading, false);
  assert.equal(musica.paused, true, 'B in pausa sotto il suono');
  assert.equal(conn.sub, ctx.suoni(), 'la connessione resta al suono');
  assert.equal(g.position(), 0);
  ctx.suoni().stop();
  assert.equal(conn.sub, musica);
  assert.equal(musica.paused, false);
  assert.ok(g.position() < 0.1);
});

test('suono: spostamento durante il suono riprende dal punto scelto', async () => {
  const ctx = setup();
  const { g, musica, file, suono } = ctx;
  await conMusica(ctx);
  await g.suona(suono(), { file, channelId: 'voce-1' });
  assert.equal(g.seek(100).ok, true);
  await flush();
  await flush();
  assert.equal(musica.paused, true);
  assert.equal(Math.round(g.position()), 100);
  ctx.suoni().stop();
  assert.equal(musica.paused, false);
  assert.ok(Math.abs(g.position() - 100) < 0.1);
});

test('suono: bot fuori dal canale entra in quello dell\'Activity, la musica non riparte', async () => {
  const ctx = setup({ canale: null });
  const { g, conn, stato, file, suono } = ctx;
  g.queue.push(track('In attesa'));
  g.away = true;
  await g.suona(suono(), { file, channelId: 'voce-2' });
  assert.deepEqual(stato.joins, ['voce-2']);
  assert.equal(g.channelId, 'voce-2');
  assert.equal(conn.sub, ctx.suoni());
  ctx.suoni().stop();
  assert.equal(g.current, null, 'la coda non riparte da sola');
  assert.equal(g.queue.length, 1);
});

test('suono: bot in un altro canale = rifiuto, la musica continua', async () => {
  const ctx = setup();
  const { g, musica, file, suono } = ctx;
  await conMusica(ctx);
  await assert.rejects(g.suona(suono(), { file, channelId: 'voce-9' }), (e) => e instanceof SoundError && e.code === 'altro_canale' && e.message === 'Il bot è in un altro canale');
  assert.equal(musica.paused, false);
  assert.equal(g.snapshot().suono, null);
});

test('suono: stop durante il suono ferma tutto e non fa ripartire niente', async () => {
  const ctx = setup();
  const { g, file, suono } = ctx;
  await conMusica(ctx);
  await g.suona(suono(), { file, channelId: 'voce-1' });
  const sp = ctx.suoni();
  g.stop();
  assert.equal(sp.status, 'idle');
  assert.equal(g.snapshot().suono, null);
  assert.equal(g.current, null);
  assert.equal(g.suoni.musicaSospesa, false);
});

test('suono: «ferma il suono» dall\'interfaccia fa riprendere la musica', async () => {
  const ctx = setup();
  const { g, musica, file, suono } = ctx;
  await conMusica(ctx);
  await g.suona(suono(), { file, channelId: 'voce-1' });
  assert.equal(g.suoni.interrompi(), true);
  assert.equal(g.snapshot().suono, null);
  assert.equal(musica.paused, false);
  assert.equal(g.suoni.interrompi(), false);
});

test('suono: checkStall e cambio di volume fermi durante il suono', async () => {
  const ctx = setup();
  const { g, file, suono } = ctx;
  await conMusica(ctx);
  await g.suona(suono(), { file, channelId: 'voce-1' });
  const fallito = mock.method(g, 'audioFailed', () => {});
  g.audio.idleMs = () => 10 * 60_000;
  g.checkStall();
  assert.equal(fallito.mock.callCount(), 0);
  const prog = mock.method(g, 'applicaVolume');
  g.setVolume(10);
  assert.equal(g.volTimer, null, 'volume non programmato durante il suono');
  g.audio.idleMs = () => 0;
  ctx.suoni().stop();
  assert.ok(g.volTimer, 'alla fine il volume si riapplica');
  clearTimeout(g.volTimer);
  assert.equal(prog.mock.callCount(), 0);
});

test('suono: file sparito = errore chiaro, la musica non si ferma', async () => {
  const ctx = setup();
  const { g, musica, suono } = ctx;
  await conMusica(ctx);
  await assert.rejects(g.suona(suono(), { file: path.join(tmpDir(), 'manca.ogg'), channelId: 'voce-1' }), (e) => e instanceof SoundError);
  assert.equal(musica.paused, false);
});

test('suono: uscita dal canale azzera il suono', async () => {
  const ctx = setup();
  const { g, file, suono } = ctx;
  await conMusica(ctx);
  await g.suona(suono(), { file, channelId: 'voce-1' });
  g.botVoiceChanged(null);
  assert.equal(g.snapshot().suono, null);
  assert.equal(ctx.suoni().status, 'idle');
});

test('suono in modalità prova: niente audio, stato con fine a timer', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const g = new GuildMusic('g', { bot: null, onChange() {}, onNotice() {}, idleMinutes: 0, emptySeconds: 0 });
  creati.push(g);
  const r = await g.suona({ id: 's', name: 'Gong', duration: 2 }, { by: 'Prova' });
  assert.deepEqual(r, { ok: true, prova: true });
  assert.deepEqual(g.snapshot().suono, { id: 's', name: 'Gong', by: 'Prova', inizio: 1_000_000, fine: 1_002_000, duration: 2 });
  mock.timers.tick(1999);
  assert.ok(g.snapshot().suono);
  mock.timers.tick(1);
  assert.equal(g.snapshot().suono, null);
});

// ---------- caricamento HTTP ----------
async function server({ converti = convertiFinto(), maxMb = 2 } = {}) {
  const dir = tmpDir();
  const library = new SoundLibrary({ dir });
  const biglietti = creaBiglietti();
  const caricati = [];
  const app = express();
  app.use(express.json({ limit: '16kb' })); // come index.js: non deve disturbare il corpo binario
  app.use(creaRouteSuoni({ library, biglietti, converti, maxMb, onCaricato: (g, s, u) => caricati.push({ g, s, u }) }));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/api/suoni`;
  const post = (body, headers = {}) => fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'audio/mpeg', ...headers } });
  return { library, biglietti, caricati, post, chiudi: () => new Promise((r) => srv.close(r)) };
}

test('HTTP: 401 senza biglietto o con biglietto già usato', async () => {
  const s = await server();
  try {
    let r = await s.post(Buffer.from('x'));
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, 'permesso');
    const k = s.biglietti.crea('g', utenteProva);
    r = await s.post(Buffer.from('x'), { 'X-Biglietto': k, 'X-Nome': 'A' });
    assert.equal(r.status, 200);
    r = await s.post(Buffer.from('x'), { 'X-Biglietto': k, 'X-Nome': 'B' });
    assert.equal(r.status, 401, 'monouso');
  } finally {
    await s.chiudi();
  }
});

test('HTTP: 413 in JSON oltre 2 MB', async () => {
  const s = await server();
  try {
    const k = s.biglietti.crea('g', utenteProva);
    const r = await s.post(Buffer.alloc(2 * 1024 * 1024 + 10), { 'X-Biglietto': k, 'X-Nome': 'Grosso' });
    assert.equal(r.status, 413);
    assert.deepEqual(await r.json(), { ok: false, error: 'File troppo grande (massimo 2 MB)', code: 'troppo_grande' });
    assert.equal(s.library.list('g').length, 0);
  } finally {
    await s.chiudi();
  }
});

test('HTTP: 400 se troppo lungo, con il messaggio del server', async () => {
  const s = await server({ converti: async () => { throw new SoundError('Suono troppo lungo (22,0 s): massimo 20 secondi', 'troppo_lungo'); } });
  try {
    const k = s.biglietti.crea('g', utenteProva);
    const r = await s.post(Buffer.from('x'), { 'X-Biglietto': k, 'X-Nome': 'Lungo' });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.equal(j.code, 'troppo_lungo');
    assert.match(j.error, /massimo 20 secondi/);
  } finally {
    await s.chiudi();
  }
});

test('HTTP: 200 con conversione finta, nome con accenti, avviso ai client', async () => {
  const s = await server({ converti: convertiFinto(4.2) });
  try {
    const k = s.biglietti.crea('g', utenteProva);
    const r = await s.post(Buffer.from('audio'), { 'X-Biglietto': k, 'X-Nome': encodeURIComponent('Città è già') , 'Content-Type': 'application/octet-stream' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.suono.name, 'Città è già');
    assert.equal(j.suono.duration, 4.2);
    assert.equal(j.suono.byId, 'u1');
    assert.equal(s.caricati.length, 1);
    assert.equal(s.caricati[0].g, 'g');
    assert.equal(s.library.list('g').length, 1);
    // nome già usato: 400 con codice
    const k2 = s.biglietti.crea('g', altro);
    const r2 = await s.post(Buffer.from('audio'), { 'X-Biglietto': k2, 'X-Nome': encodeURIComponent('città È GIÀ') });
    assert.equal(r2.status, 400);
    assert.equal((await r2.json()).code, 'nome_usato');
  } finally {
    await s.chiudi();
  }
});

test('HTTP: X-Volume facoltativo al caricamento, non valido = 100%', async () => {
  const s = await server();
  s.library.volumizza = volumizzaFinto();
  try {
    let k = s.biglietti.crea('g', utenteProva);
    let r = await s.post(Buffer.from('audio'), { 'X-Biglietto': k, 'X-Nome': 'Piano', 'X-Volume': '0.8' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).suono.volume, 0.8);
    k = s.biglietti.crea('g', utenteProva);
    r = await s.post(Buffer.from('audio'), { 'X-Biglietto': k, 'X-Nome': 'Strano', 'X-Volume': 'forte' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).suono.volume, 1);
    k = s.biglietti.crea('g', utenteProva);
    r = await s.post(Buffer.from('audio'), { 'X-Biglietto': k, 'X-Nome': 'Senza' });
    assert.equal((await r.json()).suono.volume, 1);
    assert.deepEqual(s.library.list('g').map((x) => [x.name, x.volume]), [['Piano', 0.8], ['Strano', 1], ['Senza', 1]]);
  } finally {
    await s.chiudi();
  }
});

// ---------- comando slash /suono ----------
import { COMMANDS, handleAutocomplete, handleCommand } from '../src/commands.js';
import { MusicManager } from '../src/music.js';

function interazione(sub, { opts = {}, voice = 'voce-1', userId = 'u1', attachment = null, focused = '' } = {}) {
  const calls = [];
  const i = {
    calls, commandName: 'suono', guildId: 'g', inGuild: () => true,
    user: { id: userId, username: 'prova', globalName: 'Prova' },
    member: { displayName: 'Prova', voice: { channelId: voice } },
    options: {
      getSubcommand: () => sub, getString: (k) => opts[k] ?? null, getAttachment: () => attachment, getFocused: () => focused,
    },
    reply: async (x) => calls.push(['reply', x]),
    deferReply: async (x) => calls.push(['defer', x]),
    editReply: async (x) => calls.push(['edit', x]),
    respond: async (x) => calls.push(['respond', x]),
  };
  return i;
}

test('/suono: definizione con sottocomandi suona, aggiungi, elimina', () => {
  const c = COMMANDS.find((x) => x.name === 'suono');
  assert.deepEqual(c.options.map((o) => o.name), ['suona', 'aggiungi', 'elimina']);
  assert.equal(c.options[0].options[0].autocomplete, true);
  assert.equal(c.options[1].options[0].name, 'file');
});

test('/suono: suona (prova), permesso di caricare, elimina, suggerimenti', async () => {
  const library = new SoundLibrary({ dir: tmpDir() });
  const s = await library.carica('g', { name: 'Gong', user: utenteProva, buffer: Buffer.from('x'), converti: convertiFinto(2) });
  await library.carica('g', { name: 'Tromba', user: altro, buffer: Buffer.from('x'), converti: convertiFinto(1) });
  const music = new MusicManager({ bot: null, onChange: () => {}, onNotice: () => {} });
  creati.push(music.get('g'));
  const cambi = [];
  const soundbar = {
    library, converti: convertiFinto(), limitatore: creaLimitatore(), maxMb: 2,
    permesso: async (_g, id) => ({ isAdmin: false, puoCaricare: id === 'u1' }),
    onCambio: (g) => cambi.push(g),
  };
  const ctx = { music, notify: () => {}, soundbar };

  let i = interazione('suona', { opts: { nome: s.id } });
  await handleCommand(i, ctx);
  assert.match(i.calls[0][1].content, /Suonato «Gong» \(solo in Discord\)/);
  assert.equal(music.get('g').snapshot().suono.name, 'Gong');
  i = interazione('suona', { opts: { nome: 'gong' } });
  await handleCommand(i, ctx);
  assert.equal(i.calls[0][1].content, 'Piano con i suoni', 'anti-spam per utente');

  i = interazione('aggiungi', { userId: 'u2', attachment: { name: 'a.mp3', size: 10, url: 'http://x' } });
  await handleCommand(i, ctx);
  assert.match(i.calls[0][1].content, /Serve il ruolo Soundbar/);
  i = interazione('aggiungi', { attachment: { name: 'a.mp3', size: 3 * 1024 * 1024, url: 'http://x' } });
  await handleCommand(i, ctx);
  assert.match(i.calls[0][1].content, /troppo grande/);

  i = interazione('elimina', { opts: { nome: 'Tromba' } });
  await handleCommand(i, ctx);
  assert.match(i.calls[0][1].content, /Solo chi l'ha caricato/);
  i = interazione('elimina', { opts: { nome: s.id } });
  await handleCommand(i, ctx);
  assert.match(i.calls[0][1].content, /Eliminato/);
  assert.deepEqual(cambi, ['g']);
  assert.equal(music.get('g').snapshot().suono, null, 'il suono eliminato smette di suonare');

  i = interazione('suona', { focused: 'tro' });
  await handleAutocomplete(i, { soundbar });
  assert.deepEqual(i.calls[0][1], [{ name: 'Tromba · 1,0 s', value: library.list('g')[0].id }]);
});
