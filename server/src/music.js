// Stato della musica di ogni server Discord (guild): coda, brano attuale, pausa, volume, loop.
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
} from '@discordjs/voice';
import { randomUUID } from 'node:crypto';
import { createOpusStream, createOpusStreamAt, erroreAudio, urlScaduto } from './audio.js';
import { ensurePlayable, getStream, haPlaylist, resolveInput, videoIdDaLink } from './resolver.js';
import { SoundPlayer } from './soundbar.js';

const SIM_DURATA_DEFAULT = 180; // secondi, solo per la modalità senza bot
const LOOP_MODES = ['off', 'track', 'queue'];
const CONTROLLO_BLOCCO_MS = 5000; // ogni quanto si controlla che l'audio scorra
export const STORICO_MAX = 5; // brani in «Ascoltati di recente»
const PRECEDENTE_RIPARTI_S = 5; // oltre questi secondi «indietro» fa ricominciare il brano attuale
const ATTESA_DIRETTO_MS = 6_000; // via veloce: ffmpeg deve dare il primo audio entro questo tempo (di solito 0,1-0,3 s)
const ATTESA_RAM_MS = 8_000; // ripiego veloce dopo un 403: download in RAM a blocchi Range (di solito 0,3 s)
const ATTESA_RIPIEGO_MS = 45_000; // ripiego yt-dlp | ffmpeg: più lento
const URL_IN_CACHE_MAX = 20;
const PROSSIMI_IN_RAM = 2; // brani successivi preparati in anticipo (link e audio in RAM)

/** Copia di un brano con un id nuovo (lo stesso brano può stare in coda e nello storico). */
const copia = (t) => ({ ...t, id: randomUUID() });

/** Si può andare a un punto del brano solo se ha una durata e non è una diretta. */
export const spostabile = (t) => Boolean(t && !t.live && Number.isFinite(t.duration) && t.duration > 1);

/** Un brano salvato su disco è usabile se ha almeno titolo e link. */
const branoValido = (t) => Boolean(t && typeof t === 'object' && typeof t.title === 'string' && typeof t.url === 'string' && t.url);

/** Dove va un brano aggiunto: 'fine' (in fondo), 'prossimo' (subito dopo quello in corso) o 'ora' (parte subito). */
export const posizioneValida = (p) => (p === 'prossimo' || p === 'ora' ? p : 'fine');

/** Testo dell'avviso dopo un'aggiunta. */
export function messaggioAggiunta({ tracks, posizione, subito, playlistTitle = null, altri = false }) {
  const t = tracks[0];
  if (tracks.length > 1) {
    const da = playlistTitle ? ` da «${playlistTitle}»` : '';
    return posizione === 'prossimo' && !subito ? `Riproduce dopo: ${tracks.length} brani${da}` : `Aggiunti ${tracks.length} brani${da}`;
  }
  const resto = altri ? ' (carico il resto della playlist…)' : '';
  if (subito) return `In riproduzione: ${t.title}${resto}`;
  return posizione === 'prossimo' ? `Riproduce dopo: ${t.title}${resto}` : `Aggiunto in coda: ${t.title}${resto}`;
}

export class GuildMusic {
  constructor(guildId, { bot, onChange, onNotice, onPersist = null, onMembers = null, emptySeconds = 60, idleMinutes = 5, stallSeconds = 30, cache = null, onAttivita = null }) {
    this.guildId = guildId;
    this.onMembers = onMembers; // (guildId, members) => void: solo «chi parla» cambiato (messaggio leggero)
    this.ultimiMembri = null; // JSON dell'ultimo elenco mandato ai client (evita invii uguali)
    // Uscita automatica (0 = disattivata)
    this.emptyMs = Math.max(0, emptySeconds) * 1000;
    this.idleMs = Math.max(0, idleMinutes) * 60_000;
    this.bot = bot; // null se il bot non è collegato (modalità prova)
    this.onChange = onChange;
    this.onNotice = onNotice;
    this.onPersist = onPersist; // (guildId, dati) => void: salva coda, volume e loop su disco
    // Audio fermo (yt-dlp o ffmpeg bloccati) per più di così: si chiude e si passa al brano dopo
    this.stallMs = Math.max(1, stallSeconds) * 1000;
    this.stallTimer = null;

    this.channelId = null; // canale vocale
    this.queue = [];
    // Id dei brani messi con «Riproduci dopo»: stanno in testa alla coda, nell'ordine in cui sono
    // stati aggiunti. Il prossimo «Riproduci dopo» va subito dopo l'ultimo di questi.
    this.prossimi = new Set();
    this.current = null;
    this.paused = false;
    this.loading = false;
    this.volume = 60;
    this.loop = 'off';
    this.history = []; // ultimi brani ascoltati, il più recente per primo (max STORICO_MAX)

    // Spostamento nel brano (seek)
    this.pendingSeek = false; // spostato mentre era in pausa: l'audio riparte da pausedPos alla ripresa
    this.streamCache = new Map(); // link del brano → { url, headers, exp, direct }: stream diretto, scade
    this.resolving = new Map(); // link del brano → promessa di getStream in corso (niente doppioni)
    this.stopGen = 0; // cresce a ogni stop: le playlist che arrivano dopo non riempiono la coda
    // yt-dlp e ffmpeg passano da qui: nei test si sostituiscono con versioni finte
    this.lib = { getStream, resolveInput, createOpusStream, createOpusStreamAt };
    this.cache = cache; // AudioCache (audiocache.js) condivisa tra i server, oppure null
    this.onAttivita = onAttivita; // () => void: il gestore controlla se il bot è a riposo

    // Orologio della posizione
    this.startedAt = 0; // ms
    this.pausedPos = 0; // secondi

    this.playId = 0;
    this.simTimer = null;
    this.audio = null; // { kill }
    this.resource = null;
    this.player = null;

    // Presenza nel canale vocale
    this.humans = null; // utenti (non bot) nel canale del bot; null = non so
    this.autoPaused = false; // pausa messa dal bot perché il canale è vuoto
    this.away = false; // il bot è uscito ma la coda resta: play lo fa rientrare
    this.leftOnPurpose = false; // l'uscita l'ha decisa il bot (non è uno scollegamento a mano)
    this.emptyTimer = null;
    this.idleTimer = null;
    this.leaveAt = 0; // ms
    this.leaveReason = null; // 'empty' | 'idle'

    // Soundbar: secondo player per i suoni brevi (soundbar.js)
    this.suoni = new SoundPlayer(this);
  }

