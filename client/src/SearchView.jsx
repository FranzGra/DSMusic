import { useEffect, useRef, useState } from 'react';
import { suggerimento } from './Suggerimento.jsx';
import { Cover } from './NowPlaying.jsx';
import { formatTime } from './format.js';
import * as I from './icons.jsx';

const fromControl = (e) => Boolean(e.target.closest('.result__actions'));

/** Le tre scelte per un brano trovato o un link incollato. */
export const AZIONI = {
  fine: { label: 'Aggiungi in coda', pill: 'In coda', tip: 'Aggiungi in fondo alla coda', done: 'Aggiunto in coda', Icon: I.Plus },
  prossimo: { label: 'Metti come prossimo', pill: 'Come prossimo', tip: 'Suona subito dopo il brano in corso', done: 'Sarà il prossimo', Icon: I.ToTop },
  ora: { label: 'Riproduci ora', pill: 'Riproduci ora', tip: 'Riproduci subito', done: 'Parte adesso', Icon: I.Play },
};

/**
 * Riga di un brano con le tre azioni. Il clic sulla riga (e Invio sulla riga selezionata) fa
 * l'azione `predefinita`: «Come prossimo» per i risultati di ricerca e per un link a un singolo brano,
 * «In coda» per una playlist o un link ancora sconosciuto.
 * onAct(dove) restituisce una promessa { ok }: durante l'attesa i pulsanti sono fermi.
 */
function Result({ r, index, onAct, linkRow = false, predefinita = 'fine' }) {
  const [pending, setPending] = useState(null); // 'fine' | 'prossimo' | 'ora'
  const [done, setDone] = useState(null);
  const timer = useRef(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true; // anche dopo il doppio montaggio di StrictMode
    return () => { alive.current = false; clearTimeout(timer.current); };
  }, []);

  const act = async (dove) => {
    if (pending) return; // niente doppi clic
    setPending(dove);
    setDone(null);
    const res = await onAct(dove);
    if (!alive.current) return;
    setPending(null);
    if (res?.ok) {
      setDone(dove);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => alive.current && setDone(null), 2200);
    }
  };

  const meta = pending
    ? 'Un attimo…'
    : done
      ? AZIONI[done].done
      : r.loading
        ? 'Leggo il titolo…'
        : r.author || (linkRow ? 'Link incollato' : 'Canale sconosciuto');

  return (
    <li
      className={`qrow qrow--result ${done ? 'is-done' : ''} ${pending ? 'is-pending' : ''}`}
      onClick={(e) => !fromControl(e) && act(predefinita)}
      aria-busy={Boolean(pending)}
    >
      <button type="button" className="qrow__main" aria-label={`${AZIONI[predefinita].label} «${r.title}»`} disabled={Boolean(pending)}>
        <span className="qrow__num">
          {done ? (
            <I.Check className="result__check" width={18} height={18} />
          ) : linkRow ? (
            <I.QueueAdd width={18} height={18} />
          ) : (
            <>
              <span className="qrow__index">{index + 1}</span>
              <I.Plus className="qrow__playicon" width={18} height={18} />
            </>
          )}
        </span>
        <span className="qrow__art"><Cover src={r.thumbnail} size="sm" /></span>
        <span className="qrow__text">
          <span className={`qrow__title ${linkRow && !r.known ? 'qrow__title--link' : ''}`} title={r.title}>{r.title}</span>
          <span className="qrow__meta">{meta}</span>
        </span>
      </button>
      <span className="qrow__time">{r.duration ? formatTime(r.duration) : '–'}</span>
      <span className="result__actions">
        {['ora', 'prossimo', 'fine'].map((dove) => {
          const { label, pill, tip, Icon } = AZIONI[dove];
          return (
            <button
              key={dove}
              type="button"
              className={`apill ${dove === predefinita ? 'apill--main' : ''} ${dove === 'ora' ? 'apill--now' : ''} ${done === dove ? 'apill--done' : ''}`}
              onClick={() => act(dove)}
              disabled={Boolean(pending)}
              aria-label={`${label} «${r.title}»`}
              title={tip}
            >
              {pending === dove ? <span className="spinner spinner--btn" aria-hidden="true" /> : done === dove ? <I.Check width={16} height={16} /> : <Icon width={16} height={16} />}
              <span className="apill__text">{done === dove ? AZIONI[dove].done : pill}</span>
            </button>
          );
        })}
      </span>
    </li>
  );
}

const hostOf = (u) => {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
};

