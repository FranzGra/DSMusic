// Stato del canale vocale = brano in riproduzione: client finto, nessuna richiesta vera. Avvio: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATO_MAX, StatoCanale, testoStato } from '../src/statocanale.js';

const attendi = (ms) => new Promise((r) => setTimeout(r, ms));
const ATTESA = 20; // ritardo corto per i test
const dopo = () => attendi(ATTESA * 3);
const brano = (title, author = 'Autore') => ({ id: title, title, author });

/** Discord finto: registra ogni PUT voice-status; `errore` fa fallire le richieste. */
function finto({ errore = null } = {}) {
  const richieste = [];
  const avvisi = [];
  const stato = new StatoCanale({
    attesaMs: ATTESA,
    imposta: async (channelId, status) => {
      richieste.push({ channelId, status });
      if (errore) throw errore;
    },
    log: { warn: (m) => avvisi.push(m) },
  });
  return { stato, richieste, avvisi };
}

test('testo: solo il titolo, senza emoji né autore, a capo tolti', () => {
  assert.equal(testoStato(brano('Albachiara', 'Vasco Rossi')), 'Albachiara');
  assert.equal(testoStato({ title: 'Solo titolo' }), 'Solo titolo');
  assert.equal(testoStato({ title: '  Due\nrighe ', author: '' }), 'Due righe');
  assert.equal(testoStato(null), '');
});

test('testo lungo: tagliato a STATO_MAX caratteri con «…», emoji non spezzate', () => {
  const t = testoStato(brano('x'.repeat(300), 'y'.repeat(300)));
  assert.equal(Array.from(t).length, STATO_MAX);
  assert.ok(t.endsWith('…'));
  assert.ok(STATO_MAX <= 500);
  const emoji = testoStato({ title: '😀'.repeat(200) }, 10);
  assert.equal(Array.from(emoji).length, 10);
  assert.ok(!/[\uD800-\uDBFF]…$/.test(emoji)); // nessuna metà di emoji prima di «…»
});

test('nuovo brano: una richiesta con il titolo; stesso testo di nuovo: nessuna richiesta', async () => {
  const { stato, richieste } = finto();
  stato.aggiorna('g', { channelId: 'c1', track: brano('A') });
  await dopo();
  assert.deepEqual(richieste, [{ channelId: 'c1', status: 'A' }]);
  stato.aggiorna('g', { channelId: 'c1', track: brano('A') }); // es. pausa o cambio di volume
  await dopo();
  assert.equal(richieste.length, 1);
  stato.aggiorna('g', { channelId: 'c1', track: brano('B') });
  await dopo();
  assert.deepEqual(richieste.at(-1), { channelId: 'c1', status: 'B' });
  assert.equal(richieste.length, 2);
});

test('salti rapidi di fila: una sola richiesta con l\'ultimo brano', async () => {
  const { stato, richieste } = finto();
  for (const t of ['A', 'B', 'C', 'D']) stato.aggiorna('g', { channelId: 'c1', track: brano(t) });
  await dopo();
  assert.deepEqual(richieste, [{ channelId: 'c1', status: 'D' }]);
});

test('uscita: torna lo stato di prima visto dal gateway', async () => {
  const { stato, richieste } = finto();
  stato.ricorda('c1', 'FranzDSMusic'); // messo a mano prima che il bot suonasse
  stato.aggiorna('g', { channelId: 'c1', track: brano('A') });
  await dopo();
  stato.ricorda('c1', 'A'); // eco del proprio cambio: non è «lo stato di prima»
  stato.aggiorna('g', { channelId: null, track: null });
  await dopo();
  assert.deepEqual(richieste.at(-1), { channelId: 'c1', status: 'FranzDSMusic' });
  assert.equal(richieste.length, 2);
});

test('uscita senza stato precedente noto: svuota; coda finita nel canale: svuota', async () => {
  const { stato, richieste } = finto();
  stato.aggiorna('g', { channelId: 'c1', track: brano('A') });
  await dopo();
  stato.aggiorna('g', { channelId: 'c1', track: null }); // coda finita, bot ancora nel canale
  await dopo();
  assert.deepEqual(richieste.at(-1), { channelId: 'c1', status: '' });
  stato.aggiorna('g', { channelId: null, track: null }); // poi esce: niente da rifare
  await dopo();
  assert.equal(richieste.length, 2);
});

test('bot spostato in un altro canale: il primo torna com\'era, il nuovo prende il titolo', async () => {
  const { stato, richieste } = finto();
  stato.ricorda('c1', 'Prima');
  stato.aggiorna('g', { channelId: 'c1', track: brano('A') });
  await dopo();
  stato.aggiorna('g', { channelId: 'c2', track: brano('A') });
  await dopo();
  assert.deepEqual(richieste.slice(1), [
    { channelId: 'c1', status: 'Prima' },
    { channelId: 'c2', status: 'A' },
  ]);
});

test('qualcuno cambia lo stato mentre suona: all\'uscita torna il suo', async () => {
  const { stato, richieste } = finto();
  stato.aggiorna('g', { channelId: 'c1', track: brano('A') });
  await dopo();
  stato.ricorda('c1', 'Riunione');
  await stato.ripristinaTutti();
  assert.deepEqual(richieste.at(-1), { channelId: 'c1', status: 'Riunione' });
});

test('errore 50013 (permesso mancante): un solo avviso, nessun altro tentativo, nessuna eccezione', async () => {
  const err = Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 });
  const { stato, richieste, avvisi } = finto({ errore: err });
  stato.aggiorna('g', { channelId: 'c1', track: brano('A') });
  await dopo();
  stato.aggiorna('g', { channelId: 'c1', track: brano('B') });
  await dopo();
  stato.aggiorna('g', { channelId: null, track: null });
  await dopo();
  assert.equal(richieste.length, 1);
  assert.equal(avvisi.length, 1);
  assert.match(avvisi[0], /permesso/);
});

test('altri errori (canale sparito, rate limit): avviso una volta per tipo, si continua', async () => {
  const err = Object.assign(new Error('Unknown Channel'), { code: 10003, status: 404 });
  const { stato, richieste, avvisi } = finto({ errore: err });
  stato.aggiorna('g', { channelId: 'c1', track: brano('A') });
  await dopo();
  stato.aggiorna('g', { channelId: 'c1', track: brano('B') });
  await dopo();
  assert.equal(richieste.length, 2);
  assert.equal(avvisi.length, 1);
});

test('opzione spenta (STATO_CANALE=0): nessuna richiesta', async () => {
  const richieste = [];
  const stato = new StatoCanale({ attivo: false, attesaMs: ATTESA, imposta: async (c, s) => richieste.push([c, s]) });
  stato.aggiorna('g', { channelId: 'c1', track: brano('A') });
  await dopo();
  await stato.ripristinaTutti();
  assert.equal(richieste.length, 0);
});

test('senza bot (modalità prova, imposta assente): nessuna richiesta né errore', async () => {
  const stato = new StatoCanale({ attesaMs: ATTESA, imposta: null });
  stato.aggiorna('g', { channelId: 'c1', track: brano('A') });
  await dopo();
  assert.equal(stato.attivo, false);
});