  /** Sta suonando un suono della Soundbar? */
  suonoAttivo() {
    return Boolean(this.suoni?.attivo);
  }

  /** Suona un suono della Soundbar (vedi SoundPlayer.suona). */
  suona(suono, opzioni) {
    return this.suoni.suona(suono, opzioni);
  }

  // ---------- stato verso i client ----------
  position() {
    if (!this.current) return 0;
    if (this.paused || this.loading || this.suonoAttivo()) return this.pausedPos;
    return (Date.now() - this.startedAt) / 1000;
  }

  /**
   * Persone nel canale vocale (del bot, o quello di riferimento se il bot è fuori).
   * null solo senza bot (modalità prova): l'elenco non si può sapere.
   */
  members() {
    if (typeof this.bot?.members !== 'function') return null;
    return this.bot.members(this.guildId, this.channelId);
  }

  /**
   * Il bot segnala un cambio (già accorpato, vedi Bot.segnalaMembri). Se l'elenco è uguale a
   * quello già mandato non succede niente. voce=true (entrate, uscite, muto): stato completo;
   * altrimenti solo il messaggio leggero `members` (chi parla cambia spesso).
   */
  membersChanged({ voce = false } = {}) {
    const m = this.members();
    const key = JSON.stringify(m);
    if (key === this.ultimiMembri) return;
    if (voce || !this.onMembers) {
      this.onChange(this.guildId, this.snapshot());
    } else {
      this.ultimiMembri = key;
      this.onMembers(this.guildId, m);
    }
  }

  snapshot() {
    const members = this.members();
    this.ultimiMembri = JSON.stringify(members);
    return {
      members,
      guildId: this.guildId,
      channelId: this.channelId,
      channelName: this.bot?.nomeCanale?.(this.guildId, this.channelId) ?? null,
      botOnline: Boolean(this.bot?.ready),
      connected: Boolean(this.bot?.isConnected(this.guildId)),
      inVoice: this.inVoice(),
      current: this.current,
      queue: this.queue,
      history: this.history,
      paused: this.paused,
      loading: this.loading,
      position: Math.max(0, this.position()),
      serverTime: Date.now(),
      volume: this.volume,
      loop: this.loop,
      away: this.away,
      autoPaused: this.autoPaused,
      leaveReason: this.leaveReason,
      leaveIn: this.leaveReason ? Math.max(0, (this.leaveAt - Date.now()) / 1000) : null,
      suono: this.suoni?.stato() ?? null, // { id, name, by, inizio, fine (ms epoch), duration (s) } del suono in corso
    };
  }

  changed() {
    this.checkIdle();
    this.cache?.proteggi(this.guildId, this.braniDaTenere()); // il resto esce dalla cache
    this.onAttivita?.();
    this.onChange(this.guildId, this.snapshot());
    this.onPersist?.(this.guildId, this.persistData());
  }

  // ---------- salvataggio su disco ----------
  /** Quello che serve per ritrovare la coda dopo un riavvio. */
  persistData() {
    return {
      v: 1,
      channelId: this.channelId,
      current: this.current,
      queue: this.queue,
      history: this.history,
      volume: this.volume,
      loop: this.loop,
    };
  }

  /**
   * Ricarica una coda salvata. Il bot non rientra da solo nel canale: il brano che suonava torna
   * in cima alla coda e play la fa ripartire (come quando il bot esce da un canale vuoto).
   */
  restore(data) {
    if (!data || typeof data !== 'object') return;
    const queue = [data.current, ...(Array.isArray(data.queue) ? data.queue : [])].filter(branoValido);
    this.queue = queue;
    this.history = (Array.isArray(data.history) ? data.history : []).filter(branoValido).slice(0, STORICO_MAX);
    this.current = null;
    this.paused = false;
    this.loading = false;
    this.pausedPos = 0;
    this.away = queue.length > 0;
    if (Number.isFinite(data.volume)) this.volume = Math.max(0, Math.min(100, Math.round(data.volume)));
    if (LOOP_MODES.includes(data.loop)) this.loop = data.loop;
    if (typeof data.channelId === 'string' && data.channelId) this.channelId = data.channelId;
  }

  /**
   * Canale vocale scelto da chi usa la GUI o i comandi. Se il bot è già in un canale resta lì:
   * il canale cambia solo quando il bot è fuori (o quando Discord lo sposta, vedi botVoiceChanged).
   */
  setChannel(channelId) {
    if (channelId && !this.inVoice()) this.channelId = channelId;
  }

  /**
   * Sposta il bot in un altro canale (solo su richiesta esplicita, es. dalla chat quando il suo
   * canale è vuoto). Se è già collegato, la stessa connessione cambia canale e l'audio continua.
   */
  async moveTo(channelId) {
    if (!channelId || channelId === this.channelId && this.inVoice()) return;
    this.channelId = channelId;
    if (this.inVoice() && this.bot?.join) await this.bot.join(this.guildId, channelId);
    this.changed();
  }

  // ---------- libreria di playlist ----------
  /** I brani da salvare come playlist: quello in corso (se c'è) e poi la coda. */
  braniPerPlaylist() {
    return [this.current, ...this.queue].filter(Boolean);
  }

  /**
   * Carica i brani di una playlist: 'append' in fondo alla coda, 'replace' al posto della coda
   * (il brano in corso continua). Se non suona niente parte il primo. Restituisce quanti brani.
   */
  loadPlaylist(tracks, { mode = 'append', channelId, user = null } = {}) {
    const nuovi = (Array.isArray(tracks) ? tracks : [])
      .filter((t) => t && typeof t.title === 'string' && (t.url || t.query))
      .map((t) => ({ ...t, id: randomUUID(), requestedBy: user }));
    if (!nuovi.length) return 0;
    this.setChannel(channelId);
    if (mode === 'replace') {
      this.queue = [];
      this.prossimi.clear();
    }
    this.inserisci(nuovi, 'fine');
    return nuovi.length;
  }

  // ---------- azioni ----------
  async add(input, { channelId, user, posizione = 'fine' } = {}) {
    posizione = posizioneValida(posizione);
    this.setChannel(channelId);
    const veloce = await this.addYoutubeLink(input, user || null, posizione);
    if (veloce) return veloce;
    const { tracks, playlistTitle } = await this.lib.resolveInput(input, user || null);
    const subito = this.inserisci(tracks, posizione);
    return { tracks, count: tracks.length, posizione, subito, message: messaggioAggiunta({ tracks, posizione, subito, playlistTitle }) };
  }

