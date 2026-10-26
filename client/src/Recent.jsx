import { Cover } from './NowPlaying.jsx';
import { suggerimento } from './Suggerimento.jsx';
import * as I from './icons.jsx';
import './recent.css';

/** Ultimi brani ascoltati (max 5, il più recente in alto): riproduci subito o rimetti in coda. */
export default function Recent({ history, send, className = '', bare = false }) {
  const list = (history || []).slice(0, 5);
  return (
    <section className={`${bare ? 'side-card--bare' : 'card'} side-card ${className}`} aria-label="Ascoltati di recente">
      {!bare && <h2 className="lab">Ascoltati di recente</h2>}
      {list.length === 0 ? (
        <p className="muted">Ancora niente: i brani finiti compaiono qui.</p>
      ) : (
        <ol className="recent">
          {list.map((t) => (
            <li key={t.id} className="recent__row">
              <Cover src={t.thumbnail} size="md" />
              <span className="one" title={`${t.title} · ${t.author || 'Autore sconosciuto'}`}>
                <span className="recent__title">{t.title}</span>
                <span className="muted one" style={{ display: 'block' }}>{t.author || 'Autore sconosciuto'}</span>
              </span>
              <span className="recent__acts">
                <button
                  type="button"
                  className="rpill"
                  onClick={() => send({ type: 'riproduciDaStorico', id: t.id })}
                  aria-label={`Riproduci ora «${t.title}»`}
                  {...suggerimento('Riproduci ora')}
                >
                  <I.Play width={16} height={16} />
                  <span className="rpill__text">Riproduci ora</span>
                </button>
                <button
                  type="button"
                  className="rpill rpill--main"
                  onClick={() => send({ type: 'accodaDaStorico', id: t.id })}
                  aria-label={`Rimetti in coda «${t.title}»`}
                  {...suggerimento('In coda')}
                >
                  <I.Plus width={16} height={16} />
                  <span className="rpill__text">In coda</span>
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
