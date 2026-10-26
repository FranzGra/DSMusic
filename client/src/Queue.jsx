import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { suggerimento } from './Suggerimento.jsx';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Cover, LOOP_INFO } from './NowPlaying.jsx';
import { formatTime, totalDuration } from './format.js';
import * as I from './icons.jsx';
import './queue-now.css';
import './queue-head.css';
import './coda.css';

// Nella vista a una colonna la riga trascinata si muove solo in verticale (equivale a restrictToVerticalAxis,
// che qui non è installato). Con due colonne resta libera, per poter passare da una colonna all'altra.
const verticalOnly = ({ transform }) => ({ ...transform, x: 0 });

// Dalle azioni della riga (Sposta in cima, Rimuovi, Salta) non parte mai un trascinamento.
const fromActions = (e) => Boolean(e.target?.closest?.('.qrow__acts'));

/**
 * Mouse e penna: il trascinamento parte da qualsiasi punto della riga dopo 5 px di movimento; un clic
 * fermo resta un clic (riproduci ora). Il dito lo gestisce RowTouchSensor, solo dalla maniglia.
 */
class RowPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown',
      handler: ({ nativeEvent: e }, { onActivation }) => {
        if (e.pointerType === 'touch' || !e.isPrimary || e.button !== 0 || fromActions(e)) return false;
        onActivation?.({ event: e });
        return true;
      },
    },
  ];
}

/**
 * Dito: si trascina SOLO dalla maniglia ⋮⋮ (touch-action: none, parte subito). Dal resto della riga il dito
 * scorre la pagina e un tocco fermo riproduce. Prima bastava tenere la riga ferma 250 ms: su iPhone, in
 * Discord, ogni scorrimento che partiva lento diventava un trascinamento (riga evidenziata, pagina ferma).
 */
class RowTouchSensor extends TouchSensor {
  static activators = [
    {
      eventName: 'onTouchStart',
      handler: ({ nativeEvent: e }, { onActivation }) => {
        if (e.touches.length > 1 || fromActions(e) || !e.target?.closest?.('.qrow__grip')) return false;
        onActivation?.({ event: e });
        return true;
      },
    },
  ];
}

/**
 * Riga densa della coda: maniglia | # | copertina | «Titolo · Autore» | richiesto da | durata | azioni.
 * Maniglia e azioni si vedono solo col mouse sopra (o col fuoco). Clic sul resto = riproduci ora.
 */
function Row({ track, number, first, fresh, onPlay, onRemove, onTop }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: track.id });
  const style = { transform: CSS.Translate.toString(transform), transition };
  // Col mouse si trascina tutta la riga; col dito solo la maniglia (RowTouchSensor). La tastiera (spazio + frecce)
  // resta sulla maniglia, così Invio e spazio sul pulsante della riga continuano a riprodurre.
  const rowListeners = listeners ? { onPointerDown: listeners.onPointerDown } : undefined;
  return (
    <li ref={setNodeRef} style={style} className={`qrow qrow2 qrow--drag ${isDragging ? 'is-dragging' : ''} ${fresh ? 'qrow--fresh' : ''}`} {...rowListeners}>
      {/* Pulsante vero sotto tutta la riga: tastiera, lettori di schermo e clic col mouse. */}
      <button type="button" className="qrow__btn" onClick={() => onPlay(track.id)} aria-label={`Riproduci ora «${track.title}»`} />
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="qrow__grip"
        aria-label={`Sposta «${track.title}». Trascina, oppure premi spazio e usa le frecce`}
        // Coda stretta: la maniglia sta sopra la copertina (coda.css, --grip-play) e un clic fermo col mouse
        // riproduce, come il resto della riga. Dalla tastiera (detail 0) spazio e Invio restano per spostare.
        onClick={(e) => {
          if (e.detail > 0 && getComputedStyle(e.currentTarget).getPropertyValue('--grip-play').trim() === '1') onPlay(track.id);
        }}
        {...suggerimento('Trascina per spostare')}
        {...attributes}
        {...listeners}
      >
        <I.Grip width={24} height={24} />
      </button>
      <span className="qrow__num">{number}</span>
      <Cover src={track.thumbnail} size="sm" />
      <span className="qrow2__text" title={`${track.title} · ${track.author || 'Autore sconosciuto'}`}>
        <span className="qrow2__title">{track.title}</span>
        <span className="qrow2__meta">{track.author || 'Autore sconosciuto'}{track.requestedBy ? ` · richiesto da ${track.requestedBy}` : ''}</span>
      </span>
      <span className="qrow__time">{track.duration ? formatTime(track.duration) : '–'}</span>
      <span className="qrow__acts">
        {/* Il primo è già in cima: il pulsante resta nascosto ma occupa il suo posto (niente salti). */}
        <button
          type="button"
          className="icon-btn icon-btn--sm qrow__top"
          onClick={() => onTop(track.id)}
          hidden={first}
          aria-label={`Sposta in cima «${track.title}» (sarà il prossimo)`}
          {...suggerimento('Sposta in cima')}
        >
          <I.ToTop width={18} height={18} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          onClick={() => onRemove(track.id)}
          aria-label={`Rimuovi «${track.title}» dalla coda`}
          {...suggerimento('Rimuovi')}
        >
          <I.Close width={18} height={18} />
        </button>
      </span>
    </li>
  );
}