  /** Indice in coda dove va un brano «prossimo»: dopo quelli già messi come prossimi. */
  indiceProssimo() {
    let i = 0;
    while (i < this.queue.length && this.prossimi.has(this.queue[i].id)) i++;
    return i;
  }

  /** Toglie dall'elenco dei «prossimi» i brani che non sono più in coda. */
  pulisciProssimi() {
    if (!this.prossimi.size) return;
    const inCoda = new Set(this.queue.map((t) => t.id));
    for (const id of this.prossimi) if (!inCoda.has(id)) this.prossimi.delete(id);
  }

  /**
   * Mette dei brani in coda: in fondo ('fine') o come prossimi ('prossimo', dopo gli altri prossimi;
   * `at` forza l'indice). Se non sta suonando niente, parte subito il primo della coda: con
   * 'prossimo' i brani vanno in testa, quindi parte il primo di loro. Con 'ora' vanno in testa e il
   * primo parte subito, interrompendo quello in corso (come «salta»).
   * Restituisce true se il primo brano aggiunto è partito subito.
   */
  inserisci(tracks, posizione = 'fine', at = null) {
    if (!tracks.length) return false;
    if (posizione === 'ora') {
      this.pulisciProssimi();
      this.queue.splice(0, 0, ...tracks);
      for (const t of tracks.slice(1)) this.prossimi.add(t.id);
      void this.playNext({ fromEnd: false, skipped: true });
      return true;
    }
    const fermo = !this.current && !this.loading;
    if (posizione === 'prossimo') {
      this.pulisciProssimi();
      const i = Math.max(0, Math.min(this.queue.length, at ?? (fermo ? 0 : this.indiceProssimo())));
      this.queue.splice(i, 0, ...tracks);
      for (const t of tracks) this.prossimi.add(t.id);
    } else {
      this.queue.push(...tracks);
    }
    if (fermo) {
      void this.playNext({ fromEnd: false });
      return this.current === tracks[0];
    }
    this.changed();
    return false;
  }

  /**
   * Link YouTube con un video: una sola chiamata a yt-dlp dà titolo e stream (che resta in cache),
   * così il brano parte subito. Se c'è anche una playlist (list=), il resto si carica dopo, senza
   * bloccare la partenza. Restituisce null se il link non è di questo tipo o la via veloce fallisce.
   */
  async addYoutubeLink(input, user, posizione = 'fine') {
    const vid = videoIdDaLink(input);
    if (!vid) return null;
    const conLista = haPlaylist(input);
    const gen = this.stopGen;
    const resto = conLista ? this.lib.resolveInput(input, user) : null;
    resto?.catch(() => {}); // gestito sotto
    let s;
    try {
      s = await this.lib.getStream(`https://www.youtube.com/watch?v=${vid}`, user);
    } catch (err) {
      if (conLista) return null; // si riprova con l'espansione completa
      throw err;
    }
    const track = s.track;
    this.cacheStream(track.url, s);
    const subito = this.inserisci([track], posizione);

    if (resto) {
      resto.then(({ tracks, playlistTitle }) => {
        if (gen !== this.stopGen) return; // nel frattempo è stato premuto stop
        const altri = tracks.filter((t) => videoIdDaLink(t.url) !== vid);
        if (!altri.length) return;
        if (posizione !== 'fine') {
          // Subito dopo il primo brano della playlist e nel suo ordine: anche se nel frattempo
          // è arrivato un altro «prossimo», la playlist resta unita.
          const i = this.queue.findIndex((t) => t.id === track.id);
          const at = i >= 0 ? i + 1 : this.current?.id === track.id ? 0 : null;
          this.inserisci(altri, 'prossimo', at);
        } else {
          this.inserisci(altri, 'fine');
        }
        const dove = posizione !== 'fine' ? ' come prossimi' : '';
        this.onNotice(this.guildId, { kind: 'info', message: `Aggiunti altri ${altri.length} brani${dove}${playlistTitle ? ` da «${playlistTitle}»` : ' dalla playlist'}` });
        void this.prefetch();
      }).catch((err) => {
        if (gen !== this.stopGen) return;
        this.onNotice(this.guildId, { kind: 'error', message: `Non riesco a leggere il resto della playlist: ${err.message}` });
      });
    }
    return {
      tracks: [track],
      count: 1,
      posizione,
      subito,
      message: messaggioAggiunta({ tracks: [track], posizione, subito, altri: Boolean(resto) }),
    };
  }

  /**
   * Aggiunge un brano già risolto (es. da un risultato di ricerca): con now=true parte subito,
   * altrimenti va in fondo ('fine') o subito dopo quello in corso ('prossimo').
   * Restituisce true se è partito subito.
   */
  addTrack(track, { channelId, now = false, posizione = 'fine' } = {}) {
    this.setChannel(channelId);
    if (now) {
      this.queue.unshift(track);
      void this.playNext({ fromEnd: false, skipped: true });
      return true;
    }
    return this.inserisci([track], posizioneValida(posizione));
  }

  /**
   * Fa partire subito un brano della coda: esce dalla coda e diventa quello in riproduzione.
   * Il brano interrotto si comporta come con "salta" (con ripeti coda va in fondo).
   */
  playNow(trackId) {
    const i = this.queue.findIndex((t) => t.id === trackId);
    if (i < 0) return;
    const [t] = this.queue.splice(i, 1);
    this.queue.unshift(t);
    void this.playNext({ fromEnd: false, skipped: true });
  }

  /** Play/pausa. Senza brano in corso ma con la coda piena (es. bot uscito) fa ripartire la coda. */
  togglePause({ channelId } = {}) {
    if (!this.current) {
      if (!this.queue.length || this.loading) return;
      this.setChannel(channelId);
      void this.playNext({ fromEnd: false });
      return;
    }
    if (this.loading) return;
    this.autoPaused = false; // da qui in poi la pausa (o la ripresa) è dell'utente
    this.paused ? this.resume() : this.pause();
  }

  pause() {
    if (!this.current || this.paused) return;
    this.pausedPos = this.position(); // durante un suono è già fermo: alla fine del suono resta in pausa
    this.paused = true;
    this.player?.pause();
    this.clearSim();
    this.changed();
  }

