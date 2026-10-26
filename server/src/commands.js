// Comandi slash (/play, /stop, /skip, /pausa, /coda, /vai, /precedente): stessa logica della GUI (music.js),
// così l'Activity si aggiorna in tempo reale anche quando si usa la chat.
import { EmbedBuilder, MessageFlags, SlashCommandBuilder, escapeMarkdown } from 'discord.js';
import { NOME_MAX, SoundError, pianoMsg } from './suoni.js';

const VERDE = 0x1ed760;

export const COMMANDS = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Mette in coda un brano: link (YouTube, SoundCloud, Spotify) o titolo da cercare')
    .setDMPermission(false)
    .addStringOption((o) =>
      o.setName('brano').setDescription('Link oppure titolo e artista').setRequired(true).setMaxLength(500),
    )
    .addStringOption((o) =>
      o.setName('dove')
        .setDescription('In fondo alla coda (predefinito) o subito dopo il brano in corso')
        .addChoices({ name: 'in coda', value: 'fine' }, { name: 'come prossima', value: 'prossimo' }),
    ),
  new SlashCommandBuilder().setName('stop').setDescription('Ferma la musica, svuota la coda e fa uscire il bot').setDMPermission(false),
  new SlashCommandBuilder().setName('skip').setDescription('Salta al prossimo brano della coda').setDMPermission(false),
  new SlashCommandBuilder().setName('pausa').setDescription('Mette in pausa o fa ripartire il brano').setDMPermission(false),
  new SlashCommandBuilder().setName('coda').setDescription('Mostra (solo a te) il brano in corso e i prossimi 10').setDMPermission(false),
  new SlashCommandBuilder()
    .setName('vai')
    .setDescription('Va a un punto del brano in corso')
    .setDMPermission(false)
    .addStringOption((o) =>
      o.setName('tempo').setDescription('Per esempio 1:30, 90 (secondi) o 1:02:03').setRequired(true).setMaxLength(12),
    ),
  new SlashCommandBuilder()
    .setName('precedente')
    .setDescription('Ricomincia il brano o, nei primi 5 secondi, torna a quello prima')
    .setDMPermission(false),
  // Soundbar: piano B del caricamento dall'Activity (stessa libreria, vedi suoni.js)
  new SlashCommandBuilder()
    .setName('suono')
    .setDescription('Soundbar: suoni brevi del server')
    .setDMPermission(false)
    .addSubcommand((s) =>
      s.setName('suona').setDescription('Fa suonare un suono della Soundbar (la musica riprende dopo)')
        .addStringOption((o) => o.setName('nome').setDescription('Nome del suono').setRequired(true).setAutocomplete(true).setMaxLength(100)),
    )
    .addSubcommand((s) =>
      s.setName('aggiungi').setDescription('Carica un suono (massimo 20 secondi e 2 MB)')
        .addAttachmentOption((o) => o.setName('file').setDescription('File audio: mp3, ogg, wav, m4a, opus, webm…').setRequired(true))
        .addStringOption((o) => o.setName('nome').setDescription('Nome del suono (se manca: il nome del file)').setMaxLength(NOME_MAX)),
    )
    .addSubcommand((s) =>
      s.setName('elimina').setDescription('Elimina un suono (tuo, oppure qualsiasi se sei admin)')
        .addStringOption((o) => o.setName('nome').setDescription('Nome del suono').setRequired(true).setAutocomplete(true).setMaxLength(100)),
    ),
].map((c) => c.toJSON());

/**
 * Legge un tempo scritto a mano: «90» (secondi), «1:30», «1:02:03». Restituisce i secondi o null.
 * Minuti e secondi dopo i due punti vanno da 0 a 59.
 */
export function parseTime(str) {
  const t = String(str ?? '').trim();
  if (/^\d{1,6}$/.test(t)) return Number(t);
  const m = /^(?:(\d{1,3}):)?(\d{1,3}):(\d{1,2})$/.exec(t);
  if (!m) return null;
  const [h, min, sec] = [Number(m[1] || 0), Number(m[2]), Number(m[3])];
  if (sec > 59 || (m[1] !== undefined && min > 59)) return null;
  return h * 3600 + min * 60 + sec;
}

