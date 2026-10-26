// Leggerezza (macchine con poca RAM): scelta della via audio, cache audio in RAM con budget e LRU,
// limite dei processi yt-dlp, riposo senza nessuno in vocale, cambio di volume senza interruzioni.
// Niente Discord, yt-dlp né ffmpeg. Avvio: npm test
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { argomentiUscita, sceltaUscita } from '../src/audio.js';
import { AudioCache } from '../src/audiocache.js';
import { creaLimitatore } from '../src/resolver.js';
import { GuildMusic, MusicManager } from '../src/music.js';

afterEach(() => mock.timers.reset());

const MB = 1024 * 1024;
const flush = () => new Promise((r) => setImmediate(r));
const brano = (id, extra = {}) => ({ id: `t-${id}-${Math.random()}`, title: `Brano ${id}`, author: 'Test', url: `https://www.youtube.com/watch?v=${id}`, duration: 200, thumbnail: null, requestedBy: null, query: null, ...extra });
const info = (extra = {}) => ({ url: 'https://cdn/a?mime=audio%2Fwebm', headers: {}, direct: true, acodec: 'opus', protocol: 'https', size: null, ...extra });

/** fetch finto che serve file di `bytes` byte con le richieste Range, e conta le chiamate. */
function fetchFinto(bytes, { log = [] } = {}) {
  return async (url, { headers, signal }) => {
    log.push({ url, range: headers.Range });
    if (signal?.aborted) throw Object.assign(new Error('annullato'), { name: 'AbortError' });
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(headers.Range);
    const tot = typeof bytes === 'function' ? bytes(url) : bytes;
    const fine = Math.min(tot - 1, Number(b));
    const corpo = Buffer.alloc(fine - Number(a) + 1, 7);
    return new Response(corpo, { status: 206, headers: { 'content-range': `bytes ${a}-${fine}/${tot}` } });
  };
}

// ---------- via audio ----------
test('via audio: copia senza ricodifica solo con sorgente Opus e volume 100%', () => {
  assert.equal(sceltaUscita({ acodec: 'opus', volume: 100 }), 'copia');
  assert.equal(sceltaUscita({ acodec: 'opus', volume: 60 }), 'opus');
  assert.equal(sceltaUscita({ acodec: 'mp4a.40.2', volume: 100 }), 'opus');
  assert.equal(sceltaUscita({ acodec: null, volume: 100 }), 'opus');
  assert.deepEqual(argomentiUscita('copia'), ['-vn', '-c:a', 'copy', '-copypriorss', '0', '-f', 'ogg', 'pipe:1']);
  const a60 = argomentiUscita('opus', 60);
  assert.ok(a60.includes('libopus'));
  assert.equal(a60[a60.indexOf('-af') + 1], 'volume=0.60');
  assert.equal(a60[a60.indexOf('-b:a') + 1], '128k');
  assert.equal(a60.at(-2), 'ogg');
  assert.equal(argomentiUscita('opus', 100).includes('-af'), false, 'a 100% niente filtro volume');
});

// ---------- limite yt-dlp ----------
test('yt-dlp: al massimo 2 insieme, l\'utente passa davanti alla preparazione di sfondo', async () => {
  const lim = creaLimitatore(2);
  const ordine = [];
  const r1 = await lim.prendi(false);
  const pBassa = lim.prendi(true).then((r) => { ordine.push('bassa'); return r; });
  const r2 = await lim.prendi(false);
  assert.deepEqual(lim.stato(), { attivi: 2, inAttesa: 1 });
  const pAlta = lim.prendi(false).then((r) => { ordine.push('alta'); return r; });
  r1();
  const r3 = await pAlta;
  await flush();
  assert.deepEqual(ordine, ['alta'], 'la richiesta dell\'utente passa prima di quella di sfondo');
  r2();
  await flush();
  assert.deepEqual(ordine, ['alta'], 'la bassa parte solo quando non gira nessun altro yt-dlp');
  r3();
  const r4 = await pBassa;
  assert.deepEqual(ordine, ['alta', 'bassa']);
  r4();
  r4(); // rilasciare due volte non conta
  assert.deepEqual(lim.stato(), { attivi: 0, inAttesa: 0 });
});

// ---------- cache audio in RAM ----------
test('cache: cosa non va in RAM (diretta, troppo lungo, a frammenti, link non diretto, spenta)', () => {
  const c = new AudioCache({ budgetMb: 96, maxSec: 1200, fetchFn: fetchFinto(1) });
  assert.equal(c.idoneo(info(), { durata: 200 }).ok, true);
  assert.equal(c.idoneo(info(), { durata: 200, live: true }).motivo, 'diretta');
  assert.equal(c.idoneo(info(), { durata: 1500 }).motivo, 'troppo lungo');
  assert.equal(c.idoneo(info({ protocol: 'm3u8_native' }), { durata: 200 }).motivo, 'flusso a frammenti');
  assert.equal(c.idoneo(info({ direct: false }), { durata: 200 }).motivo, 'link non diretto');
  assert.equal(c.idoneo(info({ size: 40 * MB }), { durata: 200 }).motivo, 'troppo grande');
  assert.equal(new AudioCache({ budgetMb: 0 }).idoneo(info(), {}).motivo, 'cache spenta');
});

