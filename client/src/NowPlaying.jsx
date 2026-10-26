import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { suggerimento } from './Suggerimento.jsx';
import { thumbUrl } from './connection.js';
import { formatTime } from './format.js';
import * as I from './icons.jsx';
import { H_PLAYER } from './Panels.jsx';

export const LOOP_INFO = {
  off: { label: 'Ripeti: no', next: 'queue', Icon: I.Repeat },
  queue: { label: 'Ripeti: coda', next: 'track', Icon: I.Repeat },
  track: { label: 'Ripeti: brano', next: 'off', Icon: I.RepeatOne },
};

export function Cover({ src, size = 'lg' }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (!src || broken) {
    const px = size === 'lg' ? 56 : size === 'md' ? 26 : 20;
    return (
      <div className={`cover cover--${size} cover--empty`} aria-hidden="true">
        <I.Note width={px} height={px} />
      </div>
    );
  }
  // Le miniature dei video sono 16:9: dentro il quadrato si vedono intere, con lo sfondo sfocato.
  return (
    <div className={`cover cover--${size} cover--framed`}>
      {size !== 'sm' && <img className="cover__blur" src={thumbUrl(src)} alt="" aria-hidden="true" />}
      <img
        className={size === 'sm' ? 'cover__fill' : 'cover__img'}
        src={thumbUrl(src)}
        alt=""
        loading={size === 'sm' ? 'lazy' : undefined}
        onError={() => setBroken(true)}
      />
    </div>
  );
}

export function useLivePosition(state, receivedAt) {
  const [now, setNow] = useState(() => performance.now());
  // Durante un suono della Soundbar la musica è ferma: la barra del tempo non scorre.
  const running = state?.current && !state.paused && !state.loading && !state.suono;
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(id);
  }, [running]);
  if (!state?.current) return 0;
  const base = state.position || 0;
  return running ? base + Math.max(0, (now - receivedAt) / 1000) : base;
}

/**
 * Volume condiviso dal cursore orizzontale e dal fader verticale: aggiorna subito il controllo e invia al
 * server `{ type: 'volume', value }` solo dopo 120 ms senza altri cambi (un trascinamento = pochi messaggi).
 */
function useVolume(state, send) {
  const [vol, setVol] = useState(state?.volume ?? 60);
  const dragging = useRef(false);
  const sendTimer = useRef(null);
  const lastOn = useRef(60);
  useEffect(() => {
    if (!dragging.current && state) setVol(state.volume);
  }, [state?.volume]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(sendTimer.current), []);
  const onVolume = (v) => {
    setVol(v);
    if (v > 0) lastOn.current = v;
    clearTimeout(sendTimer.current);
    sendTimer.current = setTimeout(() => send({ type: 'volume', value: v }), 120);
  };
  const toggleMute = () => onVolume(vol > 0 ? 0 : lastOn.current);
  return { vol, onVolume, toggleMute, dragging };
}

function MuteButton({ vol, onClick }) {
  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm"
      onClick={onClick}
      aria-label={vol > 0 ? 'Muto' : 'Riattiva audio'}
      {...suggerimento(vol > 0 ? 'Muto' : 'Riattiva audio')}
    >
      {vol > 0 ? <I.Volume /> : <I.VolumeOff />}
    </button>
  );
}

const FADER_CAP = 14; // altezza del cappuccio: il suo centro corre da 7 px sopra il fondo a 7 px sotto la cima

/**
 * Volume verticale, come il fader di una console da DJ: binario sottile, riempimento dal basso, cappuccio
 * da trascinare. Il valore viene sempre dalla posizione assoluta del puntatore sul binario (mai sommando
 * spostamenti), col puntatore catturato. Clic sul binario = salto lì; rotella ±5; frecce ±5, PagSu/PagGiù ±10,
 * Home 0, Fine 100. Sopra la percentuale, sotto l'altoparlante (muto / ripristina).
 */