/** Secondi → «1:30» o «1:02:03». */
export function formatTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const soloTe = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral });
const durata = (sec) => {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
};
const nomeBrano = (t) => escapeMarkdown(t.title || 'Titolo sconosciuto');

/** Canale vocale in cui si trova chi ha scritto il comando (null se non è in vocale). */
function canaleVocale(i) {
  return i.member?.voice?.channelId || i.guild?.voiceStates?.cache.get(i.user.id)?.channelId || null;
}

function nomeUtente(i) {
  return i.member?.displayName || i.member?.nick || i.user.globalName || i.user.username;
}

/**
 * Gestisce un'interazione di comando slash.
 * @param {import('discord.js').ChatInputCommandInteraction} i
 * @param {{ music: import('./music.js').MusicManager, notify?: (guildId: string, message: string) => void, isConnected?: (guildId: string) => boolean }} ctx
 */
export async function handleCommand(i, { music, notify = () => {}, isConnected = () => false, soundbar = null }) {
  if (!i.inGuild()) return soloTe(i, 'Usa i comandi dentro un server.');
  const g = music.get(i.guildId);
  const utente = nomeUtente(i);

  switch (i.commandName) {
    case 'play': {
      const testo = i.options.getString('brano', true).trim();
      const posizione = i.options.getString('dove') === 'prossimo' ? 'prossimo' : 'fine';
      const vocale = canaleVocale(i);
      if (!vocale) return soloTe(i, 'Entra prima in un canale vocale, poi usa /play.');
      if (g.current && g.channelId && g.channelId !== vocale && isConnected(i.guildId)) {
        return soloTe(i, `Sto già suonando in <#${g.channelId}>: entra lì per aggiungere brani.`);
      }
      await i.deferReply(); // yt-dlp può metterci qualche secondo
      try {
        const r = await g.add(testo, { channelId: vocale, user: utente, posizione });
        const t = r.tracks[0];
        const subito = g.current === t;
        const pos = g.queue.indexOf(t) + 1;
        const prossima = posizione === 'prossimo';
        const titolo = subito ? 'In riproduzione'
          : r.count > 1 ? `${prossima ? 'Come prossimi' : 'Aggiunti'}: ${r.count} brani`
          : prossima ? 'Riproduce dopo' : 'Aggiunto alla coda';
        const embed = new EmbedBuilder()
          .setColor(VERDE)
          .setAuthor({ name: titolo })
          .setTitle(nomeBrano(t).slice(0, 256))
          .setDescription(
            [t.author && escapeMarkdown(t.author), durata(t.duration), !subito && pos > 0 && `posizione ${pos}`, `richiesto da ${escapeMarkdown(utente)}`]
              .filter(Boolean)
              .join(' · '),
          );
        if (t.url && /^https?:\/\//.test(t.url)) embed.setURL(t.url);
        if (t.thumbnail) embed.setThumbnail(t.thumbnail);
        await i.editReply({ embeds: [embed] });
        notify(i.guildId, `${r.message} (da ${utente} con /play)`);
      } catch (err) {
        await i.deleteReply().catch(() => {});
        await i.followUp({ content: `Non riesco ad aggiungere «${testo.slice(0, 100)}»: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
      return undefined;
    }

    case 'stop': {
      // Esce anche a coda finita: conta la connessione vocale, non solo la coda.
      if (!g.current && !g.queue.length && !g.inVoice()) return soloTe(i, 'Non sono in nessun canale vocale.');
      g.stop();
      notify(i.guildId, `Musica fermata da ${utente} con /stop`);
      return i.reply('Fermato: coda svuotata, esco dal canale.');
    }

    case 'skip': {
      if (!g.current) return soloTe(i, 'Non sto suonando niente.');
      const saltato = g.current;
      g.skip();
      notify(i.guildId, `${utente} ha saltato «${saltato.title}» con /skip`);
      return i.reply(`Saltato: **${nomeBrano(saltato)}**${g.queue.length || g.loop !== 'off' ? '' : ' (la coda è finita)'}`);
    }

    case 'pausa': {
      if (!g.current && g.queue.length && !g.loading) {
        // Il bot era uscito (canale vuoto o scollegato): rientra e riparte dalla coda.
        const vocale = canaleVocale(i);
        if (!vocale) return soloTe(i, 'Entra prima in un canale vocale, poi usa /pausa per far ripartire la coda.');
        g.togglePause({ channelId: vocale });
        notify(i.guildId, `${utente} ha fatto ripartire la coda con /pausa`);
        return i.reply('Rientro nel canale e riparto dalla coda.');
      }
      if (!g.current) return soloTe(i, 'Non sto suonando niente.');
      if (g.loading) return soloTe(i, 'Sto ancora preparando l\'audio: riprova tra un attimo.');
      g.togglePause();
      notify(i.guildId, `${g.paused ? 'Pausa' : 'Ripresa'} da ${utente} con /pausa`);
      return i.reply(g.paused ? `In pausa: **${nomeBrano(g.current)}**` : `Riprendo: **${nomeBrano(g.current)}**`);
    }

    case 'coda': {
      if (!g.current && !g.queue.length) return soloTe(i, 'La coda è vuota. Aggiungi un brano con /play.');
      return soloTe(i, testoCoda(g));
    }

    case 'vai': {
      const r = vai(g, i.options.getString('tempo', true));
      if (!r.ok) return soloTe(i, r.text);
      notify(i.guildId, `${utente} è andato a ${formatTime(g.position())} con /vai`);
      return i.reply(r.text);
    }

    case 'precedente': {
      const vocale = canaleVocale(i);
      if (!g.current && !vocale) return soloTe(i, 'Entra prima in un canale vocale, poi usa /precedente.');
      const r = precedente(g, vocale);
      if (!r.ok) return soloTe(i, r.text);
      notify(i.guildId, `${utente} ${r.restarted ? 'ha fatto ricominciare il brano' : 'è tornato al brano precedente'} con /precedente`);
      return i.reply(r.text);
    }

    case 'suono':
      return comandoSuono(i, { g, utente, notify, soundbar });

    default:
      return soloTe(i, 'Comando sconosciuto.');
  }
}

// ---------- /suono (Soundbar) ----------
const secondi = (d) => `${(Number(d) || 0).toFixed(1).replace('.', ',')} s`;

/** Suono dal valore dell'opzione: id (scelto dai suggerimenti) oppure nome scritto a mano. */
function trovaSuono(library, guildId, valore) {
  const v = String(valore ?? '').trim();
  const lista = library.all(guildId);
  return lista.find((s) => s.id === v) ??
    lista.find((s) => s.name.localeCompare(v, 'it', { sensitivity: 'base' }) === 0) ?? null;
}

/**
 * /suono suona | aggiungi | elimina. soundbar = { library, converti, limitatore, maxMb,
 * permesso(guildId, userId) → { isAdmin, puoCaricare }, onCambio(guildId) }.
 */
async function comandoSuono(i, { g, utente, notify, soundbar }) {
  if (!soundbar) return soloTe(i, 'La Soundbar non è disponibile.');
  const { library } = soundbar;
  const sub = i.options.getSubcommand();
  const chi = { id: i.user.id, name: utente };

  if (sub === 'suona') {
    const s = trovaSuono(library, i.guildId, i.options.getString('nome', true));
    if (!s) return soloTe(i, 'Suono non trovato: scegli un nome dai suggerimenti.');
    const vocale = canaleVocale(i);
    if (!vocale && !g.inVoice()) return soloTe(i, 'Entra prima in un canale vocale, poi usa /suono suona.');
    const attesa = soundbar.limitatore.attesa(i.guildId, i.user.id);
    if (attesa > 0) return soloTe(i, pianoMsg(attesa));
    try {
      const r = await g.suona(s, { file: library.daSuonare(i.guildId, s), by: utente, channelId: vocale });
      return soloTe(i, r.prova ? `Suonato «${s.name}» (solo in Discord)` : `Suono: **${escapeMarkdown(s.name)}**`);
    } catch (err) {
      return soloTe(i, err.message);
    }
  }

  if (sub === 'aggiungi') {
    const p = await soundbar.permesso(i.guildId, i.user.id);
    if (!p.puoCaricare) return soloTe(i, 'Serve il ruolo Soundbar per caricare suoni.');
    const file = i.options.getAttachment('file', true);
    const limite = soundbar.maxMb * 1024 * 1024;
    if (file.size > limite) return soloTe(i, `File troppo grande (massimo ${soundbar.maxMb} MB).`);
    const nome = i.options.getString('nome')?.trim() || String(file.name || 'suono').replace(/\.[^.]+$/, '').replace(/_+/g, ' ').slice(0, NOME_MAX);
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const r = await fetch(file.url, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new SoundError('Non riesco a scaricare l\'allegato da Discord', 'formato');
      const buffer = Buffer.from(await r.arrayBuffer());
      if (buffer.length > limite) throw new SoundError(`File troppo grande (massimo ${soundbar.maxMb} MB)`, 'troppo_grande');
      const s = await library.carica(i.guildId, { name: nome, user: chi, buffer, converti: soundbar.converti });
      await i.editReply(`Caricato **${escapeMarkdown(s.name)}** (${secondi(s.duration)}). Suonalo con /suono suona o dall'Activity.`);
      notify(i.guildId, `${utente} ha caricato «${s.name}»`);
      soundbar.onCambio?.(i.guildId);
    } catch (err) {
      const testo = err instanceof SoundError ? err.message : `Caricamento non riuscito: ${err.message}`;
      await i.editReply(testo).catch(() => {});
    }
    return undefined;
  }

  if (sub === 'elimina') {
    const s = trovaSuono(library, i.guildId, i.options.getString('nome', true));
    if (!s) return soloTe(i, 'Suono non trovato: scegli un nome dai suggerimenti.');
    const p = await soundbar.permesso(i.guildId, i.user.id);
    try {
      await library.elimina(i.guildId, { id: s.id, user: { ...chi, isAdmin: p.isAdmin } });
    } catch (err) {
      return soloTe(i, err.message);
    }
    if (g.suoni?.attivo?.id === s.id) g.suoni.interrompi();
    notify(i.guildId, `${utente} ha eliminato il suono «${s.name}»`);
    soundbar.onCambio?.(i.guildId);
    return soloTe(i, `Eliminato «${escapeMarkdown(s.name)}».`);
  }
  return soloTe(i, 'Comando sconosciuto.');
}

/** Suggerimenti per /suono suona e /suono elimina: fino a 25 suoni il cui nome contiene il testo. */
export async function handleAutocomplete(i, { soundbar = null } = {}) {
  if (i.commandName !== 'suono' || !soundbar || !i.inGuild?.()) return i.respond([]);
  const testo = String(i.options.getFocused() ?? '').toLocaleLowerCase('it');
  let lista = soundbar.library.all(i.guildId);
  if (i.options.getSubcommand(false) === 'elimina') {
    const p = await soundbar.permesso(i.guildId, i.user.id).catch(() => ({ isAdmin: false }));
    if (!p.isAdmin) lista = lista.filter((s) => s.createdBy?.id === i.user.id);
  }
  const scelte = lista
    .filter((s) => !testo || s.name.toLocaleLowerCase('it').includes(testo))
    .slice(0, 25)
    .map((s) => ({ name: `${s.name} · ${secondi(s.duration)}`.slice(0, 100), value: s.id }));
  return i.respond(scelte);
}

/** /vai e «vai 1:30»: restituisce il testo della risposta e se è andato a buon fine. */
function vai(g, testo) {
  const sec = parseTime(testo);
  if (sec === null) return { ok: false, text: `Non capisco «${String(testo).slice(0, 20)}»: scrivi per esempio 1:30, 90 o 1:02:03.` };
  if (!g.current) return { ok: false, text: 'Non sto suonando niente.' };
  const d = g.current.duration;
  if (Number.isFinite(d) && d > 0 && sec >= d) {
    return { ok: false, text: `Il brano dura ${formatTime(d)}: scegli un tempo più corto.` };
  }
  const r = g.seek(sec);
  if (!r.ok) return { ok: false, text: r.reason };
  return { ok: true, text: `Vado a ${formatTime(r.pos)} di **${nomeBrano(g.current)}**` };
}

/** /precedente e «indietro»: ricomincia il brano o torna a quello prima. */
function precedente(g, channelId) {
  const r = g.previous({ channelId });
  if (!r.ok) return { ok: false, text: r.reason };
  return {
    ok: true,
    restarted: r.restarted,
    text: r.restarted ? `Ricomincio: **${nomeBrano(r.track)}**` : `Torno a: **${nomeBrano(r.track)}**`,
  };
}

/** Brano in corso e prossimi 10, per /coda e per «coda» in chat. */
function testoCoda(g) {
  const righe = [];
  if (g.current) righe.push(`**Ora:** ${nomeBrano(g.current)}${g.paused ? ' (in pausa)' : ''}`);
  g.queue.slice(0, 10).forEach((t, n) => {
    const d = durata(t.duration);
    righe.push(`${n + 1}. ${nomeBrano(t)}${d ? ` · ${d}` : ''}`);
  });
  if (g.queue.length > 10) righe.push(`…e altri ${g.queue.length - 10}`);
  if (!g.queue.length) righe.push(g.current ? 'Nessun brano dopo questo.' : '');
  return righe.join('\n').trim().slice(0, 1900);
}

// ---------- messaggi in chat ----------
// Parole brevi che, da sole, sono comandi (in un canale musica o dopo la menzione del bot).
const PAROLE = {
  skip: 'skip', salta: 'skip',
  pausa: 'pausa',
  riprendi: 'riprendi',
  stop: 'stop',
  coda: 'coda',
  indietro: 'precedente', precedente: 'precedente',
};

/**
 * «Salta!» → { command: 'skip' }; «vai 1:30» → { command: 'vai', arg: '1:30' };
 * «dopo vasco albachiara» → { query: 'vasco albachiara', posizione: 'prossimo' }; altro testo → { query }.
 */
export function parseText(text) {
  const t = String(text || '').trim();
  const dopo = /^dopo\s+(\S[\s\S]*)$/i.exec(t);
  if (dopo) return { query: dopo[1].trim(), posizione: 'prossimo' };
  const parola = t.toLowerCase().replace(/[.!?…\s]+$/u, '');
  if (Object.hasOwn(PAROLE, parola)) return { command: PAROLE[parola] };
  const vai = /^vai\s+(?:a\s+)?(\d[\d:]*)$/i.exec(parola);
  if (vai) return { command: 'vai', arg: vai[1] };
  return { query: t };
}

const AIUTO = 'Scrivimi un link o un titolo da mettere in coda («dopo <titolo>» per metterlo come prossimo), oppure: skip, pausa, riprendi, stop, coda, indietro, vai 1:30.';

/**
 * Gestisce un messaggio in chat (canale musica o menzione del bot), con la stessa coda della GUI.
 * @param {{ guildId: string, text: string, user: string, voiceChannelId: string|null,
 *   botChannelId: string|null, humansInBotChannel: number|null,
 *   reply: (content: string) => Promise<unknown>, react: (emoji: string) => Promise<unknown> }} ctx
 * @param {{ music: import('./music.js').MusicManager, notify?: (guildId: string, message: string) => void }} deps
 */
export async function handleTextMessage(ctx, { music, notify = () => {} }) {
  const { guildId, user, voiceChannelId, botChannelId, humansInBotChannel } = ctx;
  const reply = (content) => Promise.resolve(ctx.reply(content)).catch(() => {});
  const react = () => Promise.resolve(ctx.react('🎵')).catch(() => {});
  const g = music.get(guildId);
  const { command, query, arg, posizione = 'fine' } = parseText(ctx.text);

  if (!command && !query) return reply(AIUTO);

  /**
   * Il bot entra nel canale di chi scrive, salvo che sia già in un altro canale con persone dentro.
   * Restituisce false (dopo aver risposto) se non si può.
   */
  const preparaCanale = async () => {
    if (!voiceChannelId) {
      await reply('Entra in un canale vocale e riscrivi.');
      return false;
    }
    if (botChannelId && botChannelId !== voiceChannelId) {
      if (humansInBotChannel) {
        await reply(`Sono già in <#${botChannelId}> con altre persone: entra lì per usarmi.`);
        return false;
      }
      await g.moveTo(voiceChannelId); // canale vuoto: vengo da te
    }
    return true;
  };

  switch (command) {
    case 'skip': {
      if (!g.current) return reply('Non sto suonando niente.');
      const saltato = g.current;
      g.skip();
      notify(guildId, `${user} ha saltato «${saltato.title}» in chat`);
      return reply(`Saltato: **${nomeBrano(saltato)}**`);
    }
    case 'pausa': {
      if (!g.current) return reply('Non sto suonando niente.');
      if (g.loading) return reply('Sto ancora preparando l\'audio: riprova tra un attimo.');
      if (g.paused) return reply('È già in pausa: scrivi «riprendi».');
      g.togglePause();
      notify(guildId, `Pausa da ${user} in chat`);
      return reply(`In pausa: **${nomeBrano(g.current)}**`);
    }
    case 'riprendi': {
      if (g.current) {
        if (g.loading) return reply('Sto ancora preparando l\'audio: riprova tra un attimo.');
        if (!g.paused) return reply('Sta già suonando.');
        g.togglePause();
        notify(guildId, `Ripresa da ${user} in chat`);
        return reply(`Riprendo: **${nomeBrano(g.current)}**`);
      }
      if (!g.queue.length) return reply('Non c\'è niente da riprendere: scrivi un titolo o un link.');
      if (!(await preparaCanale())) return undefined;
      g.togglePause({ channelId: voiceChannelId });
      notify(guildId, `${user} ha fatto ripartire la coda in chat`);
      return reply('Riparto dalla coda.');
    }
    case 'stop': {
      if (!g.current && !g.queue.length && !g.inVoice()) return reply('Non sono in nessun canale vocale.');
      g.stop();
      notify(guildId, `Musica fermata da ${user} in chat`);
      return reply('Fermato: coda svuotata, esco dal canale.');
    }
    case 'coda': {
      if (!g.current && !g.queue.length) return reply('La coda è vuota. Scrivi un titolo o un link.');
      return reply(testoCoda(g));
    }
    case 'vai': {
      const r = vai(g, arg);
      if (r.ok) notify(guildId, `${user} è andato a ${formatTime(g.position())} in chat`);
      return reply(r.text);
    }
    case 'precedente': {
      if (!g.current && g.history.length && !(await preparaCanale())) return undefined;
      const r = precedente(g, voiceChannelId);
      if (r.ok) notify(guildId, `${user} ${r.restarted ? 'ha fatto ricominciare il brano' : 'è tornato al brano precedente'} in chat`);
      return reply(r.text);
    }
    default:
  }

  // Link o testo da cercare
  if (!(await preparaCanale())) return undefined;
  let r;
  try {
    r = await g.add(query, { channelId: voiceChannelId, user, posizione });
  } catch (err) {
    return reply(`Non riesco ad aggiungere «${query.slice(0, 100)}»: ${err.message}`);
  }
  const t = r.tracks[0];
  const subito = g.current === t;
  const pos = g.queue.indexOf(t) + 1;
  await react();
  notify(guildId, `${r.message} (da ${user} in chat)`);
  const prossima = posizione === 'prossimo';
  if (r.count > 1) return reply(`${prossima && !subito ? 'Come prossimi' : 'Aggiunti'} ${r.count} brani, a partire da **${nomeBrano(t)}**`);
  if (subito) return reply(`In riproduzione: **${nomeBrano(t)}**`);
  return reply(`${prossima ? 'Riproduce dopo' : 'In coda'}: **${nomeBrano(t)}**${pos > 0 ? ` (posizione ${pos})` : ''}`);
}
