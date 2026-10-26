// Chi si collega all'Activity: verifica dell'access token Discord e dell'appartenenza al server.
// Con timeout (5 s) e cache (10 min), e distinguendo gli errori temporanei (429, rete, timeout:
// il client ritenta) da quelli definitivi (token non valido, non membro: il client si ferma).
import { createHash } from 'node:crypto';

/** Codici di chiusura del WebSocket condivisi con il client (client/src/reconnect.js). */
export const CLOSE_DENIED = 4001; // accesso negato: inutile ritentare
export const CLOSE_RETRY = 4002; // verifica non riuscita per ora: ritentare più tardi
export const CLOSE_REAUTH = 4003; // token mancante o rifiutato: il client rifà l'autorizzazione e ritenta

export class AuthError extends Error {
  constructor(message, { temporary = false, reauth = false } = {}) {
    super(message);
    this.temporary = temporary;
    this.reauth = reauth; // colpa del token: con un token nuovo può andare
  }
}

// Codici d'errore di Discord che vogliono dire "no, definitivo"
const DEFINITIVI = new Set([
  10004, // Unknown Guild: il bot non è in quel server
  10007, // Unknown Member: l'utente non è membro
  10013, // Unknown User
  50001, // Missing Access
]);

/** Promessa con limite di tempo: allo scadere rifiuta con un errore temporaneo. */
export function withTimeout(promise, ms, what) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new AuthError(`${what}: Discord non risponde, riprovo`, { temporary: true })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/**
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   fetchMember?: ((guildId: string, userId: string) => Promise<unknown>) | null,
 *   ttlMs?: number, timeoutMs?: number, now?: () => number,
 * }} opts fetchMember: restituisce il membro (o null) oppure lancia l'errore di discord.js.
 */
export function createAuth({ fetchImpl = fetch, fetchMember = null, ttlMs = 10 * 60_000, timeoutMs = 5000, now = Date.now } = {}) {
  const users = new Map(); // hash del token -> { user, exp }
  const members = new Map(); // guildId:userId -> exp
  const hash = (token) => createHash('sha256').update(token).digest('hex');
  const pulisci = (map) => {
    if (map.size < 500) return;
    const t = now();
    for (const [k, v] of map) if ((v.exp ?? v) <= t) map.delete(k);
  };

  async function whoIs(accessToken) {
    if (!accessToken) throw new AuthError('token mancante', { reauth: true });
    const key = hash(accessToken);
    const hit = users.get(key);
    if (hit && hit.exp > now()) return hit.user;

    let r;
    try {
      r = await fetchImpl('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const scaduto = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new AuthError(scaduto ? 'Discord non risponde, riprovo' : `rete non disponibile (${err.message}), riprovo`, { temporary: true });
    }
    if (r.status === 401 || r.status === 403) throw new AuthError('token non valido o scaduto', { reauth: true });
    if (r.status === 429 || r.status >= 500) throw new AuthError(`Discord occupato (${r.status}), riprovo`, { temporary: true });
    if (!r.ok) throw new AuthError(`verifica non riuscita (${r.status})`);
    const u = await r.json();
    const user = { id: u.id, name: u.global_name || u.username };
    pulisci(users);
    users.set(key, { user, exp: now() + ttlMs });
    return user;
  }

  async function checkMember(guildId, userId) {
    if (!fetchMember) return;
    const key = `${guildId}:${userId}`;
    if ((members.get(key) ?? 0) > now()) return;
    let member;
    try {
      member = await withTimeout(Promise.resolve().then(() => fetchMember(guildId, userId)), timeoutMs, 'controllo del membro');
    } catch (err) {
      if (err instanceof AuthError) throw err;
      if (DEFINITIVI.has(err?.code)) member = null;
      else throw new AuthError(`controllo del membro non riuscito (${err?.status || err?.code || err?.message}), riprovo`, { temporary: true });
    }
    if (!member) throw new AuthError('non sei membro di questo server o il bot non è stato invitato');
    pulisci(members);
    members.set(key, now() + ttlMs);
  }

  /** Verifica completa: restituisce { id, name } o lancia AuthError. */
  async function verify({ accessToken, guildId }) {
    const user = await whoIs(accessToken);
    if (guildId) await checkMember(guildId, user.id);
    return user;
  }

  return { verify, whoIs, checkMember };
}