/** Pulsante per tornare alla coda: nella vista (telefono) o nella barra del pannello Coda (desktop). */
export function CloseSearch({ link = false, onClose }) {
  return (
    <button
      type="button"
      className="cpill cpill--close"
      onClick={onClose}
      aria-label={link ? 'Annulla e torna alla coda (Esc)' : 'Chiudi la ricerca e torna alla coda (Esc)'}
      {...suggerimento('Torna alla coda', 'Esc')}
    >
      <I.Close width={16} height={16} />
      <span className="cpill__text">{link ? 'Annulla' : 'Chiudi'}</span>
      <kbd className="kbd">Esc</kbd>
    </button>
  );
}

/**
 * Vista di ricerca. `search` null = ricerca aperta ma ancora vuota (invito a scrivere).
 * `closeInHead`: il pulsante Chiudi sta già nella barra del pannello, qui non si ripete.
 */
export default function SearchView({ search, onAdd, onAddLink, onClose, closeInHead = false }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!search) {
    return (
      <div className="view view--search">
        <header className="search-head">
          <div>
            <p className="eyebrow">Cerca su YouTube</p>
            <h1 className="search-head__title">Cosa vuoi ascoltare?</h1>
          </div>
          {!closeInHead && <CloseSearch onClose={onClose} />}
        </header>
        <div className="empty search-idle">
          <span className="empty__icon" aria-hidden="true"><I.Search width={30} height={30} /></span>
          <p className="empty__text">
            Scrivi un titolo o un artista, oppure incolla un link di YouTube, SoundCloud o Spotify e premi Invio.
          </p>
        </div>
      </div>
    );
  }

  const { query, status, results, error } = search;

  if (search.kind === 'link') {
    const info = search.info;
    const r = {
      id: 'link',
      title: info?.title || query,
      author: info ? [info.author, hostOf(query)].filter(Boolean).join(' · ') : hostOf(query),
      thumbnail: info?.thumbnail || null,
      loading: status === 'loading',
      known: Boolean(info?.title),
    };
    // Singolo brano riconosciuto → come prossimo; playlist o link non ancora letto → in fondo alla coda.
    const predefinita = info && !info.playlist ? 'prossimo' : 'fine';
    return (
      <div className="view view--search">
        <header className="search-head">
          <div>
            <p className="eyebrow">Link incollato</p>
            <h1 className="search-head__title">Dove lo metto?</h1>
          </div>
          {!closeInHead && <CloseSearch link onClose={onClose} />}
        </header>
        <div className="tracks">
          <p className="section-label">
            {info?.playlist ? 'Playlist' : 'Brano'}
            <span className="section-label__hint">{predefinita === 'prossimo' ? 'Invio o clic sulla riga: come prossimo' : 'Invio o clic sulla riga: in fondo alla coda'}</span>
          </p>
          <ol className="queue__list">
            <Result key={query} r={r} index={0} linkRow predefinita={predefinita} onAct={(dove) => onAddLink(query, dove)} />
          </ol>
        </div>
      </div>
    );
  }

  return (
    <div className="view view--search">
      <header className="search-head">
        <div>
          <p className="eyebrow">Cerca su YouTube</p>
          <h1 className="search-head__title">
            {status === 'loading' ? 'Cerco' : 'Risultati per'} «{query}»
          </h1>
        </div>
        {!closeInHead && <CloseSearch onClose={onClose} />}
      </header>

      <div className="tracks" aria-busy={status === 'loading'}>
        {status === 'loading' && (
          <ol className="queue__list" aria-label="Caricamento risultati">
            {Array.from({ length: 8 }, (_, i) => (
              <li key={i} className="qrow qrow--skeleton" aria-hidden="true">
                <span className="sk sk--num" />
                <span className="sk sk--art" />
                <span className="qrow__text">
                  <span className="sk sk--line" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
                  <span className="sk sk--line sk--short" />
                </span>
              </li>
            ))}
          </ol>
        )}

        {status === 'error' && (
          <div className="empty">
            <h2 className="empty__title">La ricerca non è riuscita</h2>
            <p className="empty__text">{error}</p>
          </div>
        )}

        {status === 'done' && results.length === 0 && (
          <div className="empty">
            <span className="empty__icon" aria-hidden="true"><I.Search width={30} height={30} /></span>
            <h2 className="empty__title">Nessun risultato per «{query}»</h2>
            <p className="empty__text">Controlla come è scritto, prova meno parole o incolla direttamente un link.</p>
          </div>
        )}

        {status === 'done' && results.length > 0 && (
          <>
            <p className="section-label">
              <span className="ipill">{results.length} risultati</span>
              <span className="section-label__hint">Clic sulla riga: come prossimo</span>
            </p>
            <ol className="queue__list">
              {results.map((r, i) => (
                <Result key={r.id} r={r} index={i} predefinita="prossimo" onAct={(dove) => onAdd(r.id, dove)} />
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}
