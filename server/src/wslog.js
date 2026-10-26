// Righe di log brevi per WebSocket e /api/token: una riga per evento, mai token né code.

/** Durata leggibile: 850 ms, 4,2 s, 3m12s, 1h05m. */
export function formatDuration(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  if (n < 1000) return `${n} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1).replace('.', ',')} s`;
  const s = Math.floor(n / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

const CLOSE_NAMES = {
  1000: 'normale',
  1001: 'pagina chiusa',
  1005: 'senza codice',
  1006: 'interrotta',
  4000: 'chiusa dal client',
  4001: 'accesso negato',
  4002: 'riprova',
  4003: 'token rifiutato',
};

/** Riga per la chiusura di una connessione WebSocket. */
export function closeLine({ id, code, startedAt, now = Date.now(), user = null, guildId = null }) {
  const name = CLOSE_NAMES[code] ? ` ${CLOSE_NAMES[code]}` : '';
  const who = user ? `${user.name} (${guildId ?? '?'})` : 'senza presentarsi';
  return `[ws] #${id} chiusa ${code ?? '?'}${name} dopo ${formatDuration(now - startedAt)}, ${who}`;
}

/** Indirizzo del client dietro il proxy (solo per riconoscere le connessioni nei log). */
export function clientAddr(req) {
  const fwd = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req?.socket?.remoteAddress || '?';
}
