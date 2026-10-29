// Soundbar: il secondo AudioPlayer di ogni server (playerSuoni), separato da quello della musica.
// Niente mixing: quando parte un suono la musica va in pausa esplicita, la connessione si iscrive
// al player dei suoni e, alla fine, torna alla musica che riprende dal punto esatto.
// Hook sottili in music.js (position, startReal, checkStall, applicaVolume, pause, resume, stop…).
import fs from 'node:fs';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
} from '@discordjs/voice';
import { SoundError } from './suoni.js';
import { createFileStream } from './audio.js';
import { config } from './config.js';

const MARGINE_FINE_MS = 3000; // se il player non dice «finito» entro durata + 3 s, si chiude comunque

export class SoundPlayer {
  /** @param {import('./music.js').GuildMusic} g */
  constructor(g) {
    this.g = g;
    this.player = null; // AudioPlayer dei suoni (creato al primo suono)
    this.resource = null;
    this.connection = null;
    this.attivo = null; // { id, name, by, inizio, fine, duration } del suono in corso
    this.musicaSospesa = false; // la musica è in pausa per il suono (non per l'utente)
    this.timer = null;
    this.gen = 0;
    // Nei test si sostituiscono con versioni finte
    this.crea = {
      player: () => createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }),
      risorsa: (file) => this.risorsaFile(file),
    };
    this.flusso = null; // ffmpeg + codificatore del suono in corso (solo con VOLUME_BASE diverso da 1)
  }

  /**
   * Risorsa del suono. Con VOLUME_BASE 1 il file Ogg/Opus va così com'è (niente ffmpeg); altrimenti
   * passa dalla stessa via della musica (ffmpeg decodifica, node applica il volume di base e codifica
   * in Opus): un suono dura al massimo ~20 s, costo minimo. Il cursore del volume non conta per i suoni.
   */
  risorsaFile(file) {
    const base = config.volumeBase;
    if (base === 1) return createAudioResource(fs.createReadStream(file), { inputType: StreamType.OggOpus });
    this.chiudiFfmpeg();
    const flusso = createFileStream(file, { guadagno: base });
    this.flusso = flusso;
    return createAudioResource(flusso.stream, { inputType: flusso.tipo });
  }

  /** Chiude l'ffmpeg del suono precedente (interrotto o finito), se c'è ancora. */
  chiudiFfmpeg() {
    const f = this.flusso;
    this.flusso = null;
    f?.kill();
  }

  /** Per lo stato verso i client. */
  stato() {
    return this.attivo ? { ...this.attivo } : null;
  }

  /** Canale vocale in cui si trova davvero il bot (null se fuori). */
  canaleBot() {
    const g = this.g;
    if (!g.inVoice()) return null;
    return g.bot?.canaleBot?.(g.guildId) ?? g.channelId;
  }

  /**
   * Suona un suono: { id, name, duration } e il file Ogg/Opus. by = nome di chi l'ha fatto partire.
   * channelId = canale dell'Activity di chi suona (il bot entra lì se è fuori).
   * Restituisce { ok: true, prova } (prova = senza Discord: niente audio).
   */
  async suona(suono, { file, by = null, channelId = null } = {}) {
    const g = this.g;
    const durata = Number.isFinite(suono.duration) && suono.duration > 0 ? suono.duration : 1;
    const myGen = ++this.gen;

    if (!g.bot?.ready) {
      // Modalità prova: niente audio, ma lo stato c'è (e il tempo del brano si ferma) per provare l'interfaccia.
      this.sospendiMusica();
      g.clearSim();
      this.avvia(suono, by, durata, myGen);
      g.changed();
      return { ok: true, prova: true };
    }

    const canale = this.canaleBot();
    if (canale && channelId && canale !== channelId) throw new SoundError('Il bot è in un altro canale', 'altro_canale');
    const dove = canale || channelId || g.channelId;
    if (!dove) throw new SoundError('Non so in quale canale vocale entrare: apri l\'Activity da un canale vocale', 'altro_canale');
    if (!canale) g.channelId = dove;
    if (file && !fs.existsSync(file)) throw new SoundError('Il file di questo suono non c\'è più', 'formato');

    const connection = await g.bot.join(g.guildId, dove);
    if (myGen !== this.gen) return { ok: true, prova: false }; // nel frattempo un altro suono
    g.leftOnPurpose = false;
    this.connection = connection;

    // Musica in pausa esplicita (prima di cambiare iscrizione): con NoSubscriberBehavior.Play il
    // player della musica altrimenti consumerebbe lo stream senza che nessuno lo senta.
    this.sospendiMusica();

    if (!this.player) {
      this.player = this.crea.player();
      this.player.on('stateChange', (oldState, newState) => {
        const finito = newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle;
        if (finito && this.resource && oldState.resource === this.resource) this.fine();
      });
      this.player.on('error', (e) => console.error(`[suoni ${g.guildId}]`, e.message));
    }
    this.resource = null; // il suono interrotto non deve contare come «finito»
    const risorsa = this.crea.risorsa(file);
    this.avvia(suono, by, durata, myGen);
    this.resource = risorsa;
    connection.subscribe(this.player);
    this.player.play(risorsa);
    g.changed();
    return { ok: true, prova: false };
  }

  /** Mette in pausa la musica per il suono (solo se suonava davvero e non è già sospesa). */
  sospendiMusica() {
    const g = this.g;
    if (this.attivo || this.musicaSospesa || !g.current || g.paused || g.loading) return;
    g.pausedPos = g.position();
    g.player?.pause();
    this.musicaSospesa = true;
  }

  avvia(suono, by, durata, myGen) {
    clearTimeout(this.timer);
    // inizio e fine in ms epoch (Date.now() del server), duration in secondi
    const inizio = Date.now();
    this.attivo = { id: suono.id, name: suono.name, by, inizio, fine: inizio + Math.round(durata * 1000), duration: durata };
    this.timer = setTimeout(() => {
      if (myGen === this.gen && this.attivo) this.fine();
    }, durata * 1000 + (this.g.bot?.ready ? MARGINE_FINE_MS : 0));
    this.timer.unref?.();
  }

  /** Fine del suono (finito, fermato dall'utente o timer): la musica riprende se era sospesa per il suono. */
  fine() {
    const g = this.g;
    if (!this.attivo) return;
    this.gen++;
    clearTimeout(this.timer);
    this.timer = null;
    this.attivo = null;
    const r = this.resource;
    this.resource = null;
    if (r) this.player?.stop(true);
    this.chiudiFfmpeg();
    if (g.player && this.connection) this.connection.subscribe(g.player);
    // Riprende solo la musica sospesa dal suono: quella messa in pausa dall'utente ha paused = true.
    // (Durante un suono la musica non suona mai: se c'è un brano non in pausa è sospeso dal suono.)
    this.musicaSospesa = false;
    if (g.current && !g.paused && !g.loading) {
      g.startedAt = Date.now() - g.pausedPos * 1000;
      g.audio?.touch?.(); // in pausa l'audio non scorre: il controllo dei blocchi riparte da adesso
      g.player?.unpause();
      g.scheduleSim();
    }
    g.changed();
  }

  /** «Ferma il suono» dall'interfaccia. */
  interrompi() {
    if (!this.attivo) return false;
    this.fine();
    return true;
  }

  /** Stop, uscita dal canale, brano parcheggiato: si ferma tutto senza far ripartire la musica. */
  azzera() {
    this.gen++;
    clearTimeout(this.timer);
    this.timer = null;
    this.attivo = null;
    this.musicaSospesa = false;
    this.resource = null;
    this.connection = null;
    this.player?.stop(true);
    this.chiudiFfmpeg();
  }

  /** A riposo: niente player. */
  libera() {
    this.azzera();
    if (this.player) {
      this.player.removeAllListeners();
      this.player = null;
    }
  }
}
