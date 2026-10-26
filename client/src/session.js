// Logica pura (senza browser) del collegamento: accesso a Discord a passi, ognuno con un limite di
// tempo, e sessione che ritenta da sola con attese crescenti fino al benvenuto del server.
// Le parti del browser (SDK, fetch, WebSocket) arrivano da connection.js, così si prova con npm test.
import { CLOSE_DENIED, CLOSE_REAUTH, backoffDelay, createHeartbeat } from './reconnect.js';

/** Limiti di tempo di ogni passo (ms). */
export const TIMEOUTS = {
  config: 10_000, // /api/config dal nostro server
  ready: 10_000, // SDK di Discord pronto
  authorize: 60_000, // finestra di autorizzazione di Discord (l'utente deve rispondere)
  token: 10_000, // /api/token: il server scambia il code con Discord
  authenticate: 10_000, // SDK: accesso con il token
  welcome: 12_000, // WebSocket: benvenuto del server (la sua verifica dura al massimo ~8 s)
};

/** Dopo quanto tempo senza riuscire si mostrano spiegazione e pulsante «Riprova». */
export const STUCK_AFTER_MS = 20_000;

/** Cosa si sta aspettando, detto in breve per il badge in alto. */
export const STEP_LABEL = {
  config: 'server',
  ready: 'Discord',
  ripresa: 'Discord',
  authorize: 'accesso a Discord',
  token: 'accesso a Discord',
  authenticate: 'accesso a Discord',
  socket: 'server',
  welcome: 'server',
};

/**
 * Errore di un passo.
 * kind: 'timeout' | 'failed' | 'user' (serve un clic dell'utente) | 'fatal' (inutile ritentare) |
 *       'reopen' (Discord non risponderà più a questa pagina: va chiusa e riaperta l'Activity).
 * reauth: il token non va più bene, al prossimo giro si rifà l'autorizzazione.
 */
export class StepError extends Error {
  constructor(step, message, { kind = 'failed', reauth = false } = {}) {
    super(message);
    this.step = step;
    this.kind = kind;
    this.reauth = reauth;
  }
}

const realTimers = () => ({
  setTimeout: (...a) => globalThis.setTimeout(...a),
  clearTimeout: (t) => globalThis.clearTimeout(t),
  setInterval: (...a) => globalThis.setInterval(...a),
  clearInterval: (t) => globalThis.clearInterval(t),
});

/** Promessa con limite di tempo: allo scadere rifiuta con StepError kind 'timeout'. */
export function withTimeout(promise, ms, step, message, timers = realTimers()) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = timers.setTimeout(() => reject(new StepError(step, message || `${STEP_LABEL[step] || step} non risponde`, { kind: 'timeout' })), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => timers.clearTimeout(t));
}

/**
 * Accesso a passi con memoria tra un tentativo e l'altro: config e SDK pronti si fanno una volta,
 * l'access token si riusa finché vale; il code OAuth non si riusa mai (vale una volta sola).
 *
 * deps:
 *   insideDiscord: boolean
 *   getConfig(): Promise<cfg>
 *   createSdk(clientId): sdk con ready(), isReady, handshake(), guildId, channelId, commands.{authorize,authenticate}
 *   exchangeCode(code): Promise<{ access_token, expires_in? }> (lancia StepError o Error)
 *   resume (facoltativo): { load(): { token, exp, name } | null, save({ token, exp, name }), clear() }
 *     Memoria dell'accesso per QUESTA Activity (frame_id + instance_id) che sopravvive al
 *     ricaricamento dell'iframe. Serve perché Discord risponde a una sola stretta di mano per iframe
 *     montato (issue discord/embedded-app-sdk#41): se l'iframe si ricarica (es. cambio di canale o
 *     di scheda) il READY non arriva più e authorize/authenticate non si possono rifare. Con un token
 *     ancora valido si salta l'SDK e si va dritti al nostro server, che il token lo verifica comunque.
 */