  resume() {
    if (!this.current || !this.paused) return;
    this.paused = false;
    if (this.pendingSeek) {
      // Spostato durante la pausa: il vecchio audio è già chiuso, si riparte dal punto scelto.
      void this.restartAt(this.pausedPos);
      return;
    }
    if (this.suonoAttivo()) {
      // Durante un suono: la musica riparte alla fine del suono
      this.suoni.musicaSospesa = true;
      this.changed();
      return;
    }
    this.startedAt = Date.now() - this.pausedPos * 1000;
    this.audio?.touch?.(); // in pausa l'audio non scorre: il controllo dei blocchi riparte da adesso
    this.player?.unpause();
    this.scheduleSim();
    this.changed();
  }

  skip() {
    if (!this.current) return;
    void this.playNext({ fromEnd: false, skipped: true });
  }

  // ---------- spostamento nel brano ----------
  /**
   * Va al secondo `sec` del brano in corso. Restituisce { ok, pos } oppure { ok: false, reason }.
   * Volume e pausa restano come sono; chiudere il vecchio flusso non fa partire il brano dopo.
   */
  seek(sec) {
    const t = this.current;
    if (!t) return { ok: false, reason: 'Non sta suonando niente' };
    if (this.loading) return { ok: false, reason: 'Il brano si sta ancora caricando, riprova tra un attimo' };
    if (!spostabile(t)) return { ok: false, reason: 'Questo brano non ha una durata (diretta?): non posso spostarmi' };
    const s = Number(sec);
    if (!Number.isFinite(s)) return { ok: false, reason: 'Tempo non valido' };
    const pos = Math.max(0, Math.min(Math.floor(t.duration) - 1, Math.floor(s)));

    if (!this.bot?.ready) {
      // Modalità prova: si sposta solo l'orologio.
      if (this.paused || this.suonoAttivo()) this.pausedPos = pos;
      else this.startedAt = Date.now() - pos * 1000;
      this.scheduleSim();
      this.changed();
      return { ok: true, pos };
    }

    // Prima si stacca la risorsa (resource = null): così lo stop del vecchio flusso non conta come «finito».
    this.killAudio();
    this.player?.stop(true);
    this.pausedPos = pos;
    if (this.paused) {
      this.pendingSeek = true;
      this.changed();
      return { ok: true, pos };
    }
    void this.restartAt(pos);
    return { ok: true, pos };
  }

  /** Riapre l'audio del brano attuale dal secondo `pos` (dopo seek, o alla ripresa dopo seek in pausa). */
  async restartAt(pos) {
    const t = this.current;
    if (!t) return;
    const myId = ++this.playId;
    this.pendingSeek = false;
    this.killAudio();
    this.loading = true;
    this.pausedPos = pos;
    this.changed();
    try {
      await this.startReal(t, { at: pos, myId });
      if (myId !== this.playId) return;
      this.loading = false;
      this.startedAt = Date.now() - pos * 1000;
      this.changed();
    } catch (err) {
      if (myId !== this.playId) return;
      console.error(`[musica ${this.guildId}] spostamento in ${t.title}:`, err.message);
      this.onNotice(this.guildId, { kind: 'error', message: `Non riesco ad andare a quel punto di «${t.title}»: riparte dall'inizio` });
      try {
        await this.startReal(t, { myId });
        if (myId !== this.playId) return;
        this.loading = false;
        this.pausedPos = 0;
        this.startedAt = Date.now();
        this.changed();
      } catch (err2) {
        if (myId !== this.playId) return;
        this.loading = false;
        this.audioFailed(err2.message);
      }
    }
  }

  /** Mette in cache lo stream risolto di un brano (le voci più vecchie escono). */
  cacheStream(url, stream) {
    this.streamCache.delete(url);
    this.streamCache.set(url, {
      url: stream.url, headers: stream.headers, exp: stream.exp, direct: stream.direct,
      acodec: stream.acodec ?? null, protocol: stream.protocol ?? null, size: stream.size ?? null,
    });
    while (this.streamCache.size > URL_IN_CACHE_MAX) this.streamCache.delete(this.streamCache.keys().next().value);
  }

  /**
   * Stream del brano (URL diretto + header), dalla cache finché non scade; renew = chiedine uno nuovo.
   * Restituisce anche fromCache, per sapere se un errore può dipendere da un link vecchio.
   * bassa = richiesta di sfondo (preparazione): passa dopo quelle dell'utente.
   */
  async streamInfo(track, renew = false, { bassa = false } = {}) {
    const c = this.streamCache.get(track.url);
    if (!renew && c && c.exp > Date.now()) return { ...c, fromCache: true };
    let p = this.resolving.get(track.url);
    if (!p) {
      p = this.lib.getStream(track.url, null, { bassa }).finally(() => this.resolving.delete(track.url));
      this.resolving.set(track.url, p);
    }
    const fresh = await p;
    this.cacheStream(track.url, fresh);
    return { ...this.streamCache.get(track.url), fromCache: false };
  }

  /** Apre ffmpeg e aspetta il primo audio (registra il tempo, per capire le partenze lente). */
  async prova(info, at, fonte, attesaMs) {
    const t0 = Date.now();
    const audio = this.lib.createOpusStreamAt(info, at, { volume: this.volume, fonte });
    try {
      await audio.ready(attesaMs);
    } catch (err) {
      audio.kill();
      throw err;
    }
    const ms = Date.now() - t0;
    if (ms > 1500) console.log(`[musica ${this.guildId}] primo audio da ${fonte} in ${ms} ms`);
    audio.info = info;
    return audio;
  }