test('cache: scarica a blocchi Range, una volta sola, e serve la copia da 127.0.0.1 con Range', async () => {
  const log = [];
  const c = new AudioCache({ budgetMb: 96, fetchFn: fetchFinto(9 * MB, { log }), log() {} });
  assert.equal(c.scarica('k1', info(), { durata: 200 }), true);
  assert.equal(c.scarica('k1', info(), { durata: 200 }), true, 'doppione: nessun secondo download');
  await c.attesa();
  assert.deepEqual(log.map((x) => x.range), ['bytes=0-4194303', 'bytes=4194304-8388607', 'bytes=8388608-9437183']);
  assert.equal(c.stato().mb, 9);
  const s = await c.sorgente('k1');
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/c\/[\w-]+$/);
  assert.equal(s.acodec, 'opus');
  const r = await fetch(s.url, { headers: { Range: 'bytes=100-199' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 100-199/${9 * MB}`);
  assert.equal((await r.arrayBuffer()).byteLength, 100);
  const intero = await fetch(s.url, { method: 'HEAD' });
  assert.equal(intero.headers.get('content-length'), String(9 * MB));
  assert.equal((await fetch(s.url.replace(/c\/.*/, 'c/sconosciuto'))).status, 404);
  c.svuota();
});

test('cache: budget in MB e numero di brani, esce il meno usato ma mai quello protetto', async () => {
  const c = new AudioCache({ budgetMb: 20, maxBrani: 3, fetchFn: fetchFinto(6 * MB), log() {} });
  for (const k of ['a', 'b', 'c']) c.scarica(k, info(), { durata: 200 });
  await c.attesa();
  assert.deepEqual([...c.voci.keys()], ['a', 'b', 'c']);
  await c.sorgente('a'); // «a» usato di recente: ora il meno usato è «b»
  c.proteggi('g1', ['b']); // ma «b» è il brano in corso: non si tocca
  c.scarica('d', info(), { durata: 200 });
  await c.attesa();
  assert.deepEqual([...c.voci.keys()], ['b', 'a', 'd'], 'è uscito «c», non il protetto «b»');
  assert.ok(c.usati() <= 20 * MB);
  // Tutto protetto e niente spazio: il nuovo brano non entra (e non rompe niente)
  c.proteggi('g1', ['a', 'b', 'd']);
  c.scarica('e', info(), { durata: 200 });
  await c.attesa();
  assert.equal(c.ha('e'), false);
  assert.equal(c.stato().scartati, 1);
  c.svuota();
});

test('cache: svuota annulla il download in corso e libera tutto', async () => {
  let sblocca;
  const lento = async (url, { signal }) => {
    await new Promise((r) => { sblocca = r; signal.addEventListener('abort', r); });
    if (signal.aborted) throw Object.assign(new Error('annullato'), { name: 'AbortError' });
    return new Response(Buffer.alloc(10), { status: 206, headers: { 'content-range': 'bytes 0-9/10' } });
  };
  const c = new AudioCache({ budgetMb: 10, fetchFn: lento, log() {} });
  c.scarica('x', info(), { durata: 100 });
  c.scarica('y', info(), { durata: 100 });
  await flush();
  assert.equal(c.stato().inCoda, 2);
  const r = c.svuota();
  await c.attesa();
  sblocca?.();
  assert.equal(r.brani, 0);
  assert.equal(c.ha('x'), false);
  assert.equal(c.ha('y'), false);
  assert.deepEqual({ brani: c.stato().brani, inCoda: c.stato().inCoda }, { brani: 0, inCoda: 0 });
});

// ---------- musica: cache, prefetch, volume ----------
const audioFinto = (log, extra = {}) => (src, at, opz) => {
  const a = { stream: null, kill() { a.ucciso = true; }, touch() {}, bytes: () => 1, idleMs: () => 0, ready: async () => {}, volume: opz?.volume, fonte: opz?.fonte, ...extra };
  log.push({ url: src.url, at, ...opz, a });
  return a;
};

test('audio: con il brano in RAM parte dalla copia locale, senza yt-dlp', async () => {
  const g = new GuildMusic('g', { bot: null, onChange() {}, onNotice() {} });
  const log = [];
  let risoluzioni = 0;
  g.cache = { sorgente: async () => ({ url: 'http://127.0.0.1:1/c/x', headers: {}, acodec: 'opus', direct: true }), togli() {}, proteggi() {} };
  g.lib.getStream = async () => { risoluzioni++; return info(); };
  g.lib.createOpusStreamAt = audioFinto(log);
  const a = await g.openAudio(brano('aaaaaaaaaaa'), 42);
  assert.equal(a.fonte, 'cache');
  assert.deepEqual([log[0].url, log[0].at, log[0].volume], ['http://127.0.0.1:1/c/x', 42, 60]);
  assert.equal(risoluzioni, 0);
});

test('prefetch: risolve il prossimo con priorità bassa e lo scarica in RAM; se è già in RAM non chiama yt-dlp', async () => {
  const g = new GuildMusic('g', { bot: { ready: true, inVoice: () => true }, onChange() {}, onNotice() {} });
  const scaricati = [];
  const opzioniYtdlp = [];
  let inRam = false;
  g.cache = { ha: () => inRam, proteggi() {}, scarica: (k) => scaricati.push(k) };
  g.lib.getStream = async (_url, _req, o) => { opzioniYtdlp.push(o); return { ...info(), exp: Date.now() + 60_000 }; };
  g.current = brano('aaaaaaaaaaa');
  g.queue.push(brano('bbbbbbbbbbb'));
  await g.prefetch();
  assert.deepEqual(opzioniYtdlp, [{ bassa: true }]);
  assert.deepEqual(scaricati, ['https://www.youtube.com/watch?v=bbbbbbbbbbb']);
  inRam = true;
  g.streamCache.clear();
  await g.prefetch();
  assert.equal(opzioniYtdlp.length, 1, 'già in RAM: nessuna risoluzione');
});

/** Brano «in riproduzione» con un player finto, per il cambio di volume. */
function inRiproduzione() {
  const g = new GuildMusic('g', { bot: { ready: true, inVoice: () => true, isConnected: () => true }, onChange() {}, onNotice() {} });
  const suonati = [];
  g.player = { play: (r) => suonati.push(r), pause() {}, unpause() {}, stop() {} };
  g.current = brano('aaaaaaaaaaa');
  g.startedAt = Date.now() - 50_000; // a 50 s
  g.audio = { volume: 60, kill() { g.vecchioUcciso = true; }, touch() {}, idleMs: () => 0, bytes: () => 1 };
  return { g, suonati };
}

test('volume: un solo riavvio dopo che il cursore si ferma, nuovo audio un po\' avanti e scambio senza silenzio', async () => {
  const { g, suonati } = inRiproduzione();
  const log = [];
  g.latenza.rete = 0; // anticipo minimo: 0,05 s
  g.openAudio = async (t, at, o) => { log.push({ at, o, volume: g.volume }); return { stream: new (await import('node:stream')).PassThrough(), volume: g.volume, kill() {}, touch() {}, idleMs: () => 0, bytes: () => 1 }; };
  g.setVolume(70);
  g.setVolume(80);
  g.setVolume(90);
  assert.equal(log.length, 0, 'mentre il cursore si muove non riapre niente');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(log.length, 1, 'una sola riapertura');
  assert.equal(log[0].volume, 90);
  assert.deepEqual(log[0].o, { soloVeloce: true });
  assert.ok(log[0].at > 50 && log[0].at < 51, `parte dal punto attuale (+anticipo): ${log[0].at}`);
  assert.equal(suonati.length, 1, 'risorsa nuova al player');
  assert.equal(g.vecchioUcciso, true, 'il vecchio ffmpeg è chiuso dopo lo scambio');
  assert.ok(Math.abs(g.position() - 50.4) < 0.3, `la posizione non salta: ${g.position()}`);
  g.killAudio();
});

test('volume in pausa: niente riavvio subito, si applica alla ripresa', async () => {
  const { g } = inRiproduzione();
  g.pause();
  let aperture = 0;
  g.openAudio = async () => { aperture++; throw new Error('non deve servire'); };
  g.setVolume(30);
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(aperture, 0);
  assert.equal(g.pendingSeek, true, 'alla ripresa riparte dal punto della pausa con il volume nuovo');
  g.killAudio();
});

// ---------- riposo ----------
test('riposo: 2 min senza nessuno in vocale → cache svuotata, link e player liberati; una volta sola per ogni pausa lunga', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let inVoce = true;
  const bot = { ready: true, inVoice: () => inVoce, isConnected: () => inVoce, leave() {} };
  let svuotate = 0;
  let extra = 0;
  const cache = { proteggi() {}, svuota: () => { svuotate++; return { brani: 2, mb: 7 }; } };
  const m = new MusicManager({ bot, onChange() {}, onNotice() {}, cache, riposoMinuti: 2, onRiposo: () => extra++ });
  const g = m.get('g');
  g.streamCache.set('x', { url: 'u', exp: Date.now() + 1e6 });
  g.changed();
  mock.timers.tick(10 * 60_000);
  assert.equal(svuotate, 0, 'in vocale: niente riposo');

  inVoce = false;
  g.changed();
  mock.timers.tick(60_000);
  inVoce = true; // rientra prima dei 2 minuti: il conto si annulla
  g.changed();
  mock.timers.tick(5 * 60_000);
  assert.equal(svuotate, 0);

  inVoce = false;
  g.changed();
  mock.timers.tick(2 * 60_000);
  assert.equal(svuotate, 1);
  assert.equal(extra, 1);
  assert.equal(g.streamCache.size, 0);
  assert.equal(g.player, null);
  g.changed();
  mock.timers.tick(10 * 60_000);
  assert.equal(svuotate, 1, 'una volta sola finché il bot non torna attivo');
});