export function Fader({ state, send }) {
  const { vol, onVolume, toggleMute, dragging } = useVolume(state, send);
  const [held, setHeld] = useState(false);
  const hitRef = useRef(null);
  const volRef = useRef(vol);
  volRef.current = vol;
  const onVolumeRef = useRef(onVolume);
  onVolumeRef.current = onVolume;

  const fromY = (y) => {
    const r = hitRef.current.getBoundingClientRect();
    const span = Math.max(1, r.height - FADER_CAP);
    return clamp(Math.round(((r.bottom - FADER_CAP / 2 - y) / span) * 100), 0, 100);
  };
  const end = () => {
    dragging.current = false;
    setHeld(false);
  };
  const onPointerDown = (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // puntatore già rilasciato
    }
    e.currentTarget.focus();
    dragging.current = true;
    setHeld(true);
    onVolume(fromY(e.clientY));
  };
  const onPointerMove = (e) => {
    if (dragging.current) onVolume(fromY(e.clientY));
  };
  const onKeyDown = (e) => {
    const v = volRef.current;
    const next = {
      ArrowUp: v + 5, ArrowRight: v + 5, ArrowDown: v - 5, ArrowLeft: v - 5,
      PageUp: v + 10, PageDown: v - 10, Home: 0, End: 100,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    onVolume(clamp(next, 0, 100));
  };
  // La rotella va presa con un ascoltatore non passivo, se no la pagina (o il pannello) scorre.
  useEffect(() => {
    const el = hitRef.current;
    if (!el) return undefined;
    const wheel = (e) => {
      if (!e.deltaY) return;
      e.preventDefault();
      onVolumeRef.current(clamp(volRef.current + (e.deltaY < 0 ? 5 : -5), 0, 100));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const k = vol / 100;
  return (
    <div className={`fader ${held ? 'is-held' : ''}`}>
      <span className="fader__val" aria-hidden="true">{vol}%</span>
      <div
        ref={hitRef}
        className="fader__hit"
        role="slider"
        tabIndex={0}
        aria-label="Volume"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={vol}
        aria-valuetext={`${vol}%`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onKeyDown={onKeyDown}
      >
        <span className="fader__rail" aria-hidden="true" />
        <span className="fader__fill" style={{ height: `calc(${FADER_CAP / 2}px + (100% - ${FADER_CAP}px) * ${k})` }} aria-hidden="true" />
        <span className="fader__cap" style={{ bottom: `calc((100% - ${FADER_CAP}px) * ${k})` }} aria-hidden="true" />
      </div>
      <MuteButton vol={vol} onClick={toggleMute} />
    </div>
  );
}

/** Volume orizzontale (lettore verticale e telefono). */
export function Volume({ state, send, className = '' }) {
  const { vol, onVolume, toggleMute, dragging } = useVolume(state, send);
  return (
    <div className={`volume ${className}`}>
      <MuteButton vol={vol} onClick={toggleMute} />
      <input
        type="range"
        className="range"
        min="0"
        max="100"
        step="1"
        value={vol}
        aria-label="Volume"
        aria-valuetext={`${vol}%`}
        style={{ '--val': `${vol}%` }}
        onPointerDown={() => (dragging.current = true)}
        onPointerUp={() => (dragging.current = false)}
        onChange={(e) => onVolume(Number(e.target.value))}
      />
      <span className="volume__value">{vol}%</span>
    </div>
  );
}

/** Secondi che mancano all'uscita automatica dal canale, aggiornati ogni secondo. */
export function useLeaveCountdown(state, receivedAt) {
  const [now, setNow] = useState(() => performance.now());
  const active = state?.leaveIn != null;
  useEffect(() => {
    if (!active) return undefined;
    setNow(performance.now());
    const id = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(id);
  }, [active, receivedAt]);
  if (!active) return null;
  return Math.max(0, Math.ceil(state.leaveIn - (now - receivedAt) / 1000));
}

/** Avviso sullo stato del bot nel canale vocale (canale vuoto, inattività, uscito). */
export function presenceText(state, leaveIn) {
  if (state?.leaveReason === 'empty' && leaveIn != null) {
    return `${state.current ? 'In pausa: canale' : 'Canale'} vuoto, esco tra ${leaveIn} s`;
  }
  if (state?.leaveReason === 'idle' && leaveIn != null) {
    return `Coda finita: esco dal canale tra ${formatTime(leaveIn)}`;
  }
  if (state?.away && !state.current) return 'Il bot è uscito: premi play per farlo rientrare';
  return null;
}

const PASSO_FRECCE = 5; // secondi per ogni freccia sulla barra
const ATTESA_FRECCE_MS = 400; // le frecce premute di fila diventano un solo spostamento
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/**
 * Barra di avanzamento cliccabile e trascinabile (role="slider"). Mentre si trascina mostra il tempo
 * di arrivo; al rilascio chiede al server di spostarsi. Frecce ±5 s, Home/Fine inizio e fine.
 */
function Progress({ current, disabled = false, pos, dur, send, onSeek, inline = false }) {
  const trackRef = useRef(null);
  const [drag, setDrag] = useState(null); // secondi in anteprima mentre si trascina
  const [keyPos, setKeyPos] = useState(null); // secondi scelti con le frecce, non ancora inviati
  const keyTimer = useRef(null);
  useEffect(() => () => clearTimeout(keyTimer.current), []);
  useEffect(() => {
    // Brano cambiato: niente anteprime rimaste dal brano prima.
    setDrag(null);
    setKeyPos(null);
    clearTimeout(keyTimer.current);
  }, [current?.id]);

  const seekable = Boolean(current && dur > 1 && !current.live && !disabled);
  const max = Math.max(0, Math.floor(dur) - 1);
  const shown = drag ?? keyPos ?? pos;
  const pct = dur ? Math.min(100, (shown / dur) * 100) : 0;

  const fromPointer = (e) => {
    const r = trackRef.current.getBoundingClientRect();
    return clamp(((e.clientX - r.left) / (r.width || 1)) * dur, 0, max);
  };
  const commit = (sec) => {
    const s = clamp(Math.round(sec), 0, max);
    onSeek(s);
    send({ type: 'seek', position: s });
  };

  const onPointerDown = (e) => {
    if (!seekable || e.button > 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.focus();
    setDrag(fromPointer(e));
  };
  const onPointerMove = (e) => drag !== null && setDrag(fromPointer(e));
  const onPointerUp = (e) => {
    if (drag === null) return;
    commit(fromPointer(e));
    setDrag(null);
  };
  const onKeyDown = (e) => {
    if (!seekable) return;
    const base = keyPos ?? pos;
    const next = {
      ArrowLeft: base - PASSO_FRECCE, ArrowDown: base - PASSO_FRECCE,
      ArrowRight: base + PASSO_FRECCE, ArrowUp: base + PASSO_FRECCE,
      Home: 0, End: max,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const v = clamp(next, 0, max);
    setKeyPos(v);
    clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(() => {
      commit(v);
      setKeyPos(null);
    }, ATTESA_FRECCE_MS);
  };

  const label = `${formatTime(shown)} di ${dur ? formatTime(dur) : 'diretta'}`;
  return (
    <div className={`np__progress ${inline ? 'np__progress--inline' : ''} ${seekable ? 'is-seekable' : ''} ${drag !== null ? 'is-dragging' : ''}`}>
      <div
        className="progress__hit"
        role="slider"
        tabIndex={seekable ? 0 : -1}
        aria-label="Posizione nel brano"
        aria-disabled={!seekable}
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={label}
        title={current && (!(dur > 1) || current.live) ? 'Questo brano non ha una durata: non ci si può spostare' : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={onKeyDown}
      >
        <div className="progress__track" ref={trackRef}>
          <div className="progress__fill" style={{ width: `${pct}%` }} />
        </div>
        {seekable && <span className="progress__thumb" style={{ left: `${pct}%` }} aria-hidden="true" />}
        {drag !== null && (
          <span className="progress__bubble" style={{ left: `${pct}%` }} aria-hidden="true">{formatTime(drag)}</span>
        )}
      </div>
      <div className="progress__times">
        <span>{formatTime(current ? shown : 0)}</span>
        <span>{current ? (dur ? formatTime(dur) : 'diretta') : '0:00'}</span>
      </div>
    </div>
  );
}

/**
 * Posizione mostrata subito dopo uno spostamento, prima che il server confermi
 * (si toglie quando lo stato del server arriva vicino al punto scelto, o dopo 4 s).
 */
function useSeekOverride(state, receivedAt, livePos) {
  const [override, setOverride] = useState(null); // { pos, at, id }
  const [, tick] = useState(0);
  useEffect(() => {
    if (!override) return;
    const vicino = state?.current?.id === override.id && Math.abs((state.position || 0) - override.pos) < 3;
    if (vicino || state?.current?.id !== override.id || performance.now() - override.at > 4000) setOverride(null);
  }, [receivedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!override) return undefined;
    const id = setTimeout(() => setOverride(null), 4000);
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => { clearTimeout(id); clearInterval(t); };
  }, [override]);
  const running = state?.current && !state.paused;
  const pos = override
    ? override.pos + (running ? Math.max(0, (performance.now() - override.at) / 1000) : 0)
    : livePos;
  const onSeek = (s) => setOverride({ pos: s, at: performance.now(), id: state?.current?.id });
  return [pos, onSeek];
}


/** Triangolo dell'avviso giallo. */
const Warn = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 3 2 20h20L12 3Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <path d="M12 10v4M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

/**
 * Variante del lettore secondo la forma dello spazio che ha: più largo che alto (e largo almeno H_PLAYER)
 * → orizzontale, altrimenti verticale. Misura il contenitore con un ResizeObserver, prima del disegno.
 */
function useShape(on) {
  const ref = useRef(null);
  const [shape, setShape] = useState('v');
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) return undefined;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setShape(w >= H_PLAYER && w > h ? 'h' : 'v');
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [on]);
  return [ref, shape];
}

/**
 * Lettore. `layout`: 'auto' (dentro un pannello: orizzontale o verticale secondo la forma del pannello),
 * 'h' orizzontale, 'v' verticale, 'm' compatto (telefono).
 * `bare`: dentro un pannello (niente cornice). Senza brano in corso ma con la coda piena mostra il primo in coda come «Prossimo».
 */
export default function NowPlaying({ state, receivedAt, send, layout = 'v', bare = false }) {
  const auto = layout === 'auto';
  const [fitRef, shape] = useShape(auto);
  const variant = auto ? shape : layout;
  // Con 'auto' il lettore sta in un contenitore che riempie il pannello: lo misura useShape e le regole
  // CSS (container query) lo usano per scalare copertina, spazi e fader.
  const wrap = (node) => (auto ? <div className="np-fit" ref={fitRef}>{node}</div> : node);
  const card = bare ? '' : 'card ';
  const current = state?.current;
  const livePos = useLivePosition(state, receivedAt);
  const [pos, onSeek] = useSeekOverride(state, receivedAt, livePos);
  const dur = current?.duration || 0;
  const hasHistory = (state?.history?.length || 0) > 0;
  const queueLen = state?.queue?.length || 0;
  const playing = current && !state?.paused;
  const leaveIn = useLeaveCountdown(state, receivedAt);
  const presence = presenceText(state, leaveIn);
  // Senza brano in corso ma con la coda piena (es. bot uscito), play fa ripartire la coda.
  const canPlay = (current || queueLen > 0) && !state?.loading;
  const next = !current && queueLen ? state.queue[0] : null;
  const shown = current || next;

  const eyebrow = current
    ? state.loading ? 'Preparo l’audio…' : state.paused ? 'In pausa' : 'In riproduzione'
    : next ? 'Prossimo' : 'Niente in riproduzione';
  const title = shown?.title || 'Metti su qualcosa';
  const sub = shown
    ? [shown.author || 'Autore sconosciuto', shown.requestedBy && `richiesto da ${shown.requestedBy}`].filter(Boolean).join(' · ')
    : 'Cerca un brano o incolla un link qui sopra';

  const art = (
    <div className="np__art">
      <Cover src={shown?.thumbnail} size="lg" />
      {state?.loading && <div className="np__loading"><span className="spinner" aria-hidden="true" /></div>}
    </div>
  );
  const suonoTag = state?.suono && (
    <p className="np__suono" role="status" title={`Suono in corso: ${state.suono.name}`}>
      <I.Wave width={16} height={16} />
      <span className="one">Suono: {state.suono.name}</span>
    </p>
  );
  const meta = (
    <div className="np__meta">
      {suonoTag || <p className="np__eyebrow">{eyebrow}</p>}
      <h1 className="np__title" title={title}>{title}</h1>
      <p className="np__artist" title={sub}>{sub}</p>
    </div>
  );
  const warn = presence && (
    <p className="warn" role="status"><Warn />{presence}</p>
  );
  const progress = (
    <Progress current={current} disabled={Boolean(state?.loading)} pos={pos} dur={dur} send={send} onSeek={onSeek} inline={variant === 'h'} />
  );
  const btn = (type, Icon, label, disabled, extra = {}) => (
    <button type="button" className={`icon-btn ${extra.on ? 'is-on' : ''}`} onClick={() => send(extra.msg || { type })} disabled={disabled} aria-label={label} {...suggerimento(extra.title || label)}>
      <Icon />
    </button>
  );
  const buttons = (
    <>
      {btn('precedente', I.Prev, 'Indietro: ricomincia il brano o torna a quello prima', (!current && !hasHistory) || state?.loading, { title: 'Indietro' })}
      <button
        type="button"
        className="big-play"
        onClick={() => send({ type: 'toggle' })}
        disabled={!canPlay}
        aria-label={playing ? 'Pausa' : 'Riproduci'}
        {...suggerimento(playing ? 'Pausa' : state?.away && !current ? 'Fai rientrare il bot e riprendi' : 'Riproduci')}
      >
        {playing ? <I.Pause width={24} height={24} /> : <I.Play width={24} height={24} />}
      </button>
      {btn('skip', I.Next, 'Salta al prossimo brano', !current, { title: 'Salta' })}
    </>
  );
  // Shuffle e Ripeti stanno nella testata della coda (QueueTools in Queue.jsx).
  const controls = <div className="np__controls">{buttons}</div>;

  // Orizzontale, a tutta altezza del pannello: copertina quadrata che scala con l'altezza · testo, avanzamento
  // e comandi centrati in verticale · fader del volume a destra, alto quanto il pannello.
  if (variant === 'h') {
    return wrap(
      <section className={`${card}np np--h`} aria-label="In riproduzione">
        {art}
        <div className="np__body">
          {meta}
          {warn}
          <div className="np__deck">
            {progress}
            {controls}
          </div>
        </div>
        <Fader state={state} send={send} />
      </section>,
    );
  }
  if (layout === 'm') {
    return (
      <section className={`${card}np np--m`} aria-label="In riproduzione">
        <div className="np__row">{art}{meta}</div>
        {warn}
        {progress}
        {controls}
      </section>
    );
  }
  return wrap(
    <section className={`${card}np np--v`} aria-label="In riproduzione">
      {warn}
      <div className="np__artbox">{art}</div>
      {meta}
      {progress}
      {controls}
      <div className="np__bottom">
        <Volume state={state} send={send} className="np__volume" />
      </div>
    </section>,
  );
}

/** Ferma ed esci: azione di sessione, accanto allo stato del bot (non tra i comandi del brano). */
export function StopButton({ state, send, wide = false }) {
  const disabled = !state?.current && !state?.queue?.length && !state?.inVoice;
  return (
    <button
      type="button"
      className={wide ? 'btn btn--danger' : 'icon-btn icon-btn--sm icon-btn--danger'}
      onClick={() => send({ type: 'stop' })}
      disabled={disabled}
      aria-label="Ferma e fai uscire il bot"
      {...(wide ? {} : suggerimento('Ferma ed esci'))}
    >
      <I.Stop width={wide ? 14 : 18} height={wide ? 14 : 18} />
      {wide && 'Ferma ed esci'}
    </button>
  );
}
