// Collegamento dell'Activity: limiti di tempo di ogni passo, nuovi tentativi dal passo giusto,
// badge e messaggi. Niente Discord né browser: SDK, fetch e WebSocket sono finti. Avvio: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StepError, TIMEOUTS, createIdentityFlow, createSession, statusLabel, stuckMessage, withTimeout,
} from '../../client/src/session.js';
import { CLOSE_DENIED, CLOSE_REAUTH } from '../../client/src/reconnect.js';
import { CLOSE_REAUTH as SERVER_REAUTH, createAuth } from '../src/auth.js';
import { closeLine, formatDuration } from '../src/wslog.js';

const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** Orologio finto: i timer scattano solo con advance(). */
function fakeClock() {
  let t = 0;
  let seq = 0;
  const jobs = new Map();
  const add = (fn, ms, every) => { const id = ++seq; jobs.set(id, { fn, at: t + ms, every }); return id; };
  const timers = {
    setTimeout: (fn, ms = 0) => add(fn, ms, 0),
    clearTimeout: (id) => jobs.delete(id),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearInterval: (id) => jobs.delete(id),
  };
  async function advance(ms) {
    const end = t + ms;
    for (;;) {
      await flush();
      let next = null;
      for (const [id, j] of jobs) if (j.at <= end && (!next || j.at < next[1].at)) next = [id, j];
      if (!next) break;
      const [id, j] = next;
      t = j.at;
      if (j.every) j.at += j.every; else jobs.delete(id);
      j.fn();
    }
    t = end;
    await flush();
  }
  return { timers, now: () => t, advance };
}

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

/** SDK finto: ogni comando si può far rispondere subito, mai, o con errore. */
function fakeSdk({ ready = 'ok', guildId = 'g1' } = {}) {
  const sdk = {
    isReady: false,
    guildId,
    channelId: 'c1',
    handshakes: 0,
    readyMode: ready,
    authorizeCalls: 0,
    authenticateCalls: 0,
    authorizeImpl: async () => ({ code: `code${sdk.authorizeCalls}` }),
    authenticateImpl: async ({ access_token }) => ({ user: { username: 'prova', global_name: 'Prova' }, access_token }),
    ready() {
      if (sdk.readyMode === 'ok') { sdk.isReady = true; return Promise.resolve(); }
      return new Promise(() => {}); // mai pronto
    },
    handshake() { sdk.handshakes++; },
    commands: {
      authorize: (args) => { sdk.authorizeCalls++; return sdk.authorizeImpl(args); },
      authenticate: (args) => { sdk.authenticateCalls++; return sdk.authenticateImpl(args); },
    },
  };
  return sdk;
}

function makeFlow({ sdk = fakeSdk(), clock = fakeClock(), getConfig, exchangeCode, insideDiscord = true, resume } = {}) {
  const calls = { config: 0, exchange: [] };
  const deps = {
    insideDiscord,
    getConfig: getConfig || (async () => { calls.config++; return { clientId: 'app', prova: false }; }),
    createSdk: () => sdk,
    exchangeCode: exchangeCode || (async (code) => { calls.exchange.push(code); return { access_token: `tok-${code}`, expires_in: 604800 }; }),
    resume,
  };
  const flow = createIdentityFlow(deps, { timers: clock.timers, now: clock.now });
  return { flow, sdk, clock, calls, deps };
}

