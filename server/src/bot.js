// Il bot Discord: login, ingresso e uscita dal canale vocale, lettura dei link nel canale testuale.
import { Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits, Routes } from 'discord.js';
import { VoiceConnectionStatus, entersState, getVoiceConnection, joinVoiceChannel } from '@discordjs/voice';
import { haUnRuolo } from './suoni.js';

const ATTESA_PRONTA_MS = 20_000; // tempo massimo per passare da Signalling/Connecting a Ready
const ATTESA_RICONNESSIONE_MS = 5_000; // dopo Disconnected: se Discord non riprova entro 5 s si chiude

/** Connessioni vocali a cui sono già agganciati i controlli (joinVoiceChannel riusa lo stesso oggetto). */
const sorvegliate = new WeakSet();

/** Notifiche sulle persone nel canale: al massimo una ogni tanto (gli eventi «parla» sono fitti). */
export const MEMBRI_ATTESA_MS = 200;
const AVATAR_PX = 64;

/** Copertine e avatar passano dal proxy del server: dentro l'Activity le immagini esterne sono bloccate (CSP). */
export const viaProxy = (u) => (u ? `/api/thumb?u=${encodeURIComponent(u)}` : null);

/**
 * Persone (non bot) in un canale vocale, dagli stati vocali in cache (intent GuildVoiceStates).
 * Ordinate per nome. `parlanti`: Set degli id che stanno parlando (dal ricevitore della voce).
 * Restituisce anche `mancanti`: id con stato vocale ma senza membro in cache (da chiedere a Discord).
 */
export function elencoMembri(guild, channelId, { parlanti = null, users = null } = {}) {
  const members = [];
  const mancanti = [];
  if (!guild || !channelId) return { members, mancanti };
  for (const vs of guild.voiceStates?.cache?.values?.() ?? []) {
    if (vs.channelId !== channelId) continue;
    const member = vs.member ?? guild.members?.cache?.get(vs.id) ?? null;
    const user = member?.user ?? users?.get?.(vs.id) ?? null;
    if (user?.bot) continue;
    if (!member) mancanti.push(vs.id);
    const avatar = member?.displayAvatarURL?.({ size: AVATAR_PX, extension: 'png' }) ??
      user?.displayAvatarURL?.({ size: AVATAR_PX, extension: 'png' }) ?? null;
    members.push({
      id: vs.id,
      name: member?.displayName || user?.globalName || user?.username || 'Utente',
      avatar: viaProxy(avatar),
      avatarUrl: avatar,
      speaking: Boolean(parlanti?.has(vs.id)),
      muted: Boolean(vs.selfMute || vs.serverMute),
      deaf: Boolean(vs.selfDeaf || vs.serverDeaf),
      // Silenziato / audio tolto da un moderatore (non da sé): `mute`/`deaf` del Voice State di Discord.
      serverMuted: Boolean(vs.serverMute),
      serverDeaf: Boolean(vs.serverDeaf),
      // Condivide lo schermo con «Go Live» (self_stream) e videocamera accesa (self_video).
      streaming: Boolean(vs.streaming),
      video: Boolean(vs.selfVideo),
    });
  }
  members.sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }) || a.id.localeCompare(b.id));
  return { members, mancanti };
}

/**
 * Chi sta parlando, dal ricevitore della connessione vocale: solo gli eventi start/end della
 * SpeakingMap (nessun subscribe, quindi niente decifratura né decodifica dell'audio).
 * `onCambio()` viene chiamata a ogni inizio/fine. Restituisce il Set degli id che parlano.
 */
export function ascoltaParlanti(connection, onCambio) {
  const parlanti = new Set();
  const speaking = connection?.receiver?.speaking;
  if (!speaking?.on) return parlanti;
  speaking.on('start', (userId) => {
    if (parlanti.has(userId)) return;
    parlanti.add(userId);
    onCambio();
  });
  speaking.on('end', (userId) => {
    if (!parlanti.delete(userId)) return;
    onCambio();
  });
  connection.on?.('stateChange', (_old, nuovo) => {
    if (nuovo.status !== VoiceConnectionStatus.Destroyed || !parlanti.size) return;
    parlanti.clear();
    onCambio();
  });
  return parlanti;
}

const chiudiConnessione = (connection) => {
  if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
};

