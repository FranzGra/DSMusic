// Stato del canale vocale (il testo sotto il nome del canale nella lista di Discord): il titolo del
// brano in riproduzione, come fanno altri bot musicali. API: PUT /channels/{id}/voice-status con
// { status } (Routes.channelVoiceStatus in discord-api-types), permesso «Imposta stato del canale
// vocale» (SetVoiceChannelStatus). discord.js 14 non ha un metodo né espone lo stato del canale:
// lo stato degli altri si impara dagli eventi grezzi del gateway (VOICE_CHANNEL_STATUS_UPDATE).

export const STATO_MAX = 120; // caratteri mostrati (Discord ne accetta fino a 500)
export const STATO_ATTESA_MS = 1500; // cambi ravvicinati (più salti di fila) diventano una sola richiesta

/** Testo dello stato per un brano: solo il titolo, su una riga, tagliato a `max` caratteri con «…». */
export function testoStato(track, max = STATO_MAX) {
  if (!track) return '';
  const pulisci = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const titolo = pulisci(track.title) || 'Brano senza titolo';
  const testo = titolo;
  const caratteri = Array.from(testo); // emoji e accenti nel titolo contano come un carattere, senza spezzarli
  return caratteri.length <= max ? testo : `${caratteri.slice(0, max - 1).join('').trimEnd()}…`;
}

/** Codice d'errore Discord (50013 permesso mancante, 10003 canale sconosciuto) o stato HTTP. */
const codiceErrore = (err) => err?.code ?? err?.status ?? err?.name ?? 'sconosciuto';

export class StatoCanale {
  /**
   * @param {object} o
   * @param {(channelId: string, status: string) => Promise<unknown>} o.imposta  PUT voice-status
   * @param {boolean} [o.attivo]  false = nessuna richiesta (STATO_CANALE=0)
   * @param {number} [o.attesaMs]  ritardo per raggruppare i cambi rapidi
   */
  constructor({ imposta, attivo = true, attesaMs = STATO_ATTESA_MS, log = console } = {}) {
    this.imposta = imposta;
    this.attivo = Boolean(attivo && imposta);
    this.attesaMs = attesaMs;
    this.log = log;
    this.noti = new Map(); // channelId -> ultimo stato visto da Discord (eventi del gateway)
    // channelId -> { precedente, inviato, inviati }: canali dove lo stato l'ha messo il bot.
    // `inviati`: tutti i testi mandati, per riconoscere l'eco dei propri cambi (anche se arriva in ritardo).
    this.miei = new Map();
    this.vecchi = new Map(); // channelId -> testi mandati prima dell'ultimo ripristino (echi in ritardo)
    this.catena = new Map(); // guildId -> Promise: le richieste di un server una dopo l'altra
    this.voluti = new Map(); // guildId -> { channelId, testo } desiderato (applicato dopo l'attesa)
    this.timer = new Map(); // guildId -> timer dell'attesa
    this.canaleDi = new Map(); // guildId -> canale dove il bot ha messo lo stato
    this.senzaPermesso = new Set(); // channelId dove Discord ha risposto 50013: niente altri tentativi
    this.segnalati = new Set(); // errori già scritti nel log (una riga sola per tipo e canale)
  }

  /** Stato di un canale visto dal gateway (anche quello messo a mano da qualcuno). */
  ricorda(channelId, status) {
    if (!channelId) return;
    const s = status ?? '';
    const mio = this.miei.get(channelId);
    if (mio && !mio.inviati.has(s)) mio.precedente = s; // cambiato da qualcun altro mentre suoniamo
    if (!mio && !this.vecchi.get(channelId)?.has(s)) this.noti.set(channelId, s);
  }

