// Diagnostica leggera dell'aggancio a Discord (Embedded App SDK). Logica pura, provata con npm test:
// le parti del browser (window, fetch) arrivano da connection.js.
//
// 1) Sonda dei messaggi: conta i postMessage che arrivano alla pagina (origine, opcode, cmd/evt; mai
//    il contenuto) e ripara il READY di Discord quando lo schema dell'SDK lo scarterebbe.
// 2) Rapporto: dati tecnici senza token né code, mandati al server (POST /api/diag) se un passo fallisce.

/** Opcode del protocollo SDK ↔ Discord (come in @discord/embedded-app-sdk). */
const OPS = { 0: 'HANDSHAKE', 1: 'FRAME', 2: 'CLOSE', 3: 'HELLO' };

/** Origini da cui accettiamo il READY da riparare (il client Discord, anche ptb/canary e popout). */
export const isDiscordOrigin = (origin) => {
  try {
    const h = new URL(origin).hostname;
    return new URL(origin).protocol === 'https:' && (h === 'discord.com' || h.endsWith('.discord.com') || h === 'discordapp.com' || h.endsWith('.discordapp.com'));
  } catch {
    return false;
  }
};

/** Breve descrizione di un messaggio: "1:DISPATCH:READY", "1:AUTHORIZE", "3", "altro". */
export function describeMessage(data) {
  if (!Array.isArray(data)) return 'altro';
  const [op, body] = data;
  if (!(op in OPS)) return 'altro';
  if (op !== 1 || !body || typeof body !== 'object') return String(op);
  const cmd = typeof body.cmd === 'string' ? body.cmd.slice(0, 40) : '?';
  const evt = typeof body.evt === 'string' ? `:${body.evt.slice(0, 40)}` : '';
  return `1:${cmd}${evt}`;
}

/**
 * Riassunto NON sensibile del corpo dell'HELLO (opcode 3): chiavi e solo valori brevi e innocui.
 * Numeri e booleani si vedono; stringhe corte "da codice" (lettere, cifre, . _ - :) pure; numeri
 * lunghi (id di Discord) diventano "id"; il resto solo come tipo e lunghezza. Mai più di 200 caratteri.
 */
export function summarizeHello(body) {
  if (body === null || body === undefined) return String(body);
  if (typeof body !== 'object') return typeof body;
  if (Array.isArray(body)) return `arr${body.length}`;
  const parts = [];
  for (const k of Object.keys(body).slice(0, 10)) {
    const v = body[k];
    let s;
    if (v === null) s = 'null';
    else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
    else if (typeof v === 'string') {
      if (/^\d{6,}$/.test(v)) s = 'id';
      else if (v.length <= 20 && /^[\w.:-]*$/.test(v)) s = v;
      else s = `str${v.length}`;
    } else s = Array.isArray(v) ? `arr${v.length}` : typeof v;
    parts.push(`${String(k).slice(0, 24)}=${s}`);
  }
  return parts.join(',').slice(0, 200);
}

/** È il READY che Discord manda una volta sola dopo la stretta di mano? */
export const isReadyFrame = (data) =>
  Array.isArray(data) && data[0] === 1 && data[1]?.cmd === 'DISPATCH' && data[1]?.evt === 'READY';

/**
 * Lo schema del READY nell'SDK 2.5.0 vuole user.avatar stringa: chi non ha la foto profilo riceve
 * null e l'SDK scarta il READY, così ready() non finisce mai (issue discord/embedded-app-sdk#386).
 * Toglie i null da user e config (tutti campi facoltativi), sul posto. Ritorna i campi tolti.
 */
export function sanitizeReady(data) {
  const fixed = [];
  const payload = data?.[1]?.data;
  for (const part of ['user', 'config']) {
    const obj = payload?.[part];
    if (!obj || typeof obj !== 'object') continue;
    for (const k of Object.keys(obj)) {
      if (obj[k] === null) {
        delete obj[k];
        fixed.push(`${part}.${k}`);
      }
    }
  }
  if (payload && payload.user === null) {
    delete payload.user;
    fixed.push('user');
  }
  return fixed;
}

/**
 * Sonda: va installata PRIMA di creare il DiscordSDK, così il suo ascoltatore viene chiamato prima
 * di quello dell'SDK e la riparazione del READY arriva in tempo (stesso oggetto event.data).
 * onReady(data): chiamata (dopo la riparazione) quando arriva un READY da Discord.
 * timeline: ultimi 16 eventi "<tipo@ms" (messaggio arrivato) e ">0@ms" (stretta di mano inviata),
 * ms da quando la pagina ha cominciato a caricarsi.
 */