  /**
   * Apre l'audio del brano (dal secondo `at`). Prima la copia in RAM (cache), poi la via veloce
   * (ffmpeg sull'URL diretto); se il link è vecchio o scaduto (403, dati non validi) ne chiede uno
   * nuovo e riprova una volta; poi il ripiego yt-dlp | ffmpeg (escluso con soloVeloce). Se fallisce
   * anche quello l'errore sale e si passa al brano dopo.
   */
  async openAudio(track, at = 0, { soloVeloce = false } = {}) {
    const locale = this.cache ? await this.cache.sorgente(track.url) : null;
    if (locale) {
      try {
        return await this.prova(locale, at, 'cache', ATTESA_DIRETTO_MS);
      } catch (err) {
        this.cache.togli(track.url);
        console.error(`[musica ${this.guildId}] ${track.title}: copia in RAM non leggibile (${erroreAudio(err)}), uso la rete`);
      }
    }
    let info = null;
    try {
      info = await this.streamInfo(track);
    } catch (err) {
      console.error(`[musica ${this.guildId}] ${track.title}: link diretto non disponibile (${err.message}), uso yt-dlp`);
    }
    for (let tentativo = 0; info?.direct && tentativo < 2; tentativo++) {
      try {
        return await this.prova(info, at, 'rete', ATTESA_DIRETTO_MS);
      } catch (err) {
        this.streamCache.delete(track.url);
        console.error(`[musica ${this.guildId}] ${track.title}: via veloce fallita (${erroreAudio(err)})`);
        // Un link appena chiesto che dà 403 non migliora chiedendone un altro: si va al ripiego.
        if (tentativo > 0 || (!info.fromCache && urlScaduto(err))) break;
        try {
          info = await this.streamInfo(track, true);
        } catch {
          break;
        }
      }
    }
    // ffmpeg rifiutato (403) ma il link è diretto: la cache scarica a blocchi Range da 4 MB (come
    // yt-dlp), che YouTube di solito accetta; in ~0,3 s il brano è in RAM e parte da lì.
    if (info?.direct && this.cache?.attiva) {
      const t0 = Date.now();
      const locale = await this.cache.subito(track.url, info, { durata: track.duration, live: track.live }, ATTESA_RAM_MS);
      if (locale) {
        try {
          const a = await this.prova(locale, at, 'cache', ATTESA_DIRETTO_MS);
          console.log(`[musica ${this.guildId}] ${track.title}: parte dalla RAM dopo il rifiuto di ffmpeg (${Date.now() - t0} ms)`);
          return a;
        } catch (err) {
          this.cache.togli(track.url);
          console.error(`[musica ${this.guildId}] ${track.title}: copia in RAM non leggibile (${erroreAudio(err)})`);
        }
      }
    }
    if (soloVeloce) throw new Error('via veloce non disponibile');
    console.log(`[musica ${this.guildId}] ${track.title}: ripiego yt-dlp | ffmpeg (più lento)`);
    const audio = this.lib.createOpusStream(track.url, at, { volume: this.volume });
    try {
      await audio.ready(ATTESA_RIPIEGO_MS);
      return audio;
    } catch (err) {
      audio.kill();
      throw new Error(erroreAudio(err));
    }
  }

  /** Il brano che suonerà dopo quello attuale (con i loop). */
  prossimoBrano() {
    return this.prossimiBrani(1)[0] || null;
  }

  /**
   * I brani che suoneranno dopo quello attuale, in ordine e con i loop (al massimo n). Ripeti brano:
   * solo il brano in corso. Ripeti coda: finita la coda torna il brano in corso.
   */
  prossimiBrani(n = PROSSIMI_IN_RAM) {
    if (this.loop === 'track') return this.current ? [this.current] : [];
    const lista = this.queue.slice(0, n);
    if (this.loop === 'queue' && this.current && lista.length < n) lista.push(this.current);
    return lista;
  }

  /**
   * I brani da tenere nella cache in RAM (al massimo 4): l'ultimo ascoltato (diverso da quello in
   * corso, utile per «precedente»), quello in corso e i 2 prossimi. Gli altri vengono tolti.
   */
  braniDaTenere() {
    const cur = this.current?.url;
    const prima = this.history.find((t) => t.url !== cur)?.url;
    return [...new Set([prima, cur, ...this.prossimiBrani().map((t) => t.url)].filter(Boolean))];
  }

  /** Scarica nella cache in RAM l'audio di un brano (se il link è diretto e il brano non è troppo lungo). */
  inCache(track, info) {
    if (!this.cache || !track?.url || !info?.direct) return;
    this.cache.scarica(track.url, info, { durata: track.duration, live: track.live });
  }

  /**
   * Mentre suona un brano prepara i 2 prossimi, così partono senza attese: uno alla volta (prima il
   * prossimo, poi il secondo) link diretto (yt-dlp, con priorità bassa) e poi audio nella cache in
   * RAM. Se un brano è già in RAM non serve nemmeno il link. Se la coda cambia nel frattempo si ferma.
   */
  async prefetch() {
    if (!this.bot?.ready) return;
    for (const next of this.prossimiBrani()) {
      if (next === this.current) continue; // ripeti brano / ripeti coda corta: è già quello in corso
      if (!(await this.prepara(next))) return;
    }
  }

  /** Prepara un brano successivo. false se nel frattempo è uscito dai prossimi (coda cambiata). */
  async prepara(next) {
    const ancora = () => this.prossimiBrani().includes(next);
    try {
      await ensurePlayable(next, { bassa: true });
      if (!ancora()) return false; // nel frattempo la coda è cambiata (es. svuotata)
      if (!next.url || this.cache?.ha(next.url)) return true;
      const c = this.streamCache.get(next.url);
      const info = c && c.exp > Date.now() ? c : await this.streamInfo(next, false, { bassa: true });
      if (!ancora()) return false; // tolto mentre si chiedeva il link: niente download inutile
      this.cache?.proteggi(this.guildId, this.braniDaTenere());
      if (this.inVoice()) this.inCache(next, info);
    } catch (err) {
      console.error(`[musica ${this.guildId}] preparazione di «${next.title}» non riuscita: ${err.message}`);
    }
    return true;
  }

  // ---------- storico (ascoltati di recente) ----------
  /** Un brano finito, saltato o sostituito va in cima allo storico (niente doppioni di fila). */
  pushHistory(t) {
    if (!branoValido(t)) return;
    if (this.history[0]?.url === t.url) return;
    this.history.unshift({ ...t });
    if (this.history.length > STORICO_MAX) this.history.length = STORICO_MAX;
  }

  /** Fa suonare subito un brano dello storico (quello in corso finisce nello storico). */
  playFromHistory(id, { channelId } = {}) {
    const i = this.history.findIndex((t) => t.id === id);
    if (i < 0) return null;
    const [t] = this.history.splice(i, 1);
    this.setChannel(channelId);
    this.queue.unshift(copia(t));
    void this.playNext({ fromEnd: false, skipped: true });
    return t;
  }