/**
 * Controlli sulla connessione vocale: errori registrati (senza far cadere il processo), stati
 * Signalling/Connecting bloccati chiusi dopo 20 s, Disconnected gestito come nella guida ufficiale.
 */
export function watchConnection(connection, guildId) {
  if (sorvegliate.has(connection)) return;
  sorvegliate.add(connection);
  connection.on('error', (err) => console.error(`[voce ${guildId}] Errore della connessione vocale:`, err.message));

  let inAttesa = false;
  connection.on('stateChange', async (_old, nuovo) => {
    if (nuovo.status === VoiceConnectionStatus.Disconnected) {
      // Spostato o scollegato: se Discord sta già riconnettendo va bene, altrimenti si chiude.
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, ATTESA_RICONNESSIONE_MS),
          entersState(connection, VoiceConnectionStatus.Connecting, ATTESA_RICONNESSIONE_MS),
        ]);
      } catch {
        console.warn(`[voce ${guildId}] Scollegato e nessuna riconnessione: chiudo la connessione`);
        chiudiConnessione(connection);
      }
      return;
    }
    const inCorso = nuovo.status === VoiceConnectionStatus.Signalling || nuovo.status === VoiceConnectionStatus.Connecting;
    if (!inCorso || inAttesa) return;
    inAttesa = true;
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, ATTESA_PRONTA_MS);
    } catch {
      const s = connection.state.status;
      if (s === VoiceConnectionStatus.Signalling || s === VoiceConnectionStatus.Connecting) {
        console.warn(`[voce ${guildId}] Connessione vocale bloccata in «${s}» da ${ATTESA_PRONTA_MS / 1000} s: la chiudo`);
        chiudiConnessione(connection);
      }
    } finally {
      inAttesa = false;
    }
  });
}