  /**
   * Da chiamare a ogni cambio della musica. `channelId`: canale vocale in cui è il bot (null se fuori).
   * `track`: brano in corso (null = niente). In pausa il titolo resta: il brano è ancora quello.
   */
  aggiorna(guildId, { channelId = null, track = null } = {}) {
    if (!this.attivo) return;
    const testo = channelId && track ? testoStato(track) : '';
    this.voluti.set(guildId, { channelId: testo ? channelId : null, testo });
    if (this.timer.has(guildId)) return;
    const t = setTimeout(() => {
      this.timer.delete(guildId);
      void this.inFila(guildId, () => this.applica(guildId));
    }, this.attesaMs);
    t.unref?.();
    this.timer.set(guildId, t);
  }

  /** Esegue `fn` dopo le richieste già partite per lo stesso server (mai due insieme). */
  inFila(guildId, fn) {
    const p = (this.catena.get(guildId) ?? Promise.resolve()).then(fn).catch(() => {});
    this.catena.set(guildId, p);
    p.then(() => {
      if (this.catena.get(guildId) === p) this.catena.delete(guildId);
    });
    return p;
  }

  /** Applica subito lo stato voluto di un server (usata dal timer). */
  async applica(guildId) {
    const voluto = this.voluti.get(guildId) ?? { channelId: null, testo: '' };
    const prima = this.canaleDi.get(guildId) ?? null;
    // Bot spostato o uscito: il canale lasciato torna com'era.
    if (prima && prima !== voluto.channelId) await this.ripristina(guildId);
    if (!voluto.channelId || !voluto.testo) return;
    const ch = voluto.channelId;
    if (this.senzaPermesso.has(ch)) return;
    const mio = this.miei.get(ch);
    if (mio?.inviato === voluto.testo) return; // già così: nessuna richiesta
    const registro = mio ?? { precedente: this.noti.get(ch) ?? '', inviato: null, inviati: this.vecchi.get(ch) ?? new Set() };
    this.vecchi.delete(ch);
    this.miei.set(ch, registro);
    this.canaleDi.set(guildId, ch);
    registro.inviati.add(voluto.testo); // prima della richiesta: l'eco del gateway può arrivare subito
    if (registro.inviati.size > 50) registro.inviati.delete(registro.inviati.values().next().value);
    if (await this.invia(ch, voluto.testo)) registro.inviato = voluto.testo;
  }

  /** Rimette lo stato che c'era prima del bot (o lo svuota se non era noto) nel canale del server. */
  async ripristina(guildId) {
    const ch = this.canaleDi.get(guildId);
    if (!ch) return;
    this.canaleDi.delete(guildId);
    const mio = this.miei.get(ch);
    this.miei.delete(ch);
    if (mio) this.vecchi.set(ch, mio.inviati);
    const permessoMancante = this.senzaPermesso.delete(ch);
    if (!mio || mio.inviato === null || permessoMancante) return; // il bot non aveva cambiato niente
    const precedente = mio.precedente ?? '';
    this.noti.set(ch, precedente);
    await this.invia(ch, precedente);
  }

  /** Alla chiusura del processo: annulla le attese e ripristina tutti i canali. */
  async ripristinaTutti() {
    for (const t of this.timer.values()) clearTimeout(t);
    this.timer.clear();
    this.voluti.clear();
    await Promise.all([...this.canaleDi.keys()].map((g) => this.inFila(g, () => this.ripristina(g))));
  }

  /** Una richiesta a Discord. Errori: una riga di log per tipo e canale, la musica continua. */
  async invia(channelId, status) {
    try {
      await this.imposta(channelId, status);
      return true;
    } catch (err) {
      const codice = codiceErrore(err);
      if (codice === 50013) this.senzaPermesso.add(channelId);
      const chiave = `${channelId}:${codice}`;
      if (!this.segnalati.has(chiave)) {
        this.segnalati.add(chiave);
        const motivo = codice === 50013
          ? 'manca il permesso «Imposta stato del canale vocale»'
          : codice === 10003 ? 'canale non più esistente' : err?.message || 'errore';
        this.log.warn?.(`[stato canale] Non riesco a impostare lo stato del canale ${channelId}: ${motivo} (${codice})`);
      }
      return false;
    }
  }
}