  /** Rimette in fondo alla coda un brano dello storico. */
  queueFromHistory(id, { channelId } = {}) {
    const t = this.history.find((x) => x.id === id);
    if (!t) return null;
    this.setChannel(channelId);
    this.queue.push(copia(t));
    if (!this.current && !this.loading) void this.playNext({ fromEnd: false });
    else this.changed();
    return t;
  }

  /**
   * Indietro: oltre 5 s ricomincia il brano attuale; altrimenti suona l'ultimo dello storico
   * e il brano attuale torna in cima alla coda. Restituisce { ok, restarted, track } o { ok: false, reason }.
   */
  previous({ channelId } = {}) {
    if (this.loading) return { ok: false, reason: 'Il brano si sta ancora caricando, riprova tra un attimo' };
    const cur = this.current;
    if (cur && (this.position() > PRECEDENTE_RIPARTI_S || !this.history.length)) {
      if (spostabile(cur)) {
        const r = this.seek(0);
        if (r.ok) return { ok: true, restarted: true, track: cur };
      }
      this.current = null; // non va nello storico: ricomincia
      this.queue.unshift(cur);
      void this.playNext({ fromEnd: false });
      return { ok: true, restarted: true, track: cur };
    }
    if (!this.history.length) return { ok: false, reason: 'Non c\'è nessun brano ascoltato di recente' };
    const prev = this.history.shift();
    this.setChannel(channelId);
    if (cur) {
      this.current = null; // il brano attuale non va nello storico: torna in cima alla coda
      this.queue.unshift(cur);
    }
    this.queue.unshift(copia(prev));
    void this.playNext({ fromEnd: false });
    return { ok: true, restarted: false, track: prev };
  }

  /** Il bot è collegato a un canale vocale di questo server? */
  inVoice() {
    return Boolean(this.bot?.inVoice?.(this.guildId) ?? this.bot?.isConnected(this.guildId));
  }

  /** Ferma tutto, svuota la coda ed esce dal canale (anche se la coda era già finita). */
  stop() {
    this.stopGen++;
    this.clearPresenceTimers();
    this.away = false;
    this.autoPaused = false;
    if (this.inVoice()) this.leftOnPurpose = true;
    this.playId++;
    this.queue = [];
    this.prossimi.clear();
    this.current = null;
    this.paused = false;
    this.loading = false;
    this.pausedPos = 0;
    this.pendingSeek = false;
    this.suoni?.azzera();
    this.killAudio();
    this.player?.stop(true);
    this.clearSim();
    this.bot?.leave(this.guildId);
    this.changed();
  }

  remove(trackId) {
    const before = this.queue.length;
    this.queue = this.queue.filter((t) => t.id !== trackId);
    if (this.queue.length !== before) this.changed();
  }

  /** Svuota i brani successivi: quello in corso continua a suonare. Coda già vuota: niente. */
  clear() {
    if (!this.queue.length) return 0;
    const n = this.queue.length;
    this.queue = [];
    this.prossimi.clear();
    this.changed(); // aggiorna anche la cache: i brani preparati in anticipo escono dalla RAM
    return n;
  }