export class Bot {
  constructor({ token, textChannelIds = [], textChannelId = '', mostraParlanti = true }) {
    this.token = token;
    // Chi parla: serve entrare nel canale NON self-deaf, altrimenti Discord non manda i pacchetti voce.
    this.mostraParlanti = Boolean(mostraParlanti);
    this.parlanti = new Map(); // guildId -> Set degli id che parlano (connessione attuale)
    this.connParlanti = new WeakSet(); // connessioni con l'ascolto già agganciato
    this.membriTimer = new Map(); // guildId -> timer della notifica accorpata
    this.membriVoce = new Map(); // guildId -> true se nella finestra c'è stato un cambio di stato vocale
    this.inRichiesta = new Set(); // guildId:userId di membri chiesti a Discord (non in cache)
    // Canali "musica": lì ogni messaggio è un brano o un comando. Altrove serve la menzione del bot.
    this.textChannelIds = new Set([...textChannelIds, ...String(textChannelId || '').split(',')].map((s) => String(s).trim()).filter(Boolean));
    this.ready = false;
    this.onText = null; // (ctx) => Promise<void>: messaggio in chat, vedi handleTextMessage in commands.js
    this.onCommand = null; // (interaction) => Promise<void>
    this.onAutocomplete = null; // (interaction) => Promise<void>: suggerimenti delle opzioni
    this.onBotVoice = null; // (guildId, channelId|null): il bot è stato spostato o scollegato
    this.onHumans = null; // (guildId, count): utenti (non bot) nel canale del bot
    this.onMembers = null; // (guildId, { voce }): cambiate le persone nel canale (voce) o chi parla
    this.onStatoCanale = null; // (channelId, status): stato di un canale vocale visto dal gateway
    this.commands = []; // definizioni JSON dei comandi slash

    // Messaggi sempre attivi: le menzioni del bot valgono in qualsiasi canale (serve l'intent Message Content).
    const intents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ];
    this.client = new Client({ intents });
    // Senza questi ascoltatori un errore del gateway farebbe cadere tutto il processo.
    this.client.on(Events.Error, (err) => console.error('[bot] Errore del client Discord:', err.message));
    this.client.on(Events.Warn, (msg) => console.warn('[bot] Avviso di discord.js:', msg));
    this.client.on(Events.ShardError, (err, id) => console.error(`[bot] Errore della connessione al gateway (shard ${id}):`, err.message));
    this.client.on(Events.ShardDisconnect, (ev, id) => console.warn(`[bot] Gateway scollegato (shard ${id}, codice ${ev?.code})`));
    this.client.on(Events.ShardReconnecting, (id) => console.warn(`[bot] Riconnessione al gateway (shard ${id})…`));
    this.client.on(Events.ShardResume, (id) => console.log(`[bot] Gateway di nuovo collegato (shard ${id})`));
  }

  async start() {
    this.client.once(Events.ClientReady, (c) => {
      this.ready = true;
      console.log(`[bot] Collegato come ${c.user.tag}`);
      // Comandi di server (guild): compaiono subito, a differenza di quelli globali.
      for (const guild of c.guilds.cache.values()) void this.registerCommands(guild);
    });
    this.client.on(Events.GuildCreate, (guild) => void this.registerCommands(guild));
    this.client.on(Events.InteractionCreate, (i) => void this.handleInteraction(i));
    // Chi entra ed esce dai canali vocali (serve l'intent GuildVoiceStates, già attivo).
    this.client.on(Events.VoiceStateUpdate, (oldState, newState) => this.handleVoiceState(oldState, newState));
    this.client.on(Events.MessageCreate, (m) => void this.handleMessage(m));
    // Stato dei canali vocali: discord.js non lo gestisce, si legge dagli eventi grezzi del gateway.
    this.client.on(Events.Raw, (pacchetto) => this.handleRaw(pacchetto));
    try {
      await this.client.login(this.token);
    } catch (err) {
      const extra = /disallowed intents/i.test(err.message)
        ? ' Attiva l\'intent "Message Content" nel Developer Portal (Bot → Privileged Gateway Intents): serve per i messaggi in chat e le menzioni.'
        : ' Controlla DISCORD_BOT_TOKEN nel file .env.';
      throw new Error(`Login del bot fallito: ${err.message}.${extra}`);
    }
  }

  async registerCommands(guild) {
    if (!this.commands.length) return;
    try {
      await guild.commands.set(this.commands);
      console.log(`[bot] Comandi slash registrati in «${guild.name}»`);
    } catch (err) {
      console.warn(`[bot] Non riesco a registrare i comandi in «${guild.name}»: ${err.message} (serve lo scope applications.commands)`);
    }
  }

  async handleInteraction(i) {
    // Suggerimenti mentre si scrive un'opzione (es. il nome del suono in /suono suona)
    if (i.isAutocomplete?.()) {
      if (!this.onAutocomplete) return;
      try {
        await this.onAutocomplete(i);
      } catch (err) {
        console.warn(`[bot] suggerimenti /${i.commandName}:`, err.message);
        await i.respond([]).catch(() => {});
      }
      return;
    }
    if (!i.isChatInputCommand() || !this.onCommand) return;
    try {
      await this.onCommand(i);
    } catch (err) {
      console.error(`[bot] /${i.commandName}:`, err.message);
      const risposta = { content: `Errore: ${err.message}`, flags: MessageFlags.Ephemeral };
      await (i.deferred || i.replied ? i.followUp(risposta) : i.reply(risposta)).catch(() => {});
    }
  }

  /** Utenti veri (non bot) nel canale vocale in cui si trova il bot; null se il bot non è in vocale. */
  countHumans(guildId) {
    const guild = this.client.guilds.cache.get(guildId);
    const channel = guild?.members.me?.voice?.channel;
    if (!channel) return null;
    return channel.members.filter((m) => !m.user.bot).size;
  }

  /**
   * Persone nel canale vocale del bot; se il bot non è in vocale, nel canale di riferimento
   * `fallbackChannelId` (quello da cui è aperta l'Activity). Senza canale: [].
   */
  members(guildId, fallbackChannelId = null) {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return [];
    const channelId = guild.members.me?.voice?.channelId || fallbackChannelId;
    const { members, mancanti } = elencoMembri(guild, channelId, { parlanti: this.parlanti.get(guildId), users: this.client.users.cache });
    for (const id of mancanti) this.chiediMembro(guild, id);
    return members;
  }

  /** Membro con stato vocale ma non in cache: una richiesta a Discord (REST, nessun intent privilegiato). */
  chiediMembro(guild, userId) {
    const key = `${guild.id}:${userId}`;
    if (this.inRichiesta.has(key)) return;
    this.inRichiesta.add(key);
    guild.members.fetch(userId)
      .then(() => this.segnalaMembri(guild.id, true))
      .catch(() => {})
      .finally(() => setTimeout(() => this.inRichiesta.delete(key), 60_000).unref?.());
  }

  /**
   * Notifica accorpata: tanti eventi in MEMBRI_ATTESA_MS diventano una sola chiamata a onMembers.
   * voce=true se c'è stato almeno un cambio di stato vocale (entrate, uscite, muto), false se solo «parla».
   */
  segnalaMembri(guildId, voce = false) {
    if (voce) this.membriVoce.set(guildId, true);
    if (this.membriTimer.has(guildId)) return;
    const t = setTimeout(() => {
      this.membriTimer.delete(guildId);
      const v = this.membriVoce.get(guildId) === true;
      this.membriVoce.delete(guildId);
      this.onMembers?.(guildId, { voce: v });
    }, MEMBRI_ATTESA_MS);
    t.unref?.();
    this.membriTimer.set(guildId, t);
  }

  /** Aggancia (una volta per connessione) l'ascolto di chi parla. */
  ascolta(connection, guildId) {
    if (!this.mostraParlanti || this.connParlanti.has(connection)) return;
    this.connParlanti.add(connection);
    this.parlanti.set(guildId, ascoltaParlanti(connection, () => this.segnalaMembri(guildId, false)));
  }

  /** Amministratore del server (permesso Administrator; il proprietario lo ha sempre)? */
  async isAdmin(guildId, userId) {
    try {
      const guild = this.client.guilds.cache.get(guildId) ?? await this.client.guilds.fetch(guildId);
      const member = await guild.members.fetch(userId);
      return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator));
    } catch {
      return false;
    }
  }

  /**
   * Il membro ha almeno uno dei ruoli indicati (Soundbar: chi può caricare)? Dati freschi da
   * Discord (force): un ruolo può essere tolto o dato dopo il collegamento. Lista vuota = no.
   */
  async haRuolo(guildId, userId, ruoli) {
    if (!Array.isArray(ruoli) || !ruoli.length) return false;
    try {
      const guild = this.client.guilds.cache.get(guildId) ?? await this.client.guilds.fetch(guildId);
      const member = await guild.members.fetch({ user: userId, force: true });
      return haUnRuolo(member?.roles?.cache, ruoli);
    } catch {
      return false;
    }
  }

  handleVoiceState(oldState, newState) {
    const guildId = newState.guild.id;
    this.segnalaMembri(guildId, true); // persone nel canale: entrate, uscite, muto, schermo, video (accorpato)
    const me = this.client.user?.id;
    if (newState.id === me) {
      if (oldState.channelId !== newState.channelId) this.onBotVoice?.(guildId, newState.channelId ?? null);
      if (!newState.channelId) return;
    }
    const mine = newState.guild.members.me?.voice?.channelId;
    if (!mine || (oldState.channelId !== mine && newState.channelId !== mine)) return;
    if (oldState.channelId === newState.channelId && newState.id !== me) return; // muto, deaf, video…
    const count = this.countHumans(guildId);
    if (count !== null) this.onHumans?.(guildId, count);
  }

  /**
   * Eventi grezzi: VOICE_CHANNEL_STATUS_UPDATE (stato cambiato) e, se Discord lo manda, il campo
   * `status` dei canali vocali in GUILD_CREATE (stato già presente all'avvio).
   */
  handleRaw(pacchetto) {
    if (!this.onStatoCanale || !pacchetto?.d) return;
    try {
      if (pacchetto.t === 'VOICE_CHANNEL_STATUS_UPDATE') this.onStatoCanale(pacchetto.d.id, pacchetto.d.status ?? '');
      else if (pacchetto.t === 'GUILD_CREATE') {
        for (const ch of pacchetto.d.channels ?? []) if ('status' in ch) this.onStatoCanale(ch.id, ch.status ?? '');
      }
    } catch (err) {
      console.warn('[bot] Stato del canale vocale:', err.message);
    }
  }

  /** Stato del canale vocale (testo sotto il nome): PUT /channels/{id}/voice-status. '' = svuota. */
  impostaStatoCanale(channelId, status) {
    return this.client.rest.put(Routes.channelVoiceStatus(channelId), { body: { status } });
  }

  /** Canale vocale in cui si trova il bot in questo server (null se fuori). */
  canaleBot(guildId) {
    return this.client.guilds.cache.get(guildId)?.members.me?.voice?.channelId ?? null;
  }

  /** Nome del canale vocale del bot (o, se è fuori, di quello di riserva); null se non si sa. */
  nomeCanale(guildId, fallbackChannelId = null) {
    const guild = this.client.guilds.cache.get(guildId);
    const id = guild?.members.me?.voice?.channelId || fallbackChannelId;
    return (id && guild?.channels.cache.get(id)?.name) || null;
  }

  /** Collegato (o in collegamento) a un canale vocale di questo server? */
  inVoice(guildId) {
    const conn = getVoiceConnection(guildId);
    if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) return true;
    return Boolean(this.client.guilds.cache.get(guildId)?.members.me?.voice?.channelId);
  }

  isConnected(guildId) {
    return getVoiceConnection(guildId)?.state.status === VoiceConnectionStatus.Ready;
  }

  async join(guildId, channelId) {
    const existing = getVoiceConnection(guildId);
    if (existing && existing.joinConfig.channelId === channelId &&
        existing.state.status !== VoiceConnectionStatus.Destroyed) {
      watchConnection(existing, guildId);
      this.ascolta(existing, guildId);
      try {
        await entersState(existing, VoiceConnectionStatus.Ready, ATTESA_PRONTA_MS);
      } catch {
        chiudiConnessione(existing);
        throw new Error('La connessione al canale vocale non risponde: riprova');
      }
      return existing;
    }
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) throw new Error('Il bot non è in questo server: invitalo con il link del README');

    const connection = joinVoiceChannel({
      guildId,
      channelId,
      adapterCreator: guild.voiceAdapterCreator,
      // Non self-deaf solo se serve sapere chi parla: Discord manda i pacchetti voce solo a chi non è
      // deaf. Il bot non si iscrive a nessun audio (niente subscribe): legge solo l'SSRC dei pacchetti.
      selfDeaf: !this.mostraParlanti,
    });
    // Errori, stati bloccati e scollegamenti: vedi watchConnection.
    watchConnection(connection, guildId);
    this.ascolta(connection, guildId);
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, ATTESA_PRONTA_MS);
    } catch {
      chiudiConnessione(connection);
      throw new Error('Non riesco a entrare nel canale vocale (servono i permessi Connetti e Parla)');
    }
    return connection;
  }

  leave(guildId) {
    const conn = getVoiceConnection(guildId);
    if (conn) chiudiConnessione(conn);
  }

  /** Canale vocale di chi scrive: prima la cache degli stati vocali, poi una richiesta a Discord. */
  async voiceChannelOf(message) {
    const id = message.author.id;
    let ch = message.member?.voice?.channelId || message.guild?.voiceStates?.cache.get(id)?.channelId;
    if (!ch && message.guild?.members) {
      const m = await message.guild.members.fetch(id).catch(() => null);
      ch = m?.voice?.channelId;
    }
    return ch || null;
  }

  /**
   * Messaggi in chat. Nei canali musica (MUSIC_TEXT_CHANNEL_ID) ogni messaggio vale; altrove solo
   * quelli che menzionano il bot. Link o testo → in coda; parole brevi → comandi (vedi commands.js).
   */
  async handleMessage(message) {
    try {
      if (message.author?.bot || !message.guildId || !this.onText) return;
      const meId = this.client.user?.id;
      const menzione = Boolean(meId && message.mentions?.users?.has(meId));
      if (!menzione && !this.textChannelIds.has(message.channelId)) return;
      let text = String(message.content || '');
      if (meId) text = text.replace(new RegExp(`<@!?${meId}>`, 'g'), ' ');
      text = text.trim();
      const guildId = message.guildId;
      await this.onText({
        guildId,
        text,
        user: message.member?.displayName || message.author.globalName || message.author.username,
        voiceChannelId: await this.voiceChannelOf(message),
        botChannelId: this.client.guilds.cache.get(guildId)?.members.me?.voice?.channelId ?? null,
        humansInBotChannel: this.countHumans(guildId),
        reply: (content) => message.reply({ content, allowedMentions: { repliedUser: false } }),
        react: (emoji) => message.react(emoji),
      });
    } catch (err) {
      console.error('[bot] Messaggio in chat:', err.message);
      await message.reply?.({ content: `Errore: ${err.message}`, allowedMentions: { repliedUser: false } }).catch(() => {});
    }
  }
}