/**
 * Prima riga della coda: il brano in corso (n° 1), come Spotify. Titolo verde e, sulla copertina,
 * le barrette dell'equalizzatore (ferme in pausa o con movimento ridotto). Non si trascina e non è
 * un bersaglio di rilascio: non è nel SortableContext, quindi gli indici della coda non cambiano.
 * Clic sulla riga = pausa / riprendi (come il pulsante grande del lettore).
 */
function NowRow({ track, paused, loading, onToggle, onSkip }) {
  const status = loading ? 'In caricamento' : paused ? 'In pausa' : 'In riproduzione';
  return (
    <li className={`qrow qrow2 qnow ${paused || loading ? 'qnow--paused' : ''}`} aria-current="true">
      <button
        type="button"
        className="qrow__btn"
        onClick={onToggle}
        disabled={loading}
        aria-label={`${status}: «${track.title}». ${paused ? 'Clic per riprendere' : 'Clic per mettere in pausa'}`}
        title={paused ? 'Riprendi' : 'Pausa'}
      />
      <span className="qnow__grip" aria-hidden="true" />
      <span className="qrow__num qnow__num" aria-hidden="true">1</span>
      <div className="qnow__art">
        <Cover src={track.thumbnail} size="sm" />
        <span className="qnow__veil" aria-hidden="true">
          <span className="qnow__eq"><i /><i /><i /><i /></span>
          <span className="qnow__hover">{paused ? <I.Play width={16} height={16} /> : <I.Pause width={16} height={16} />}</span>
        </span>
      </div>
      <span className="qrow2__text" title={`${track.title} · ${track.author || 'Autore sconosciuto'}`}>
        <span className="qrow2__title qnow__title"><span className="sr-only qnow__sr">{status}: </span>{track.title}</span>
        <span className="qrow2__meta">{track.author || 'Autore sconosciuto'}{track.requestedBy ? ` · richiesto da ${track.requestedBy}` : ''}</span>
      </span>
      <span className="qrow__time">{track.duration ? formatTime(track.duration) : '–'}</span>
      <span className="qrow__acts">
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          onClick={onSkip}
          aria-label={`Salta «${track.title}» e passa al prossimo`}
          {...suggerimento('Salta')}
        >
          <I.Next width={18} height={18} />
        </button>
      </span>
    </li>
  );
}

/** Righe finte mentre arriva il primo stato dal server: non è una coda vuota. */
function Skeleton() {
  return (
    <ol className="queue__list" aria-label="Caricamento della coda">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="qrow qrow--skeleton" aria-hidden="true">
          <span className="sk sk--num" />
          <span className="sk sk--art" />
          <span className="qrow__text">
            <span className="sk sk--line" style={{ width: `${50 + ((i * 17) % 35)}%` }} />
          </span>
        </li>
      ))}
    </ol>
  );
}

const ROW = 56; // px, uguale a --row dentro .tracks--coda (coda.css)
// Due colonne solo se ognuna resta larga almeno ~400 px (titolo leggibile): 2 × 400 + 16 di spazio + 20 di margini.
const MIN_TWO_COLS = 840;

/**
 * Righe per colonna nella vista orizzontale: quante ne stanno nell'altezza del pannello.
 * Restituisce 0 quando serve una colonna sola (pannello stretto o vista a tre colonne).
 */