  move(trackId, toIndex) {
    const from = this.queue.findIndex((t) => t.id === trackId);
    if (from < 0) return;
    const to = Math.max(0, Math.min(this.queue.length - 1, Number(toIndex) || 0));
    const [t] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, t);
    this.changed();
  }

  shuffle() {
    this.prossimi.clear(); // l'ordine scelto non c'è più
    const q = this.queue;
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
    this.changed();
  }

  setLoop(mode) {
    this.loop = LOOP_MODES.includes(mode) ? mode : LOOP_MODES[(LOOP_MODES.indexOf(this.loop) + 1) % 3];
    this.changed();
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    this.applicaVolume();
    this.changed();
  }

  /**
   * Il volume lo applica node al momento della codifica (CodificatoreOpus in audio.js): si sente
   * dal prossimo pacchetto (~40-60 ms), anche in pausa o durante un suono, senza riaprire l'audio.
   */
  applicaVolume() {
    this.audio?.impostaVolume?.(this.volume);
  }

  // ---------- riproduzione ----------
  async playNext({ fromEnd, skipped = false }) {
    const prev = this.current;
    if (prev) this.pushHistory(prev);
    if (prev && fromEnd && this.loop === 'track' && !skipped) {
      this.queue.unshift(prev);
    } else if (prev && this.loop === 'queue') {
      this.queue.push(prev);
    }

    const next = this.queue.shift() || null;
    if (next) this.prossimi.delete(next.id);
    const myId = ++this.playId;
    this.killAudio();
    this.clearSim();
    this.current = next;
    this.paused = false;
    this.pausedPos = 0;
    this.pendingSeek = false;
    this.autoPaused = false;
    if (next) this.away = false;

    if (!next) {
      this.loading = false;
      this.player?.stop(true);
      this.changed();
      return;
    }

    this.loading = true;
    this.changed();

    try {
      await ensurePlayable(next);
      if (myId !== this.playId) return;

      if (this.bot?.ready && this.channelId) {
        await this.startReal(next);
      } else if (this.bot?.ready && !this.channelId) {
        throw new Error('Non so in quale canale vocale entrare: apri l\'Activity da un canale vocale');
      }
      if (myId !== this.playId) return;

      this.loading = false;
      this.startedAt = Date.now();
      if (this.paused) this.player?.pause(); // messo in pausa mentre preparava l'audio
      this.scheduleSim();
      // Appena entrato: se nel canale non c'è nessuno, parte subito il conto alla rovescia.
      if (this.bot?.ready && typeof this.bot.countHumans === 'function') {
        this.humansChanged(this.bot.countHumans(this.guildId));
      }
      this.changed();
    } catch (err) {
      if (myId !== this.playId) return;
      console.error(`[musica ${this.guildId}]`, err.message);
      this.onNotice(this.guildId, { kind: 'error', message: `Non riesco a riprodurre «${next.title}»: ${err.message}` });
      this.current = null; // evita che il loop ripeta un brano rotto
      void this.playNext({ fromEnd: false });
    }
  }

  /** Collega il bot e fa suonare il brano (dall'inizio, o dal secondo `at` per lo spostamento). */
  async startReal(track, { at = 0, myId = this.playId } = {}) {
    // Audio e canale vocale insieme: l'ingresso nel canale (~0,5-1,5 s la prima volta) non ritarda
    // più l'apertura dell'audio. Finché il player non legge, ffmpeg resta fermo (contropressione).
    const t0 = Date.now();
    let msAudio = null;
    const audioP = this.openAudio(track, at).then((a) => { msAudio = Date.now() - t0; return a; });
    audioP.catch(() => {}); // l'errore si legge sotto, con await
    let connection;
    try {
      connection = await this.bot.join(this.guildId, this.channelId);
    } catch (err) {
      audioP.then((a) => a.kill(), () => {});
      throw err;
    }
    const msVoce = Date.now() - t0;
    this.leftOnPurpose = false;
    if (!this.player) {
      this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
      this.player.on('stateChange', (oldState, newState) => {
        // Passa al brano dopo solo se è finito proprio quello attuale (non dopo stop o salta)
        const finito = newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle;
        if (finito && oldState.resource === this.resource && this.current && !this.loading) {
          // Finito senza aver mai suonato niente: è un errore, non va ripetuto con il loop.
          if (this.audio?.bytes && this.audio.bytes() === 0) {
            this.audioFailed('nessun audio ricevuto');
          } else {
            void this.playNext({ fromEnd: true });
          }
        }
      });
      this.player.on('error', (e) => {
        console.error(`[player ${this.guildId}]`, e.message);
        this.onNotice(this.guildId, { kind: 'error', message: `Errore audio: ${e.message}` });
      });
    }
    // Durante un suono la connessione resta al player dei suoni: alla fine torna alla musica
    if (!this.suonoAttivo()) connection.subscribe(this.player);
    else this.suoni.connection = connection;

    const audio = await audioP;
    console.log(`[musica ${this.guildId}] avvio «${String(track.title).slice(0, 60)}»: voce ${msVoce} ms, primo audio ${msAudio} ms (${audio.fonte || '?'})`);
    if (myId !== this.playId) {
      audio.kill(); // nel frattempo è cambiato brano (salta, stop...)
      return;
    }
    this.audio = audio;
    audio.impostaVolume?.(this.volume); // spostato mentre si apriva l'audio
    // Pacchetti Opus già pronti (codificati in node con il volume): il player li manda così come sono
    this.resource = createAudioResource(audio.stream, { inputType: audio.tipo ?? StreamType.Opus });
    this.player.play(this.resource);
    if (this.suonoAttivo()) {
      // Brano nuovo (salto, spostamento) durante un suono: parte in pausa e riprende alla fine del suono
      this.player.pause();
      this.suoni.musicaSospesa = true;
      this.pausedPos = at;
    }
    this.startStallWatch();
    this.inCache(track, audio.info); // il brano in corso in RAM: spostamenti e volume senza rete
    void this.prefetch();
  }

  // ---------- controllo dei blocchi dell'audio ----------
  /** Se yt-dlp o ffmpeg si bloccano (nessun dato per stallMs, fuori dalla pausa) si passa oltre. */
  startStallWatch() {
    this.clearStallWatch();
    this.stallTimer = setInterval(() => this.checkStall(), CONTROLLO_BLOCCO_MS);
    this.stallTimer.unref?.();
  }

  checkStall() {
    if (!this.audio?.idleMs || !this.current || this.paused || this.loading || this.suonoAttivo()) return;
    if (this.audio.idleMs() < this.stallMs) return;
    this.audioFailed(`audio fermo da ${Math.round(this.stallMs / 1000)} s`);
  }

  clearStallWatch() {
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stallTimer = null;
  }

  /** Il brano in corso non funziona: chiude i processi, avvisa e passa al successivo (senza ripeterlo). */
  audioFailed(reason) {
    const t = this.current;
    console.error(`[musica ${this.guildId}] ${t?.title}: ${reason}`);
    this.killAudio();
    this.onNotice(this.guildId, { kind: 'error', message: `Non riesco a riprodurre «${t?.title}»: ${reason}. Passo al prossimo` });
    this.current = null; // evita che il loop ripeta un brano rotto
    void this.playNext({ fromEnd: false });
  }

  // ---------- presenza nel canale vocale ----------
  /** Il bot ha contato gli utenti (non bot) rimasti nel suo canale vocale. */
  humansChanged(count) {
    this.humans = count;
    if (!this.emptyMs) return;
    if (count === 0) {
      if (this.current && !this.paused) {
        this.pause();
        this.autoPaused = true;
      }
      if (!this.emptyTimer) {
        this.clearIdleTimer(); // vale il conto del canale vuoto
        this.leaveAt = Date.now() + this.emptyMs;
        this.leaveReason = 'empty';
        this.emptyTimer = setTimeout(() => this.leaveChannel('empty'), this.emptyMs);
      }
      this.changed();
    } else if (count > 0) {
      const eraVuoto = Boolean(this.emptyTimer);
      this.clearEmptyTimer();
      if (this.autoPaused) {
        this.autoPaused = false;
        this.resume(); // riprende solo se la pausa l'aveva messa il bot
      }
      if (eraVuoto) this.changed();
    }
  }

  /** Il bot è stato spostato (channelId) o scollegato (null) da qualcuno, oppure è uscito lui. */
  botVoiceChanged(channelId) {
    if (channelId) {
      this.channelId = channelId;
      this.changed();
      return;
    }
    this.clearPresenceTimers();
    this.humans = null;
    this.suoni?.azzera();
    if (this.leftOnPurpose) {
      this.leftOnPurpose = false;
      this.changed();
      return;
    }
    // Scollegato a mano: ferma audio e processi, il brano torna in cima alla coda.
    if (this.current || this.audio) {
      this.parkCurrent();
      this.away = this.queue.length > 0;
      this.onNotice(this.guildId, { kind: 'info', message: 'Il bot è stato scollegato dal canale: premi play per farlo rientrare' });
    }
    this.bot?.leave(this.guildId); // chiude anche la connessione vocale rimasta appesa
    this.changed();
  }

  /** Esce dal canale vocale lasciando la coda (il brano in corso torna in cima). */
  leaveChannel(reason) {
    this.clearPresenceTimers();
    this.suoni?.azzera();
    this.parkCurrent();
    this.away = this.queue.length > 0;
    if (this.inVoice()) this.leftOnPurpose = true;
    this.bot?.leave(this.guildId);
    const message =
      reason === 'empty'
        ? 'Canale vuoto: il bot è uscito. Premi play per farlo rientrare'
        : `Nessun brano da ${Math.round(this.idleMs / 60_000)} min: il bot è uscito dal canale`;
    this.onNotice(this.guildId, { kind: 'info', message });
    this.changed();
  }

  /** Ferma il brano in corso senza perderlo: torna in cima alla coda e ripartirà dall'inizio. */
  parkCurrent() {
    this.playId++;
    if (this.current) this.queue.unshift(this.current);
    this.current = null;
    this.paused = false;
    this.loading = false;
    this.pausedPos = 0;
    this.pendingSeek = false;
    this.autoPaused = false;
    this.suoni?.azzera();
    this.killAudio();
    this.player?.stop(true);
    this.clearSim();
  }

  /** Coda finita e bot nel canale: dopo idleMs esce. */
  checkIdle() {
    const fermo = !this.current && !this.loading && !this.emptyTimer && !this.suonoAttivo();
    if (this.idleMs && fermo && this.inVoice()) {
      if (!this.idleTimer) {
        this.leaveAt = Date.now() + this.idleMs;
        this.leaveReason = 'idle';
        this.idleTimer = setTimeout(() => this.leaveChannel('idle'), this.idleMs);
      }
    } else if (this.idleTimer) {
      this.clearIdleTimer();
    }
  }

  clearEmptyTimer() {
    if (!this.emptyTimer) return;
    clearTimeout(this.emptyTimer);
    this.emptyTimer = null;
    if (this.leaveReason === 'empty') this.leaveReason = null;
  }

  clearIdleTimer() {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.leaveReason === 'idle') this.leaveReason = null;
  }

  clearPresenceTimers() {
    this.clearEmptyTimer();
    this.clearIdleTimer();
  }

  /** Senza bot (modalità prova) il tempo scorre "per finta", così si prova tutta l'interfaccia. */
  scheduleSim() {
    this.clearSim();
    if (this.bot?.ready || !this.current || this.paused || this.suonoAttivo()) return;
    const total = this.current.duration || SIM_DURATA_DEFAULT;
    const remaining = Math.max(0, total - this.position());
    this.simTimer = setTimeout(() => void this.playNext({ fromEnd: true }), remaining * 1000);
  }

  clearSim() {
    if (this.simTimer) clearTimeout(this.simTimer);
    this.simTimer = null;
  }

  /** A riposo (bot fuori da ogni canale): niente link vecchi, niente player, niente timer. */
  liberaRisorse() {
    if (this.inVoice() || this.current || this.loading || this.suonoAttivo()) return;
    this.streamCache.clear();
    this.suoni?.libera();
    this.killAudio();
    if (this.player) {
      this.player.removeAllListeners();
      this.player.stop(true);
      this.player = null;
    }
  }

  killAudio() {
    this.clearStallWatch();
    this.audio?.kill();
    this.audio = null;
    this.resource = null;
  }
}