export function createIdentityFlow(deps, { timeouts = TIMEOUTS, timers = realTimers(), now = Date.now } = {}) {
  const cache = { cfg: null, sdk: null, token: null, auth: null, handshakes: 1, resumed: false, triedResume: false };
  const safely = (fn) => { try { return fn(); } catch { return null; } };
  let inflight = null;
  let step = null;
  let stepAt = now();
  const listeners = new Set();
  const setStep = (s) => {
    step = s;
    stepAt = now();
    for (const fn of listeners) fn(s);
  };
  const timed = (p, s, message) => withTimeout(p, timeouts[s], s, message, timers);

  async function run() {
    setStep('config');
    if (!cache.cfg) {
      let cfg;
      try {
        cfg = await timed(deps.getConfig(), 'config', 'il server non risponde');
      } catch (err) {
        throw err instanceof StepError ? err : new StepError('config', `il server non risponde (${err.message})`);
      }
      cache.cfg = cfg;
    }
    const cfg = cache.cfg;

    if (!deps.insideDiscord) {
      if (!cfg.prova) {
        throw new StepError('config', 'Questa pagina va aperta come Activity dentro Discord. Per provarla nel browser avvia il server con MODALITA_PROVA=1.', { kind: 'fatal' });
      }
      return { mode: 'prova', guildId: cfg.provaGuildId, channelId: cfg.provaChannelId, accessToken: null, user: { name: 'Prova' } };
    }
    if (!cfg.clientId) throw new StepError('config', 'DISCORD_CLIENT_ID non impostato sul server', { kind: 'fatal' });

    if (!cache.sdk) {
      try {
        cache.sdk = deps.createSdk(cfg.clientId);
      } catch (err) {
        throw new StepError('ready', `SDK di Discord non avviato: ${err.message}`, { kind: 'fatal' });
      }
    }
    const sdk = cache.sdk;

    // Pagina ricaricata dentro la stessa Activity: si riprende con il token salvato, senza READY.
    if (!sdk.isReady && !cache.token && !cache.triedResume && deps.resume) {
      cache.triedResume = true;
      const r = safely(() => deps.resume.load());
      if (r?.token && Number(r.exp) > now()) {
        setStep('ripresa');
        cache.token = { value: r.token, exp: Number(r.exp) };
        cache.auth = { token: r.token, user: { global_name: r.name || null, username: r.name || 'utente' } };
        cache.resumed = true;
      } else if (r) {
        safely(() => deps.resume.clear());
      }
    }

    if (!cache.resumed) {
      setStep('ready');
      if (!sdk.isReady) {
        try {
          await timed(sdk.ready(), 'ready', 'Discord non risponde all\'Activity');
        } catch (err) {
          // Discord risponde a una sola stretta di mano per iframe montato (issue
          // discord/embedded-app-sdk#41): la si rimanda UNA volta, nel caso la prima sia andata persa.
          // Ripeterla di più non serve e su mobile potrebbe chiudere l'Activity.
          if (cache.handshakes < 2) {
            cache.handshakes++;
            try { sdk.handshake?.(); } catch { /* niente */ }
            throw err;
          }
          // Anche la seconda è rimasta senza risposta: questa pagina non riceverà più il READY.
          throw new StepError('ready', 'Discord non risponde più a questa pagina dell\'Activity', { kind: 'reopen' });
        }
      }
    }
    if (!sdk.guildId) {
      throw new StepError('ready', 'Apri l\'Activity da un canale vocale di un server, non in un messaggio privato', { kind: 'fatal' });
    }

    if (!cache.token || cache.token.exp <= now()) {
      cache.token = null;
      cache.auth = null;
      setStep('authorize');
      let code;
      try {
        ({ code } = await timed(
          sdk.commands.authorize({ client_id: cfg.clientId, response_type: 'code', state: '', prompt: 'none', scope: ['identify', 'guilds'] }),
          'authorize',
          'la richiesta di autorizzazione di Discord non ha avuto risposta',
        ));
      } catch (err) {
        if (err instanceof StepError) throw err;
        // Finestra chiusa o accesso rifiutato: ritentare da soli farebbe ricomparire la finestra.
        throw new StepError('authorize', 'Autorizzazione di Discord non concessa o annullata', { kind: 'user' });
      }
      if (!code) throw new StepError('authorize', 'Discord non ha dato il codice di accesso');

      setStep('token');
      let data;
      try {
        data = await timed(deps.exchangeCode(code), 'token', 'il server non risponde allo scambio del token');
      } catch (err) {
        throw err instanceof StepError ? err : new StepError('token', `accesso non riuscito (${err.message})`);
      }
      if (!data?.access_token) throw new StepError('token', 'il server non ha dato il token');
      const life = Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : 24 * 3600_000;
      cache.token = { value: data.access_token, exp: now() + Math.max(life - 60_000, 30_000) };
    }

    const token = cache.token.value;
    if (!cache.auth || cache.auth.token !== token) {
      setStep('authenticate');
      let auth;
      try {
        auth = await timed(sdk.commands.authenticate({ access_token: token }), 'authenticate', 'Discord non conferma l\'accesso');
      } catch (err) {
        if (err instanceof StepError) throw err; // tempo scaduto: il token si può riusare
        cache.token = null; // rifiutato: al prossimo giro nuova autorizzazione
        throw new StepError('authenticate', `Discord ha rifiutato l'accesso (${err.message || 'token non valido'})`, { reauth: true });
      }
      if (!auth?.user) {
        cache.token = null;
        throw new StepError('authenticate', 'Autenticazione con Discord non riuscita', { reauth: true });
      }
      cache.auth = { token, user: auth.user };
      const au = auth.user;
      safely(() => deps.resume?.save({ token, exp: cache.token.exp, name: au.global_name || au.username }));
    }

    const u = cache.auth.user;
    return {
      mode: 'discord',
      guildId: sdk.guildId,
      channelId: sdk.channelId,
      accessToken: token,
      user: { name: u.global_name || u.username },
      resumed: cache.resumed,
    };
  }

  return {
    /** Un solo giro alla volta: chi chiama durante un giro in corso riceve la stessa promessa. */
    run(onStep) {
      if (onStep) {
        listeners.add(onStep);
        if (inflight && step) onStep(step);
      }
      if (!inflight) {
        const p = run();
        inflight = p;
        const clear = () => { if (inflight === p) inflight = null; };
        p.then(clear, clear);
      }
      const p = inflight;
      const off = () => onStep && listeners.delete(onStep);
      p.then(off, off);
      return p;
    },
    /** Abbandona un giro appeso: il prossimo run() riparte (i passi già fatti restano). */
    abandon() {
      inflight = null;
    },
    /** Token rifiutato dal server: la prossima volta si rifà l'autorizzazione. */
    forgetToken() {
      cache.token = null;
      cache.auth = null;
      if (cache.resumed) {
        // Il token salvato non va più: si torna alla via normale (dopo un ricaricamento non può
        // riuscire e finisce nel «Riapri l'Activity», ma è l'unica strada onesta).
        cache.resumed = false;
        safely(() => deps.resume?.clear());
      }
    },
    get cache() { return cache; },
    /** Passo in corso e da quando (per la diagnostica). */
    get stepInfo() { return { step, at: stepAt }; },
  };
}