/** WebSocket finto. */
function fakeSockets() {
  const list = [];
  class FakeWS {
    constructor() { this.readyState = 0; this.sent = []; this.closedWith = null; list.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close(code) { this.closedWith = code ?? 1000; this.readyState = 3; }
    // comandi del test
    open() { this.readyState = 1; this.onopen?.(); }
    msg(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
    welcome() { this.msg({ type: 'welcome', user: { name: 'Prova' } }); }
    serverClose(code) { this.readyState = 3; this.onclose?.({ code }); }
  }
  return { list, create: () => new FakeWS(), last: () => list[list.length - 1] };
}

function makeSession(opts = {}) {
  const f = makeFlow(opts);
  const socks = fakeSockets();
  const views = [];
  const msgs = [];
  const session = createSession({
    flow: f.flow,
    createSocket: socks.create,
    onStatus: (v) => views.push(v),
    onMessage: (m) => msgs.push(m),
    timers: f.clock.timers,
    now: f.clock.now,
    random: () => 1,
  });
  return { ...f, socks, views, msgs, session, last: () => views[views.length - 1] };
}

// ---------- limiti di tempo ----------
test('withTimeout: allo scadere un StepError "timeout" con il passo giusto', async () => {
  const clock = fakeClock();
  const p = withTimeout(new Promise(() => {}), 1000, 'token', null, clock.timers);
  let err;
  p.catch((e) => { err = e; });
  await clock.advance(999);
  assert.equal(err, undefined);
  await clock.advance(1);
  assert.ok(err instanceof StepError);
  assert.equal(err.step, 'token');
  assert.equal(err.kind, 'timeout');
  // se risponde in tempo passa il valore
  assert.equal(await withTimeout(Promise.resolve(7), 1000, 'token', null, clock.timers), 7);
});

// ---------- accesso a passi ----------
test('accesso: tutto ok, poi il secondo giro riusa SDK, config e token senza nuova autorizzazione', async () => {
  const { flow, sdk, calls } = makeFlow();
  const steps = [];
  const id = await flow.run((s) => steps.push(s));
  assert.deepEqual(steps, ['config', 'ready', 'authorize', 'token', 'authenticate']);
  assert.equal(id.mode, 'discord');
  assert.equal(id.guildId, 'g1');
  assert.equal(id.accessToken, 'tok-code1');
  assert.equal(id.user.name, 'Prova');
  await flow.run();
  assert.equal(calls.config, 1);
  assert.equal(sdk.authorizeCalls, 1);
  assert.equal(sdk.authenticateCalls, 1);
});

test('accesso: SDK mai pronto → timeout dopo 10 s e stretta di mano rimandata', async () => {
  const sdk = fakeSdk({ ready: 'never' });
  const { flow, clock } = makeFlow({ sdk });
  let err;
  flow.run().catch((e) => { err = e; });
  await clock.advance(TIMEOUTS.ready);
  assert.equal(err?.step, 'ready');
  assert.equal(err?.kind, 'timeout');
  assert.equal(sdk.handshakes, 1);
  sdk.readyMode = 'ok';
  const id = await flow.run();
  assert.equal(id.mode, 'discord');
});

test('accesso: finestra di autorizzazione senza risposta → timeout a 60 s; chiusa → serve un clic', async () => {
  const sdk = fakeSdk();
  sdk.authorizeImpl = () => new Promise(() => {});
  const { flow, clock } = makeFlow({ sdk });
  let err;
  flow.run().catch((e) => { err = e; });
  await clock.advance(TIMEOUTS.authorize - 1);
  assert.equal(err, undefined);
  await clock.advance(1);
  assert.equal(err.step, 'authorize');
  assert.equal(err.kind, 'timeout');

  sdk.authorizeImpl = async () => { throw Object.assign(new Error('User closed'), { code: 5000 }); };
  await assert.rejects(flow.run(), (e) => e.step === 'authorize' && e.kind === 'user');
});

test('accesso: scambio del token fallito → al giro dopo nuovo authorize (il code non si riusa)', async () => {
  let n = 0;
  const seen = [];
  const { flow, sdk } = makeFlow({
    exchangeCode: async (code) => {
      seen.push(code);
      if (n++ === 0) throw new StepError('token', 'invalid_grant');
      return { access_token: 'tok', expires_in: 3600 };
    },
  });
  await assert.rejects(flow.run(), (e) => e.step === 'token');
  const id = await flow.run();
  assert.equal(id.accessToken, 'tok');
  assert.deepEqual(seen, ['code1', 'code2']);
  assert.equal(sdk.authorizeCalls, 2);
});

test('accesso: /api/token appeso → timeout a 10 s', async () => {
  const { flow, clock } = makeFlow({ exchangeCode: () => new Promise(() => {}) });
  let err;
  flow.run().catch((e) => { err = e; });
  await clock.advance(TIMEOUTS.token);
  assert.equal(err?.step, 'token');
  assert.equal(err?.kind, 'timeout');
});

test('accesso: authenticate appeso riusa il token, authenticate rifiutato rifà authorize', async () => {
  const sdk = fakeSdk();
  const real = sdk.authenticateImpl;
  sdk.authenticateImpl = () => new Promise(() => {});
  const { flow, clock, calls } = makeFlow({ sdk });
  let err;
  flow.run().catch((e) => { err = e; });
  await clock.advance(TIMEOUTS.authenticate);
  assert.equal(err?.step, 'authenticate');
  assert.equal(err?.kind, 'timeout');

  sdk.authenticateImpl = async () => { throw new Error('Invalid token'); };
  await assert.rejects(flow.run(), (e) => e.step === 'authenticate' && e.reauth === true);
  assert.equal(sdk.authorizeCalls, 1, 'token ancora valido dopo il timeout: niente nuovo authorize');

  sdk.authenticateImpl = real;
  await flow.run();
  assert.equal(sdk.authorizeCalls, 2, 'token rifiutato: nuovo authorize');
  assert.equal(calls.exchange.length, 2);
});

test('accesso: token scaduto → nuova autorizzazione', async () => {
  const clock = fakeClock();
  const { flow, sdk } = makeFlow({ clock, exchangeCode: async () => ({ access_token: 't', expires_in: 120 }) });
  await flow.run();
  await clock.advance(61_000); // vale 120 s meno un minuto di margine
  await flow.run();
  assert.equal(sdk.authorizeCalls, 2);
});

test('accesso: errori definitivi (fuori da Discord senza prova, messaggio privato) sono "fatal"', async () => {
  const fuori = makeFlow({ insideDiscord: false });
  await assert.rejects(fuori.flow.run(), (e) => e.kind === 'fatal');
  const dm = makeFlow({ sdk: fakeSdk({ guildId: null }) });
  await assert.rejects(dm.flow.run(), (e) => e.kind === 'fatal');
  const prova = makeFlow({ insideDiscord: false, getConfig: async () => ({ prova: true, provaGuildId: 'pg', provaChannelId: 'pc' }) });
  assert.equal((await prova.flow.run()).mode, 'prova');
});

test('accesso: chiamate durante un giro in corso ricevono la stessa promessa', async () => {
  const { flow, sdk } = makeFlow();
  const [a, b] = await Promise.all([flow.run(), flow.run()]);
  assert.equal(a, b);
  assert.equal(sdk.authorizeCalls, 1);
});

// ---------- sessione: accesso + WebSocket ----------
test('sessione: tutto ok → badge con il passo, poi online', async () => {
  const s = makeSession();
  await s.clock.advance(0);
  assert.equal(s.socks.list.length, 1);
  assert.equal(s.last().step, 'socket');
  assert.equal(statusLabel(s.last()), 'Connessione… (server)');
  s.socks.last().open();
  assert.equal(s.socks.last().sent[0].type, 'hello');
  assert.equal(s.socks.last().sent[0].accessToken, 'tok-code1');
  s.socks.last().welcome();
  assert.equal(s.last().status, 'online');
  assert.equal(s.last().error, null);
  assert.ok(s.views.some((v) => v.step === 'authorize'));
  s.session.close();
});

test('sessione: server spento all\'avvio (config appeso) → timeout e nuovo tentativo, poi online', async () => {
  let up = false;
  const s = makeSession({
    getConfig: () => (up ? Promise.resolve({ clientId: 'app' }) : new Promise(() => {})),
  });
  await s.clock.advance(TIMEOUTS.config);
  assert.equal(s.last().status, 'connecting');
  assert.equal(s.last().step, 'config');
  assert.match(s.last().error, /server/);
  assert.equal(statusLabel(s.last()), 'Connessione… (server)');
  up = true;
  await s.clock.advance(1000); // primo backoff ≤ 0,5 s
  assert.equal(s.socks.list.length, 1);
  s.socks.last().open();
  s.socks.last().welcome();
  assert.equal(s.last().status, 'online');
  s.session.close();
});

test('sessione: WebSocket aperto ma senza benvenuto → chiuso dopo 12 s e riaperto', async () => {
  const s = makeSession();
  await s.clock.advance(0);
  const first = s.socks.last();
  first.open();
  assert.equal(statusLabel(s.last()), 'Connessione… (server)');
  await s.clock.advance(TIMEOUTS.welcome);
  assert.equal(first.closedWith, 4000);
  assert.match(s.last().error, /benvenuto/);
  await s.clock.advance(1000);
  assert.equal(s.socks.list.length, 2);
  s.socks.last().open();
  s.socks.last().welcome();
  assert.equal(s.last().status, 'online');
  s.session.close();
});

test('sessione: riavvio del server durante la presentazione → nuovo tentativo con lo stesso token', async () => {
  const s = makeSession();
  await s.clock.advance(0);
  s.socks.last().open();
  s.socks.last().serverClose(1006);
  assert.equal(s.last().status, 'connecting');
  await s.clock.advance(1000);
  s.socks.last().open();
  s.socks.last().welcome();
  assert.equal(s.last().status, 'online');
  assert.equal(s.sdk.authorizeCalls, 1);
  // caduta da online: "Riconnessione…" e si riparte
  s.socks.last().serverClose(1006);
  assert.equal(statusLabel(s.last()), 'Riconnessione… (server)');
  await s.clock.advance(1000);
  assert.equal(s.socks.list.length, 3);
  s.session.close();
});

test('sessione: token rifiutato dal server (4003) → nuova autorizzazione e nuovo token', async () => {
  const s = makeSession();
  await s.clock.advance(0);
  s.socks.last().open();
  s.socks.last().msg({ type: 'notice', kind: 'error', message: 'Accesso negato: token non valido o scaduto' });
  s.socks.last().serverClose(CLOSE_REAUTH);
  assert.equal(s.last().status, 'connecting');
  await s.clock.advance(1000);
  assert.equal(s.sdk.authorizeCalls, 2);
  s.socks.last().open();
  assert.equal(s.socks.last().sent[0].accessToken, 'tok-code2');
  s.socks.last().welcome();
  assert.equal(s.last().status, 'online');
  assert.equal(SERVER_REAUTH, CLOSE_REAUTH);
  s.session.close();
});

test('sessione: accesso negato (4001) → fermi con messaggio; Riprova → online', async () => {
  const s = makeSession();
  await s.clock.advance(0);
  s.socks.last().open();
  s.socks.last().msg({ type: 'notice', kind: 'error', message: 'Accesso negato: non sei membro' });
  s.socks.last().serverClose(CLOSE_DENIED);
  assert.equal(s.last().status, 'denied');
  assert.match(s.last().error, /non sei membro/);
  await s.clock.advance(60_000);
  assert.equal(s.socks.list.length, 1, 'niente tentativi da soli');
  s.session.retry();
  await s.clock.advance(0);
  s.socks.last().open();
  s.socks.last().welcome();
  assert.equal(s.last().status, 'online');
  s.session.close();
});

test('sessione: autorizzazione chiusa dall\'utente → "blocked"; Riprova la richiede di nuovo', async () => {
  const sdk = fakeSdk();
  sdk.authorizeImpl = async () => { throw new Error('closed'); };
  const s = makeSession({ sdk });
  await s.clock.advance(0);
  assert.equal(s.last().status, 'blocked');
  assert.match(stuckMessage(s.last()), /Riprova/);
  await s.clock.advance(60_000);
  assert.equal(sdk.authorizeCalls, 1, 'la finestra non ricompare da sola');
  sdk.authorizeImpl = async () => ({ code: 'c' });
  s.session.retry();
  await s.clock.advance(0);
  s.socks.last().open();
  s.socks.last().welcome();
  assert.equal(s.last().status, 'online');
  s.session.close();
});

test('sessione: Riprova abbandona un passo appeso e riparte subito', async () => {
  const sdk = fakeSdk();
  const pending = deferred();
  sdk.authorizeImpl = () => pending.promise;
  const s = makeSession({ sdk });
  await s.clock.advance(20_000);
  assert.equal(s.last().step, 'authorize');
  sdk.authorizeImpl = async () => ({ code: 'nuovo' });
  s.session.retry();
  await s.clock.advance(0);
  assert.equal(sdk.authorizeCalls, 2);
  assert.equal(s.socks.list.length, 1);
  // la vecchia risposta che arriva tardi non fa danni
  pending.resolve({ code: 'vecchio' });
  await s.clock.advance(0);
  assert.equal(s.socks.list.length, 1);
  s.socks.last().open();
  s.socks.last().welcome();
  assert.equal(s.last().status, 'online');
  s.session.close();
});

test('sessione: errore definitivo → "fatal", nessun tentativo', async () => {
  const s = makeSession({ sdk: fakeSdk({ guildId: null }) });
  await s.clock.advance(60_000);
  assert.equal(s.last().status, 'fatal');
  assert.equal(s.socks.list.length, 0);
});

test('sessione: battito senza risposta dopo online → riconnessione', async () => {
  const s = makeSession();
  await s.clock.advance(0);
  s.socks.last().open();
  s.socks.last().welcome();
  await s.clock.advance(60_001); // 2 ping senza risposta + il terzo giro
  assert.equal(s.last().status, 'offline');
  assert.match(s.last().error, /nessuna risposta/);
  s.session.close();
});

test('badge e messaggio: passo leggibile e spiegazione', () => {
  assert.equal(statusLabel({ status: 'connecting', step: 'authorize' }), 'Connessione… (accesso a Discord)');
  assert.equal(statusLabel({ status: 'connecting', step: null }), 'Connessione…');
  assert.equal(statusLabel({ status: 'offline', step: 'welcome' }), 'Riconnessione… (server)');
  assert.equal(statusLabel({ status: 'online', mode: 'discord' }, { connected: true }), 'Nel canale vocale');
  assert.equal(statusLabel({ status: 'online', mode: 'prova' }), 'Modalità prova');
  assert.equal(statusLabel({ status: 'denied' }), 'Accesso negato');
  assert.match(stuckMessage({ status: 'connecting', step: 'socket', error: 'il server non risponde' }), /riavviando.*ultimo errore: il server non risponde/);
});

// ---------- server ----------
test('server: token rifiutato da Discord (401) → AuthError con reauth', async () => {
  const auth = createAuth({ fetchImpl: async () => ({ status: 401, ok: false }) });
  await assert.rejects(auth.whoIs('x'), (e) => e.reauth === true && !e.temporary);
  await assert.rejects(auth.whoIs(''), (e) => e.reauth === true);
  const down = createAuth({ fetchImpl: async () => ({ status: 503, ok: false }) });
  await assert.rejects(down.whoIs('x'), (e) => e.temporary === true && !e.reauth);
});

test('log: durate leggibili e riga di chiusura', () => {
  assert.equal(formatDuration(850), '850 ms');
  assert.equal(formatDuration(4200), '4,2 s');
  assert.equal(formatDuration(192_000), '3m12s');
  assert.equal(formatDuration(3_900_000), '1h05m');
  assert.equal(
    closeLine({ id: 3, code: 1001, startedAt: 0, now: 65_000, user: { name: 'Prova' }, guildId: 'g' }),
    '[ws] #3 chiusa 1001 pagina chiusa dopo 1m05s, Prova (g)',
  );
  assert.match(closeLine({ id: 4, code: 1006, startedAt: 0, now: 500 }), /senza presentarsi/);
});

// ---------- stretta di mano e diagnostica ----------
test('accesso: SDK mai pronto per più giri → stretta di mano rimandata una volta sola', async () => {
  const sdk = fakeSdk({ ready: 'never' });
  const { flow, clock } = makeFlow({ sdk });
  for (let i = 0; i < 4; i++) {
    let err;
    flow.run().catch((e) => { err = e; });
    await clock.advance(TIMEOUTS.ready);
    assert.equal(err?.step, 'ready');
  }
  assert.equal(sdk.handshakes, 1);
  assert.equal(flow.cache.handshakes, 2);
  assert.equal(flow.stepInfo.step, 'ready');
});

test('sessione: onFail a ogni insuccesso (con il passo), onOnline al primo benvenuto', async () => {
  const sdk = fakeSdk({ ready: 'never' });
  const f = makeFlow({ sdk });
  const socks = fakeSockets();
  const fails = [];
  let online = 0;
  createSession({
    flow: f.flow,
    createSocket: socks.create,
    onStatus: () => {},
    onMessage: () => {},
    timers: f.clock.timers,
    now: f.clock.now,
    random: () => 1,
    onFail: (err, info) => { fails.push([err.step, err.kind, info.attempt]); throw new Error('la diagnostica non rompe niente'); },
    onOnline: () => { online++; },
  });
  await f.clock.advance(TIMEOUTS.ready);
  assert.deepEqual(fails[0], ['ready', 'timeout', 0]);
  sdk.readyMode = 'ok';
  await f.clock.advance(1000);
  socks.last().open();
  socks.last().welcome();
  assert.equal(online, 1);
  socks.last().serverClose(1006);
  await f.clock.advance(1000);
  socks.last().open();
  socks.last().welcome();
  assert.equal(online, 1, 'solo la prima volta');
});

// ---------- iframe ricaricato da Discord (cambio di canale o di scheda) ----------
/** Memoria finta dell'accesso (in connection.js è sessionStorage). */
function fakeResume(initial = null) {
  const r = { data: initial, saves: 0, clears: 0 };
  r.api = {
    load: () => r.data,
    save: (d) => { r.saves++; r.data = { ...d }; },
    clear: () => { r.clears++; r.data = null; },
  };
  return r;
}

test("ripresa: dopo l'accesso il token si salva; la pagina ricaricata lo riusa senza READY né authorize", async () => {
  const mem = fakeResume();
  const first = makeFlow({ resume: mem.api });
  const id1 = await first.flow.run();
  assert.equal(id1.resumed, false);
  assert.equal(mem.saves, 1);
  assert.equal(mem.data.token, id1.accessToken);
  assert.equal(mem.data.name, 'Prova');

  // Nuova pagina nello stesso iframe: Discord manda solo HELLO, il READY non arriva mai.
  const sdk = fakeSdk({ ready: 'never' });
  const second = makeFlow({ sdk, resume: mem.api, clock: first.clock });
  const steps = [];
  const id2 = await second.flow.run((s) => steps.push(s));
  assert.equal(id2.resumed, true);
  assert.equal(id2.accessToken, id1.accessToken);
  assert.equal(id2.user.name, 'Prova');
  assert.equal(id2.guildId, 'g1');
  assert.equal(sdk.authorizeCalls + sdk.authenticateCalls, 0);
  assert.ok(steps.includes('ripresa') && !steps.includes('ready'));
});

test('ripresa: token salvato scaduto → cancellato, via normale', async () => {
  const mem = fakeResume({ token: 'vecchio', exp: -1, name: 'Prova' });
  const { flow, sdk } = makeFlow({ resume: mem.api });
  const id = await flow.run();
  assert.equal(mem.clears, 1);
  assert.equal(id.resumed, false);
  assert.equal(sdk.authorizeCalls, 1);
});

test('ready: seconda stretta di mano senza risposta → "reopen", la sessione si ferma e non ritenta', async () => {
  const sdk = fakeSdk({ ready: 'never' });
  const s = makeSession({ sdk });
  await s.clock.advance(TIMEOUTS.ready);
  assert.equal(s.last().status, 'connecting');
  assert.equal(sdk.handshakes, 1);
  await s.clock.advance(2000 + TIMEOUTS.ready);
  assert.equal(s.last().status, 'reopen');
  assert.equal(s.last().step, 'ready');
  const n = s.views.length;
  await s.clock.advance(120_000);
  assert.equal(s.views.length, n, 'fermi: niente tentativi inutili');
  assert.equal(statusLabel(s.last()), 'Non collegato');
  assert.match(stuckMessage(s.last()), /chiusa e riaperta/);
  // READY arrivato tardi: connection.js chiama retry() e si riparte.
  sdk.readyMode = 'ok';
  s.session.retry();
  await s.clock.advance(10);
  s.socks.last().open();
  s.socks.last().welcome();
  assert.equal(s.last().status, 'online');
});

test('ripresa: token salvato rifiutato dal server (4003) → memoria cancellata, si torna al READY', async () => {
  const mem = fakeResume({ token: 'salvato', exp: 1e12, name: 'Prova' });
  const sdk = fakeSdk({ ready: 'never' });
  const s = makeSession({ sdk, resume: mem.api });
  await s.clock.advance(10);
  assert.equal(s.socks.last().constructor.name, 'FakeWS');
  s.socks.last().open();
  assert.equal(s.socks.last().sent[0].accessToken, 'salvato');
  s.socks.last().serverClose(CLOSE_REAUTH);
  await s.clock.advance(2000);
  assert.equal(mem.data, null);
  assert.equal(s.last().step, 'ready');
  await s.clock.advance(2 * TIMEOUTS.ready + 5000);
  assert.equal(s.last().status, 'reopen');
});