function useRowsPerColumn(ref, enabled) {
  const [rows, setRows] = useState(0);
  useLayoutEffect(() => {
    const panel = ref.current?.parentElement;
    if (!enabled || !panel) return setRows(0);
    const measure = () => {
      const head = ref.current?.querySelector('.qhead')?.offsetHeight ?? 0;
      const h = panel.clientHeight - head - 16;
      setRows(panel.clientWidth < MIN_TWO_COLS ? 0 : Math.max(4, Math.floor(h / ROW)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(panel);
    return () => ro.disconnect();
  }, [ref, enabled]);
  return rows;
}

/**
 * Coda. Con `columns` (vista orizzontale) i brani vanno su due colonne riempite per colonna:
 * prima tutta la sinistra, poi la destra; quando non bastano, un altro blocco uguale sotto.
 */
/**
 * Durata totale scritta «11h23m22s» (tavola «Pulsanti con testo», ritocco di Franz): cifre normali, lettere
 * h, m, s più piccole (queue-head.css, .qtools__u). Minuti e secondi a due cifre dopo un'unità più grande.
 */
function DurataHMS({ sec }) {
  const s = Math.max(0, Math.floor(sec));
  const parti = [[Math.floor(s / 3600), 'h'], [Math.floor((s % 3600) / 60), 'm'], [s % 60, 's']];
  const da = parti.findIndex(([v]) => v > 0);
  // Cifre e lettere sono figli diretti di .qtools__dur (flex, gap 4 px), come nella tavola.
  return parti.slice(da < 0 ? 2 : da).map(([v, u], i) => (
    <Fragment key={u}>
      {i > 0 ? String(v).padStart(2, '0') : v}
      <span className="qtools__u">{u}</span>
    </Fragment>
  ));
}

/**
 * Pillole della coda: «Mescola», «Ripeti» e «Svuota» cliccabili, il conteggio (solo informativo).
 * Stanno nella testata della coda o nella barra del pannello Coda. Nella barra mostrano il testo accanto
 * all'icona finché c'è posto e lo perdono a gradini (queue-head.css): prima Ripeti (cpill--cede1), poi
 * Mescola (cede2), per ultimo Svuota (cede3). Il nome completo resta sempre nell'aria-label.
 */
export function QueueTools({ state, send, bar = false, phone = false, lead = null }) {
  const items = state?.queue || [];
  const [asking, setAsking] = useState(false);
  const clearRef = useRef(null);
  const cancelRef = useRef(null);
  // Coda finita nel frattempo (svuotata da qualcun altro, o tutta suonata): niente più da confermare.
  useEffect(() => { if (items.length === 0) setAsking(false); }, [items.length]);
  // Conferma aperta: fuoco su «Annulla»; Esc annulla e il fuoco torna su «Svuota».
  useEffect(() => {
    if (!asking) return undefined;
    cancelRef.current?.focus();
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setAsking(false);
      clearRef.current?.focus();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [asking]);
  const confirmClear = () => {
    setAsking(false);
    send({ type: 'clear' });
    clearRef.current?.focus();
  };
  const loop = LOOP_INFO[state?.loop || 'off'];
  // Come Spotify: il conteggio e la durata comprendono il brano in corso (è il n° 1 della coda).
  const all = state?.current ? [state.current, ...items] : items;
  const total = totalDuration(all);
  const count = all.length === 0
    ? 'vuota'
    : `${all.length} ${all.length === 1 ? 'brano' : 'brani'}`;
  const conteggio = (
    <span className="ipill qtools__count" aria-label={`${count}${total ? `, durata ${formatTime(total)}` : ''}`}>
      {count === 'vuota' && phone ? '0 brani' : count}
      {total > 0 && (
        // Durata: nella barra del pannello Coda sparisce per prima quando manca posto (queue-head.css).
        <span className="qtools__dur">
          {'· '}
          <I.Clock className="qtools__clock" width={14} height={14} />
          <DurataHMS sec={total} />
        </span>
      )}
    </span>
  );
  const pulsanti = (
    <>
      <button type="button" className="cpill cpill--cede2" onClick={() => send({ type: 'shuffle' })} disabled={items.length < 2} aria-label="Mischia la coda" {...suggerimento('Mischia la coda')}>
        <I.Shuffle width={16} height={16} />
        <span className="cpill__text">Mescola</span>
      </button>
      <button
        type="button"
        className={`cpill cpill--cede1${state?.loop && state.loop !== 'off' ? ' cpill--on' : ''}`}
        onClick={() => send({ type: 'loop', mode: loop.next })}
        aria-label={`${loop.label}. Clic per cambiare`}
        {...suggerimento(`${loop.label} · clic per cambiare`)}
      >
        <loop.Icon width={16} height={16} />
        {/* Spento: solo «Ripeti» (lo stato «no» lo dicono il grigio, l'aria-label e il suggerimento). */}
        <span className="cpill__text">{state?.loop && state.loop !== 'off' ? loop.label : 'Ripeti'}</span>
      </button>
      <span
        className="cclear"
        onBlur={(e) => { if (asking && !e.currentTarget.contains(e.relatedTarget)) setAsking(false); }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          ref={clearRef}
          className="cpill cpill--danger cpill--cede3"
          onClick={() => setAsking((v) => !v)}
          disabled={items.length === 0}
          aria-label="Svuota la coda"
          aria-expanded={asking}
          {...suggerimento('Svuota la coda')}
        >
          <I.Trash width={16} height={16} />
          <span className="cpill__text">Svuota</span>
        </button>
        {asking && items.length > 0 && (
          <div className="cclear__pop" role="alertdialog" aria-label="Conferma">
            <p className="cclear__q">{`Svuotare ${items.length} ${items.length === 1 ? 'brano' : 'brani'}?`}</p>
            <div className="cclear__btns">
              <button type="button" className="cclear__btn cclear__btn--danger" onClick={confirmClear}>Svuota</button>
              <button type="button" ref={cancelRef} className="cclear__btn" onClick={() => { setAsking(false); clearRef.current?.focus(); }}>Annulla</button>
            </div>
          </div>
        )}
      </span>
    </>
  );
  // Telefono (testata della scheda Coda, variante A): riga 1 «Cerca» largo (lead) + Mescola, Ripeti, Svuota
  // a sola icona da 44 px; riga 2 brani e durata, al centro (telefono.css).
  if (phone) {
    return (
      <>
        <div className="mqhead__row">{lead}{pulsanti}</div>
        <div className="mqhead__count">{conteggio}</div>
      </>
    );
  }
  return (
    <>
      {pulsanti}
      {!bar && <span className="qtools__fill" />}
      {conteggio}
    </>
  );
}

export default function Queue({ state, loading = false, send, onFocusSearch, columns = false, head = true }) {
  const [items, setItems] = useState(state?.queue || []);
  useEffect(() => setItems(state?.queue || []), [state?.queue]);
  const viewRef = useRef(null);
  const current = state?.current;
  // Brani appena arrivati in coda (non al primo caricamento, non per i blocchi grandi come una playlist):
  // la riga entra con una piccola dissolvenza e una striscia verde che sfuma (microanimazioni.css, .qrow--fresh).
  const seenIds = useRef(null);
  const [fresh, setFresh] = useState(() => new Set());
  useEffect(() => {
    if (state === null || state === undefined) return;
    const ids = new Set(items.map((t) => t.id));
    if (seenIds.current) {
      const added = items.filter((t) => !seenIds.current.has(t.id)).map((t) => t.id);
      setFresh(added.length > 0 && added.length <= 5 ? new Set(added) : (f) => (f.size ? new Set() : f));
    }
    seenIds.current = ids;
  }, [items, state]);
  const rows = useRowsPerColumn(viewRef, columns && !loading && (items.length > 0 || Boolean(current)));
  // Solo in sviluppo: ultimi messaggi inviati dalla coda, per controllare gli indici di `move`.
  const out = (msg) => {
    if (import.meta.env.DEV) (window.__codaInviati ||= []).push(msg);
    send(msg);
  };

  // Con la riga in corso in cima, il primo brano della coda sta sotto di lei nella colonna sinistra,
  // mentre il primo della colonna destra è più in alto: senza questo controllo «freccia su» dal primo
  // brano lo farebbe saltare in cima alla colonna destra. Dal primo posto, «su» non fa niente.
  const firstRef = useRef(null);
  firstRef.current = current ? items[0]?.id : null;
  const keyboardCoordinates = (event, args) => {
    const at = args.context.over?.id ?? args.active;
    if (event.code === 'ArrowUp' && firstRef.current != null && at === firstRef.current) return undefined;
    return sortableKeyboardCoordinates(event, args);
  };
  const sensors = useSensors(
    useSensor(RowPointerSensor, { activationConstraint: { distance: 5 } }),
    // Solo dalla maniglia (touch-action: none): il dito trascina subito, senza attesa.
    useSensor(RowTouchSensor),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }),
  );

  const onDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const from = items.findIndex((t) => t.id === active.id);
    const to = items.findIndex((t) => t.id === over.id);
    // `from` e `to` sono indici di state.queue (senza il brano in corso): la riga n° 1 non ne fa parte.
    if (from < 0 || to < 0) return;
    setItems((prev) => arrayMove(prev, from, to)); // subito a schermo, poi conferma dal server
    out({ type: 'move', id: active.id, to });
  };
  const onTop = (id) => {
    setItems((prev) => arrayMove(prev, prev.findIndex((t) => t.id === id), 0));
    out({ type: 'move', id, to: 0 });
  };

  // Il brano in corso è la prima riga (n° 1); la coda vera parte da 2. Nell'elenco a schermo
  // la riga in corso è un elemento in più davanti, ma non è ordinabile: gli indici inviati al
  // server restano quelli di `items`.
  const shown = current ? [{ now: true, track: current }, ...items] : items;
  const offset = current ? 2 : 1;
  // Colonna del numero larga quanto le cifre del brano più lontano (cifra di 13 px ≈ 7 px, + 1): 8 / 15 / 22 px.
  // Il numero è allineato a sinistra subito dopo la maniglia; la copertina sta 8 px dopo la colonna (coda.css).
  const numW = `${String(Math.max(1, shown.length)).length * 7 + 1}px`;

  const row = (t, i) =>
    t.now ? (
      <NowRow
        key={`now-${t.track.id}`}
        track={t.track}
        paused={Boolean(state?.paused)}
        loading={Boolean(state?.loading)}
        onToggle={() => out({ type: 'toggle' })}
        onSkip={() => out({ type: 'skip' })}
      />
    ) : (
      <Row
        key={t.id}
        track={t}
        number={at(i) + offset}
        first={at(i) === 0}
        fresh={fresh.has(t.id)}
        onPlay={(id) => out({ type: 'playNow', id })}
        onRemove={(id) => out({ type: 'remove', id })}
        onTop={onTop}
      />
    );
  // Posizione in `shown` → indice nella coda vera (la riga in corso vale -1, non usato).
  const at = (k) => (current ? k - 1 : k);

  // Blocchi da 2 × rows righe; ogni blocco riempie la colonna sinistra e poi la destra.
  const blocks = [];
  if (rows) for (let s = 0; s < shown.length; s += rows * 2) blocks.push([s, shown.slice(s, s + rows * 2)]);

  const empty = (
    <div className={`empty ${current ? 'qnow__empty' : ''}`}>
      <span className="empty__icon" aria-hidden="true"><I.Note width={32} height={32} /></span>
      <h2 className="empty__title">{current ? 'Nessun brano dopo questo' : 'La coda è vuota'}</h2>
      <p className="empty__text">
        Cerca un brano per titolo o artista, oppure incolla un link di YouTube, SoundCloud o Spotify.
      </p>
      <button type="button" className="btn-pill" onClick={onFocusSearch}>
        <I.Search width={18} height={18} />
        Cerca un brano
      </button>
    </div>
  );

  return (
    <div className="view view--coda" ref={viewRef}>
      {head && (
        <header className="qhead">
          <h2 className="h">Coda</h2>
          <QueueTools state={state} send={send} />
        </header>
      )}

      <div className="tracks tracks--coda" aria-busy={loading} style={{ '--num-w': numW }}>
        {loading ? (
          <Skeleton />
        ) : shown.length === 0 ? (
          empty
        ) : (
          <>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={rows ? undefined : [verticalOnly]}
              onDragEnd={onDragEnd}
            >
              {/* Solo i brani della coda sono ordinabili: la riga in corso resta fuori. */}
              <SortableContext items={items.map((t) => t.id)} strategy={rectSortingStrategy}>
                {rows ? (
                  blocks.map(([start, part]) => (
                    <ol
                      key={start}
                      className="qblock"
                      start={start + 1}
                      style={{ gridTemplateRows: `repeat(${Math.min(rows, part.length)}, var(--row))` }}
                    >
                      {part.map((t, j) => row(t, start + j))}
                    </ol>
                  ))
                ) : (
                  <ol className="queue__list">{shown.map(row)}</ol>
                )}
              </SortableContext>
            </DndContext>
            {items.length === 0 && empty}
          </>
        )}
      </div>
    </div>
  );
}