/**
 * Sessione: accesso + WebSocket, ritenta da sola con attese crescenti e riprende dal passo giusto.
 *
 * onStatus(view) con view = { status, step, since, error, mode }
 *   status: 'connecting' (mai stati online) | 'offline' (riconnessione) | 'online' |
 *           'denied' (accesso negato dal server) | 'blocked' (serve Riprova) | 'fatal' |
 *           'reopen' (Discord non risponde più a questa pagina: serve chiudere e riaprire l'Activity)
 *   step: passo in corso (chiave di STEP_LABEL) o null
 *   since: da quando (now()) non si è online; error: ultimo motivo d'insuccesso
 */
export function createSession({
  flow,
  createSocket,
  onStatus,
  onMessage,
  timeouts = TIMEOUTS,
  timers = realTimers(),
  now = Date.now,
  random = Math.random,
  heartbeat = {},
  onFail = null, // (err, { attempt }) per la diagnostica: non cambia il comportamento
  onOnline = null, // () al primo benvenuto del server
}) {
  let ws = null;
  let closed = false;
  let halted = false; // denied, blocked o fatal: si riparte solo con retry()
  let everOnline = false;
  let attempt = 0;
  let gen = 0; // giro attuale: i risultati dei giri abbandonati si ignorano
  let pending = false; // accesso in corso
  let timer = null;
  let welcomeTimer = null;
  let identity = null;
  let status = 'connecting';
  let step = null;
  let since = now();
  let error = null;
  let lastNotice = null;

  const view = () => ({ status, step, since, error, mode: identity?.mode ?? null });
  const emit = (s) => {
    status = s;
    onStatus(view());
  };
  const base = () => (everOnline ? 'offline' : 'connecting');

  const rawSend = (msg) => {
    if (ws?.readyState !== 1) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };

  const hb = createHeartbeat({
    sendPing: () => rawSend({ type: 'ping', t: now() }),
    onDead: () => drop(new StepError('socket', 'nessuna risposta dal server')),
    timers,
    ...heartbeat,
  });

  function schedule() {
    timers.clearTimeout(timer);
    timer = timers.setTimeout(tryNow, backoffDelay(attempt++, { random }));
  }

  /** Qualsiasi insuccesso passa da qui: decide se ritentare, da dove, o fermarsi. */
  function fail(err) {
    if (closed) return;
    try { onFail?.(err, { attempt }); } catch { /* la diagnostica non deve rompere niente */ }
    if (status === 'online') since = now();
    error = err?.message || String(err);
    step = err?.step ?? step;
    if (err?.kind === 'fatal') {
      halted = true;
      return emit('fatal');
    }
    if (err?.kind === 'user') {
      halted = true;
      return emit('blocked');
    }
    if (err?.kind === 'reopen') {
      halted = true;
      return emit('reopen');
    }
    if (err?.reauth) {
      flow.forgetToken();
      identity = null;
    }
    emit(base());
    schedule();
  }

  function detach(sock, code, why) {
    sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
    try { sock.close(code, why); } catch { /* già chiuso */ }
  }

  /** Butta la connessione attuale e ne prepara un'altra. */
  function drop(err) {
    hb.stop();
    timers.clearTimeout(welcomeTimer);
    const old = ws;
    ws = null;
    if (old) detach(old, 4000, String(err?.message || '').slice(0, 100));
    fail(err);
  }

  async function tryNow() {
    timers.clearTimeout(timer);
    timer = null;
    if (closed || halted || ws || pending) return;
    const my = ++gen;
    if (!identity) {
      pending = true;
      let id;
      try {
        id = await flow.run((s) => {
          if (my !== gen) return;
          step = s;
          emit(base());
        });
      } catch (err) {
        if (my !== gen) return;
        pending = false;
        return fail(err);
      }
      if (my !== gen) return;
      pending = false;
      identity = id;
    }
    if (closed || halted || ws) return;
    openSocket();
  }

  function openSocket() {
    step = 'socket';
    lastNotice = null;
    emit(base());
    let sock;
    try {
      sock = createSocket();
    } catch (err) {
      return fail(new StepError('socket', `collegamento al server non riuscito (${err.message})`));
    }
    ws = sock;
    let opened = false;
    timers.clearTimeout(welcomeTimer);
    welcomeTimer = timers.setTimeout(() => {
      if (ws === sock) drop(new StepError(opened ? 'welcome' : 'socket', opened ? 'il server non ha dato il benvenuto' : 'il server non risponde', { kind: 'timeout' }));
    }, timeouts.welcome);

    sock.onopen = () => {
      opened = true;
      step = 'welcome';
      emit(base());
      rawSend({
        type: 'hello',
        guildId: identity.guildId,
        channelId: identity.channelId,
        accessToken: identity.accessToken,
        name: identity.user.name,
      });
      hb.start();
    };
    sock.onmessage = (ev) => {
      hb.alive();
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') return;
      if (msg.type === 'welcome') {
        timers.clearTimeout(welcomeTimer);
        attempt = 0;
        if (!everOnline) { try { onOnline?.(); } catch { /* niente */ } }
        everOnline = true;
        step = null;
        error = null;
        emit('online');
      } else if (msg.type === 'notice' && msg.kind === 'error' && status !== 'online') {
        lastNotice = msg.message;
      }
      onMessage(msg);
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      hb.stop();
      timers.clearTimeout(welcomeTimer);
      if (closed) return;
      if (ev?.code === CLOSE_DENIED) {
        halted = true;
        error = lastNotice || 'Accesso negato dal server';
        if (status === 'online') since = now();
        return emit('denied');
      }
      if (ev?.code === CLOSE_REAUTH) {
        return fail(new StepError('welcome', lastNotice || 'il server ha rifiutato il token: nuova autorizzazione', { reauth: true }));
      }
      const why = lastNotice || (opened ? `connessione chiusa (codice ${ev?.code ?? '?'})` : 'server non raggiungibile');
      fail(new StepError(opened ? 'welcome' : 'socket', why));
    };
  }

  // primo giro
  emit('connecting');
  tryNow();

  return {
    send: (msg) => rawSend(msg),
    /** Nuovo tentativo subito, anche abbandonando un passo appeso. */
    retry() {
      if (closed || status === 'online') return;
      const wasDenied = status === 'denied';
      halted = false;
      attempt = 0;
      since = now();
      gen++;
      pending = false;
      flow.abandon();
      if (wasDenied) {
        // Magari il problema era il token: si riparte dall'autorizzazione (silenziosa se già concessa).
        flow.forgetToken();
        identity = null;
      }
      timers.clearTimeout(timer);
      timers.clearTimeout(welcomeTimer);
      hb.stop();
      const old = ws;
      ws = null;
      if (old) detach(old, 4000, 'nuovo tentativo');
      emit(base());
      tryNow();
    },
    /** Pagina tornata visibile o rete tornata: si controlla subito invece di aspettare. */
    check() {
      if (closed || halted) return;
      if (!ws && !pending) return tryNow();
      if (ws?.readyState === 1) hb.probe();
    },
    close() {
      closed = true;
      gen++;
      timers.clearTimeout(timer);
      timers.clearTimeout(welcomeTimer);
      hb.stop();
      const old = ws;
      ws = null;
      if (old) detach(old, 1000, 'chiusa');
    },
    get view() { return view(); },
  };
}

