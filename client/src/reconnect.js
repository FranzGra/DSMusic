// Logica pura (senza browser) della riconnessione: attese crescenti e battito dell'applicazione.
// Separata da connection.js così si prova con i test del server (npm test).

/** Codici di chiusura del WebSocket scelti dal server (server/src/auth.js). */
export const CLOSE_DENIED = 4001; // accesso negato: non ritentare da soli
export const CLOSE_RETRY = 4002; // verifica non riuscita per ora: ritentare
export const CLOSE_REAUTH = 4003; // token rifiutato: rifare l'autorizzazione con Discord e ritentare

/**
 * Attesa prima del tentativo numero `attempt` (0, 1, 2…): raddoppia da `base` fino a `max`,
 * con una parte casuale (tra metà e il valore pieno) perché tanti client non ritentino insieme.
 */
export function backoffDelay(attempt, { base = 500, max = 15_000, random = Math.random } = {}) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  const cap = Math.min(max, base * 2 ** Math.min(n, 30));
  return Math.round(cap / 2 + random() * (cap / 2));
}

/**
 * Battito: ogni `intervalMs` manda un ping; se `maxMissed` ping di fila restano senza risposta
 * chiama onDead (la connessione è morta anche se il browser non se n'è accorto).
 * probe(): controllo immediato (es. quando la pagina torna visibile), con `probeMs` per rispondere.
 */
export function createHeartbeat({
  sendPing,
  onDead,
  intervalMs = 20_000,
  maxMissed = 2,
  probeMs = 5_000,
  timers = { setInterval, clearInterval, setTimeout, clearTimeout },
}) {
  let missed = 0;
  let interval = null;
  let probe = null;
  let dead = false;

  const die = () => {
    if (dead) return;
    dead = true;
    stop();
    onDead();
  };
  const tick = () => {
    if (missed >= maxMissed) return die();
    missed++;
    sendPing();
  };
  function stop() {
    if (interval) timers.clearInterval(interval);
    if (probe) timers.clearTimeout(probe);
    interval = null;
    probe = null;
  }

  return {
    start() {
      stop();
      dead = false;
      missed = 0;
      interval = timers.setInterval(tick, intervalMs);
    },
    stop,
    /** Qualsiasi messaggio dal server vale come risposta. */
    alive() {
      missed = 0;
      if (probe) timers.clearTimeout(probe);
      probe = null;
    },
    probe() {
      if (dead || !interval || probe) return;
      sendPing();
      probe = timers.setTimeout(die, probeMs);
    },
    get missed() { return missed; },
  };
}
