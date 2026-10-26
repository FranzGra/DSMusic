// Collegamento a Discord (Embedded App SDK) o modalità prova nel browser, più il WebSocket col server.
// Qui solo le parti del browser; la logica (passi, limiti di tempo, tentativi) sta in session.js.
import { DiscordSDK, RPCCloseCodes } from '@discord/embedded-app-sdk';
import { StepError, TIMEOUTS, createIdentityFlow, createSession } from './session.js';
import { buildReport, createMessageProbe, createReportGate, rescueReady } from './diag.js';

const QUERY = new URLSearchParams(window.location.search);
/** Dentro Discord l'Activity riceve sempre frame_id nella query. */
export const insideDiscord = QUERY.has('frame_id');
const FRAME_ID = QUERY.get('frame_id') || '';
const INSTANCE_ID = QUERY.get('instance_id') || '';

// ---------- memoria della pagina (sopravvive al ricaricamento dell'iframe) ----------
// sessionStorage se si può (resta finché c'è la scheda di Discord), altrimenti localStorage.
// Tutto dentro try/catch: in un iframe lo storage può mancare o lanciare.
const storage = (() => {
  for (const name of ['sessionStorage', 'localStorage']) {
    try {
      const s = window[name];
      s.setItem('dm-prova', '1');
      s.removeItem('dm-prova');
      return s;
    } catch { /* prossimo */ }
  }
  return null;
})();
const readJson = (key) => {
  try { return JSON.parse(storage?.getItem(key) || 'null'); } catch { return null; }
};
const writeJson = (key, value) => {
  try { storage?.setItem(key, JSON.stringify(value)); } catch { /* niente */ }
};
const removeKey = (key) => {
  try { storage?.removeItem(key); } catch { /* niente */ }
};

// Com'è nata questa pagina (per la diagnostica): visibilità, tipo di navigazione, stesso frame_id
// della pagina precedente di questa Activity?
const PAGE = (() => {
  let navType = null;
  try { navType = performance.getEntriesByType('navigation')[0]?.type ?? null; } catch { /* niente */ }
  let visibility = null;
  try { visibility = document.visibilityState; } catch { /* niente */ }
  const prev = insideDiscord ? readJson('dm-pagina') : null;
  const sameFrame = prev && typeof prev.frame === 'string' ? prev.frame === FRAME_ID : null;
  const msSincePrev = prev && Number.isFinite(prev.at) ? Math.max(0, Date.now() - prev.at) : null;
  if (insideDiscord) writeJson('dm-pagina', { frame: FRAME_ID, at: Date.now() });
  return { navType, visibility, sameFrame, msSincePrev };
})();

/**
 * Accesso salvato per QUESTA Activity (vedi resume in session.js): vale solo con lo stesso
 * frame_id e instance_id, così un'Activity nuova rifà sempre l'accesso con Discord.
 */
const RESUME_KEY = 'dm-accesso';
const resume = {
  load() {
    const r = readJson(RESUME_KEY);
    if (!r || r.frame !== FRAME_ID || r.inst !== INSTANCE_ID) {
      if (r) removeKey(RESUME_KEY);
      return null;
    }
    return { token: r.token, exp: r.exp, name: r.name };
  },
  save({ token, exp, name }) {
    writeJson(RESUME_KEY, { frame: FRAME_ID, inst: INSTANCE_ID, token, exp, name });
  },
  clear() {
    removeKey(RESUME_KEY);
  },
};

// ---------- diagnostica dell'aggancio a Discord ----------
// La sonda va registrata prima del DiscordSDK (vedi diag.js): conta i messaggi e ripara il READY.
let sdkRef = null;
const isParent = (ev) => ev.source === window.parent || (window.parent.opener && ev.source === window.parent.opener);
const probe = createMessageProbe({
  isParent,
  onReady: (data) => {
    // L'SDK riceve lo stesso messaggio subito dopo di noi: se non l'ha accettato, glielo si consegna.
    setTimeout(() => {
      if (rescueReady(sdkRef, data)) probe.state.rescued = true;
    }, 0);
  },
});
if (insideDiscord) window.addEventListener('message', (ev) => probe.handle(ev, Math.round(performance.now())));

/** L'SDK con la stretta di mano annotata nei tempi della diagnostica (anche quella del costruttore). */
class TracedSDK extends DiscordSDK {
  handshake() {
    try { probe.noteHandshake(performance.now()); } catch { /* niente */ }
    return super.handshake();
  }
}

/** Versione del client: il nome del file compilato contiene l'hash della build. */
const BUILD = (() => {
  try {
    return new URL(import.meta.url).pathname.split('/').pop().slice(0, 40);
  } catch {
    return null;
  }
})();