/** Testo del badge in alto. */
export function statusLabel(view, { botOnline = false, connected = false } = {}) {
  const { status, step, mode } = view;
  if (status === 'online') {
    if (mode === 'prova') return botOnline ? 'Prova · bot online' : 'Modalità prova';
    return connected ? 'Nel canale vocale' : 'Pronto';
  }
  if (status === 'denied') return 'Accesso negato';
  if (status === 'blocked' || status === 'fatal' || status === 'reopen') return 'Non collegato';
  const base = status === 'offline' ? 'Riconnessione…' : 'Connessione…';
  const what = STEP_LABEL[step];
  return what ? `${base} (${what})` : base;
}

/** Messaggio comprensibile quando si è fermi da troppo (o serve un clic). */
export function stuckMessage(view) {
  const { status, step, error } = view;
  if (status === 'reopen') {
    return 'Discord ha ricaricato l\'Activity e non risponde più a questa pagina. Riprovare non serve: va chiusa e riaperta.';
  }
  if (status === 'blocked') return `${error || 'Serve un nuovo tentativo'}. Premi «Riprova» e accetta la richiesta di Discord.`;
  const where = {
    config: 'Il server della musica non risponde: forse si sta riavviando.',
    ready: 'Discord non sta rispondendo all\'Activity: se non si sblocca, chiudi l\'Activity e riaprila.',
    authorize: 'Discord non ha completato l\'autorizzazione: se vedi una finestra di Discord, accettala.',
    token: 'L\'accesso a Discord non è ancora riuscito.',
    authenticate: 'L\'accesso a Discord non è ancora riuscito.',
    socket: 'Il server della musica non risponde: forse si sta riavviando.',
    welcome: 'Il server della musica non completa il collegamento.',
  }[step] || 'Il collegamento non riesce.';
  return `${where} Continuo a riprovare da solo${error ? ` (ultimo errore: ${error})` : ''}.`;
}