export function createMessageProbe({ isParent = () => true, onReady = null } = {}) {
  const state = {
    count: 0,
    origins: [], // fino a 5 origini diverse
    kinds: [], // ultimi 12 tipi
    ready: null, // { at, fixed } se è arrivato il READY
    rescued: false,
    timeline: [],
    hello: null, // riassunto del primo HELLO (opcode 3)
  };
  const mark = (entry) => {
    state.timeline.push(entry);
    if (state.timeline.length > 16) state.timeline.shift();
  };
  function handle(event, at = 0) {
    state.count++;
    const origin = String(event?.origin ?? '?').slice(0, 80);
    if (!state.origins.includes(origin) && state.origins.length < 5) state.origins.push(origin);
    const kind = describeMessage(event?.data);
    state.kinds.push(kind);
    if (state.kinds.length > 12) state.kinds.shift();
    mark(`<${kind}@${Math.round(at)}`);
    if (kind === '3' && state.hello === null) state.hello = summarizeHello(event.data[1]);
    if (isReadyFrame(event?.data) && isDiscordOrigin(origin) && isParent(event)) {
      const fixed = sanitizeReady(event.data);
      state.ready = { at, fixed };
      onReady?.(event.data[1].data);
    }
  }
  /** Stretta di mano inviata a Discord (dall'SDK). */
  const noteHandshake = (at = 0) => mark(`>0@${Math.round(at)}`);
  return { handle, noteHandshake, state };
}

/**
 * Se Discord ha mandato il READY ma l'SDK non l'ha accettato (schema), lo si consegna a mano
 * all'SDK: ready() si risolve e i comandi funzionano (la stretta di mano è comunque avvenuta).
 * Ritorna true se ha dovuto farlo.
 */
export function rescueReady(sdk, data) {
  if (!sdk || sdk.isReady || !data || typeof sdk.eventBus?.emit !== 'function') return false;
  sdk.eventBus.emit('READY', data);
  return true;
}

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return u ? 'non valido' : '';
  }
};

/**
 * Dati del rapporto (niente token, code, nomi o id di utenti/server).
 * env: { search, referrer, inIframe, hasOpener, build, navType, sinceLoadMs, ua,
 *        visibility (all'avvio), sameFrame (true/false/null: frame_id uguale alla pagina precedente),
 *        msSincePrev (ms dalla pagina precedente di questa Activity) }
 * resumed: accesso ripreso col token salvato (senza READY).
 */
export function buildReport({ env, probe, sdk, outcome, step, error, kind, attempt, handshakes, stepMs, resumed }) {
  const q = new URLSearchParams(env.search || '');
  return {
    v: 1,
    esito: outcome, // 'ok' | 'errore'
    passo: step || null,
    tipo: kind || null,
    errore: error ? String(error).slice(0, 160) : null,
    tentativo: attempt ?? null,
    msPasso: stepMs ?? null,
    msDaCaricamento: env.sinceLoadMs ?? null,
    query: {
      frame_id: q.has('frame_id'),
      instance_id: q.has('instance_id'),
      platform: (q.get('platform') || '').slice(0, 12) || null,
      guild_id: q.has('guild_id'),
      channel_id: q.has('channel_id'),
      discord_shim: q.has('discord_shim'),
    },
    referrer: originOf(env.referrer) || null,
    iframe: Boolean(env.inIframe),
    opener: Boolean(env.hasOpener),
    navigazione: env.navType || null, // 'navigate' | 'reload' | 'back_forward'
    visibilita: env.visibility || null, // 'visible' | 'hidden' all'avvio della pagina
    stessoFrame: typeof env.sameFrame === 'boolean' ? env.sameFrame : null,
    msDaPagPrec: env.msSincePrev ?? null,
    ripresa: Boolean(resumed),
    build: env.build || null,
    ua: env.ua ? String(env.ua).slice(0, 160) : null,
    sdk: {
      creato: Boolean(sdk),
      pronto: Boolean(sdk?.isReady),
      strette: handshakes ?? null,
    },
    messaggi: {
      totale: probe?.state.count ?? 0,
      origini: probe?.state.origins ?? [],
      tipi: probe?.state.kinds ?? [],
      ready: Boolean(probe?.state.ready),
      riparati: probe?.state.ready?.fixed ?? [],
      consegnatoAMano: Boolean(probe?.state.rescued),
      tempi: probe?.state.timeline ?? [],
      hello: probe?.state.hello ?? null,
    },
  };
}

/** Quali rapporti mandare: al massimo `max` per pagina, uno per ogni coppia passo/esito. */
export function createReportGate({ max = 6 } = {}) {
  const seen = new Set();
  let sent = 0;
  return (key) => {
    if (sent >= max || seen.has(key)) return false;
    seen.add(key);
    sent++;
    return true;
  };
}
