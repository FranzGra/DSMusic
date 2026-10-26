// POST /api/diag: rapporto tecnico del client quando l'aggancio a Discord non riesce (o riesce, una
// volta). Diventa UNA riga di log "[diag] ...": solo campi noti, stringhe accorciate, mai token né code.

const MAX_LINE = 1400;

const str = (v, n = 60) => (typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').slice(0, n) : null);
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);
const bool = (v) => (v ? 's' : 'n');
const list = (v, max, n) => (Array.isArray(v) ? v.slice(0, max).map((x) => str(String(x), n)).filter(Boolean) : []);

/** Riga di log da un rapporto (oggetto qualsiasi: si prendono solo i campi conosciuti). */
export function diagLine(body, { addr = '?' } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const q = b.query && typeof b.query === 'object' ? b.query : {};
  const sdk = b.sdk && typeof b.sdk === 'object' ? b.sdk : {};
  const m = b.messaggi && typeof b.messaggi === 'object' ? b.messaggi : {};
  const parts = [
    `${str(b.esito, 10) || '?'}`,
    `passo=${str(b.passo, 20) || '-'}`,
    b.tipo ? `tipo=${str(b.tipo, 12)}` : null,
    `tentativo=${num(b.tentativo) ?? '-'}`,
    `msPasso=${num(b.msPasso) ?? '-'}`,
    `msPagina=${num(b.msDaCaricamento) ?? '-'}`,
    `sdk=${bool(sdk.creato)}/pronto=${bool(sdk.pronto)}/strette=${num(sdk.strette) ?? '-'}`,
    `msg=${num(m.totale) ?? 0}`,
    `origini=[${list(m.origini, 5, 60).join(',')}]`,
    `tipi=[${list(m.tipi, 12, 40).join(',')}]`,
    `ready=${bool(m.ready)}`,
    list(m.riparati, 6, 30).length ? `riparati=[${list(m.riparati, 6, 30).join(',')}]` : null,
    m.consegnatoAMano ? 'consegnatoAMano=s' : null,
    b.ripresa ? 'ripresa=s' : null,
    list(m.tempi, 16, 40).length ? `tempi=[${list(m.tempi, 16, 40).join(',')}]` : null,
    m.hello ? `hello="${str(m.hello, 200)}"` : null,
    `vis=${str(b.visibilita, 10) || '-'}`,
    `stessoFrame=${typeof b.stessoFrame === 'boolean' ? bool(b.stessoFrame) : '-'}`,
    num(b.msDaPagPrec) !== null ? `msDaPagPrec=${num(b.msDaPagPrec)}` : null,
    `query=frame:${bool(q.frame_id)},inst:${bool(q.instance_id)},plat:${str(q.platform, 12) || '-'},guild:${bool(q.guild_id)},shim:${bool(q.discord_shim)}`,
    `referrer=${str(b.referrer, 60) || '-'}`,
    `iframe=${bool(b.iframe)}`,
    `opener=${bool(b.opener)}`,
    `nav=${str(b.navigazione, 14) || '-'}`,
    `build=${str(b.build, 40) || '-'}`,
    `da=${str(addr, 45)}`,
    b.errore ? `errore="${str(b.errore, 160)}"` : null,
    b.ua ? `ua="${str(b.ua, 160)}"` : null,
  ].filter(Boolean);
  // Niente che somigli a un token anche se qualcuno lo infilasse in un campo di testo.
  const line = `[diag] ${parts.join(' ')}`.replace(/[A-Za-z0-9_-]{32,}/g, '…');
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line;
}

/** Limite di frequenza: al massimo `perAddr` rapporti al minuto per indirizzo e `total` in tutto. */
export function createDiagLimiter({ perAddr = 10, total = 60, windowMs = 60_000, now = Date.now } = {}) {
  let start = now();
  let count = 0;
  const byAddr = new Map();
  return (addr) => {
    const t = now();
    if (t - start >= windowMs) {
      start = t;
      count = 0;
      byAddr.clear();
    }
    const n = byAddr.get(addr) ?? 0;
    if (count >= total || n >= perAddr) return false;
    count++;
    byAddr.set(addr, n + 1);
    return true;
  };
}