const reportGate = createReportGate();
function sendDiag(outcome, { err = null, attempt = null } = {}) {
  if (!insideDiscord) return;
  const info = flow.stepInfo;
  const step = err?.step ?? info.step;
  // Un rapporto per passo ed esito, più uno se dopo vari tentativi è ancora bloccato.
  if (!reportGate(`${outcome}:${step}:${err?.kind ?? ''}:${(attempt ?? 0) >= 4 ? "tardi" : "subito"}`)) return;
  const body = buildReport({
    env: {
      search: window.location.search,
      referrer: document.referrer,
      inIframe: window.parent !== window,
      hasOpener: Boolean(window.parent.opener),
      build: BUILD,
      navType: PAGE.navType,
      visibility: PAGE.visibility,
      sameFrame: PAGE.sameFrame,
      msSincePrev: PAGE.msSincePrev,
      sinceLoadMs: Math.round(performance.now()),
      ua: navigator.userAgent,
    },
    probe,
    sdk: sdkRef,
    outcome,
    step,
    error: err?.message,
    kind: err?.kind,
    attempt,
    handshakes: flow.cache.handshakes,
    stepMs: Math.round(Date.now() - info.at),
    resumed: flow.cache.resumed,
  });
  try {
    fetch('/api/diag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch { /* niente */ }
}

/** fetch con limite di tempo vero (la richiesta viene interrotta, non solo ignorata). */
const fetchJson = async (url, opts, ms, step) => {
  let r;
  try {
    r = await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    const scaduto = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new StepError(step, scaduto ? 'il server non risponde' : 'server non raggiungibile', { kind: scaduto ? 'timeout' : 'failed' });
  }
  let data = null;
  try {
    data = await r.json();
  } catch { /* risposta non JSON (es. pagina d'errore del proxy) */ }
  if (!r.ok) throw new StepError(step, data?.error ? `${data.error}` : `il server ha risposto ${r.status}`);
  if (!data) throw new StepError(step, 'risposta del server non valida');
  return data;
};

const onSdkReady = new Set();

// ---------- modo di visualizzazione dell'Activity (finestra in sovraimpressione) ----------
// Evento ACTIVITY_LAYOUT_MODE_UPDATE dell'SDK: layout_mode 0 = a schermo, 1 = PIP (finestrella in
// sovraimpressione), 2 = griglia della chiamata, -1 = non gestito. Ci si iscrive dopo il READY;
// se Discord rifiuta l'iscrizione resta solo la regola sulle misure della finestra (VistaRidotta.jsx).
let layoutMode = null;
const layoutListeners = new Set();
function subscribeLayoutMode(sdk) {
  try {
    sdk
      .subscribe('ACTIVITY_LAYOUT_MODE_UPDATE', (data) => {
        const m = data?.layout_mode;
        if (typeof m !== 'number') return;
        layoutMode = m;
        for (const fn of layoutListeners) fn(m);
      })
      .catch(() => {});
  } catch { /* niente */ }
}
/** Ascolta il modo di visualizzazione (0/1/2/-1, vedi sopra). Ritorna la funzione per smettere. */
export function onLayoutMode(fn) {
  layoutListeners.add(fn);
  if (layoutMode !== null) fn(layoutMode);
  return () => layoutListeners.delete(fn);
}

// Uno solo per pagina (anche con StrictMode, che in sviluppo monta due volte): l'SDK e il token
// restano tra un tentativo e l'altro.
const flow = createIdentityFlow({
  insideDiscord,
  getConfig: () => fetchJson('/api/config', {}, TIMEOUTS.config, 'config'),
  createSdk: (clientId) => {
    sdkRef = new TracedSDK(clientId);
    // READY arrivato tardi (dopo che ci si era fermati): si riparte da soli.
    const sdk = sdkRef;
    sdkRef.ready().then(() => {
      subscribeLayoutMode(sdk);
      for (const fn of onSdkReady) fn();
    }, () => {});
    return sdkRef;
  },
  resume,
  exchangeCode: (code) =>
    fetchJson(
      '/api/token',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) },
      TIMEOUTS.token,
      'token',
    ),
});

/**
 * Avvia accesso + WebSocket con riconnessione automatica. URL relativo all'host: funziona anche
 * dietro il proxy di Discord. onStatus riceve la view descritta in session.js.
 */
export function connect({ onMessage, onStatus }) {
  const session = createSession({
    flow,
    createSocket: () => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return new WebSocket(`${proto}//${window.location.host}/ws`);
    },
    onMessage,
    onStatus,
    onFail: (err, { attempt }) => sendDiag('errore', { err, attempt }),
    onOnline: () => sendDiag('ok'),
  });
  // Pagina nascosta: non si chiude né si ricollega niente (lo scaricamento dell'iframe lo decide
  // Discord, non noi). Tornata visibile: solo un controllo veloce che il collegamento ci sia.
  const onVisibility = () => document.visibilityState === 'visible' && session.check();
  const onOnline = () => session.check();
  const onLateReady = () => session.view.status === 'reopen' && session.retry();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  onSdkReady.add(onLateReady);
  return {
    send: session.send,
    retry: session.retry,
    /**
     * Chiede a Discord di chiudere l'Activity (unico rimedio quando non risponde più a questa
     * pagina): poi la si riapre dal canale vocale. Ritorna false se non si è potuto chiedere.
     */
    reopen: () => {
      resume.clear();
      try {
        if (!sdkRef) return false;
        sdkRef.close(RPCCloseCodes.CLOSE_NORMAL, 'Riapri l\'Activity');
        return true;
      } catch {
        return false;
      }
    },
    close: () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      onSdkReady.delete(onLateReady);
      session.close();
    },
  };
}

/** Le immagini esterne sono bloccate dalla CSP delle Activity: passano dal nostro server. */
export const thumbUrl = (u) => (u ? `/api/thumb?u=${encodeURIComponent(u)}` : null);