/** Registro di tutte le guild. */
export class MusicManager {
  constructor({ bot, onChange, onNotice, onMembers = null, emptySeconds, idleMinutes, stallSeconds, store = null, cache = null, riposoMinuti = 0, onRiposo = null }) {
    this.bot = bot;
    this.onMembers = onMembers;
    this.options = { emptySeconds, idleMinutes, stallSeconds };
    this.onChange = onChange;
    this.onNotice = onNotice;
    this.store = store; // QueueStore (store.js) oppure null: niente salvataggio
    this.cache = cache; // AudioCache condivisa (budget unico per tutti i server) oppure null
    this.guilds = new Map();
    // Riposo: senza il bot in nessun canale vocale per riposoMs si liberano cache e memoria
    this.riposoMs = Math.max(0, riposoMinuti) * 60_000;
    this.onRiposo = onRiposo; // () => void: pulizie extra (es. copertine in memoria)
    this.riposoTimer = null;
    this.aRiposo = false;
  }

  get(guildId) {
    let g = this.guilds.get(guildId);
    if (!g) {
      const onPersist = this.store ? (id, data) => this.store.save(id, data) : null;
      g = new GuildMusic(guildId, {
        bot: this.bot, onChange: this.onChange, onNotice: this.onNotice, onMembers: this.onMembers, onPersist, ...this.options,
        cache: this.cache, onAttivita: () => this.controllaRiposo(),
      });
      this.guilds.set(guildId, g);
    }
    return g;
  }

  /** Il bot sta facendo qualcosa (in un canale vocale, o sta caricando un brano)? */
  attivo() {
    for (const g of this.guilds.values()) if (g.inVoice() || g.loading || g.current || g.suonoAttivo()) return true;
    return false;
  }

  /** A ogni cambiamento: se il bot non è in nessun canale vocale parte il conto per il riposo. */
  controllaRiposo() {
    if (!this.riposoMs) return;
    if (this.attivo()) {
      this.aRiposo = false;
      if (this.riposoTimer) clearTimeout(this.riposoTimer);
      this.riposoTimer = null;
      return;
    }
    if (this.riposoTimer || this.aRiposo) return;
    this.riposoTimer = setTimeout(() => this.riposa(), this.riposoMs);
    this.riposoTimer.unref?.();
  }

  /**
   * Riposo: svuota la cache audio (annulla i download), libera link e player, lascia lavorare il
   * garbage collector. Il bot resta collegato a Discord (heartbeat del gateway) e riparte al primo play.
   */
  riposa() {
    this.riposoTimer = null;
    if (this.attivo()) return;
    this.aRiposo = true;
    const c = this.cache?.svuota() ?? { brani: 0, mb: 0 };
    for (const g of this.guilds.values()) g.liberaRisorse();
    try { this.onRiposo?.(); } catch { /* facoltativo */ }
    globalThis.gc?.(); // solo se node è avviato con --expose-gc
    const m = process.memoryUsage();
    console.log(`[riposo] nessuno in vocale da ${Math.round(this.riposoMs / 60_000)} min: liberati ${c.brani} brani (${c.mb.toFixed(1)} MB) dalla cache · memoria rss ${(m.rss / 1048576).toFixed(0)} MB, heap ${(m.heapUsed / 1048576).toFixed(0)} MB, buffer ${(m.arrayBuffers / 1048576).toFixed(1)} MB`);
  }

  /** All'avvio: ricarica le code salvate. Restituisce quante guild avevano brani. */
  restoreAll() {
    if (!this.store) return 0;
    let n = 0;
    for (const [guildId, data] of this.store.loadAll()) {
      const g = this.get(guildId);
      g.restore(data);
      if (g.queue.length) n++;
    }
    return n;
  }
}
