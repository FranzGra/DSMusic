// Vista ridotta: quando Discord mostra l'Activity nella finestrella in sovraimpressione (PIP, per
// esempio mentre si guarda lo stream di un amico) o in una casella della griglia. Solo da guardare:
// copertina a sinistra; titolo, autore e stato a destra; tempi in basso a destra. Nessun pulsante, niente clic (li gestisce Discord).
import { useEffect, useState } from 'react';
import { onLayoutMode, thumbUrl } from './connection.js';
import { formatTime } from './format.js';
import * as I from './icons.jsx';
import { useLivePosition } from './NowPlaying.jsx';
import './vista-ridotta.css';

/**
 * Rete di sicurezza sulle misure (vale anche se l'SDK non manda l'evento): la PIP di Discord è
 * circa 320x180 (16:9). Si prende:
 * - qualsiasi finestra alta al massimo 260 px: lì l'interfaccia normale non ci sta in nessun caso
 *   (la barra in cima e il lettore da soli ne occupano di più);
 * - una finestra stretta fino a 480 px e alta fino a 300 px: le finestrelle 16:9 fino a 480x270 e un
 *   po' di margine. Un telefono (in verticale ≥ 560 px di altezza, in orizzontale > 480 px di
 *   larghezza) non ci rientra, quindi la vista telefono (≤ 900 px di larghezza) resta com'è.
 */
export const PIP_QUERY = '(max-height: 260px), (max-width: 480px) and (max-height: 300px)';

// Solo in sviluppo: ?pip=1 forza la vista ridotta a qualsiasi misura.
const FORZATA = import.meta.env.DEV && new URLSearchParams(location.search).has('pip');

/** true quando va mostrata la vista ridotta: modo PIP/griglia dall'SDK oppure finestra piccola. */
export function useVistaRidotta() {
  const [small, setSmall] = useState(() => matchMedia(PIP_QUERY).matches);
  const [mode, setMode] = useState(null);
  useEffect(() => {
    const mq = matchMedia(PIP_QUERY);
    const on = () => setSmall(mq.matches);
    mq.addEventListener('change', on);
    const stop = onLayoutMode(setMode);
    return () => {
      mq.removeEventListener('change', on);
      stop();
    };
  }, []);
  return FORZATA || small || mode === 1 || mode === 2;
}

export default function VistaRidotta({ state, receivedAt, offline = null }) {
  const current = state?.current || null;
  const pos = useLivePosition(state, receivedAt);
  const dur = current?.duration || 0;
  const src = current?.thumbnail ? thumbUrl(current.thumbnail) : null;
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  const cover = src && !broken ? src : null;

  const paused = Boolean(state?.paused);
  const loading = Boolean(state?.loading);
  const tone = loading || paused ? 'pausa' : 'play';
  const pillText = loading ? 'Preparo l’audio…' : paused ? 'In pausa' : 'In riproduzione';
  const pct = dur > 0 ? Math.min(100, Math.max(0, (pos / dur) * 100)) : 0;

  return (
    <div className={`vr ${cover ? '' : 'vr--empty'}`}>
      {cover && <img className="vr__bg" src={cover} alt="" aria-hidden="true" />}
      <div className="vr__blur" aria-hidden="true" />
      <div className="vr__shade" aria-hidden="true" />

      <div className="vr__art">
        {cover
          ? <img src={cover} alt="" onError={() => setBroken(true)} />
          : <I.Note className="vr__note" aria-hidden="true" />}
      </div>

      {/* Colonna di destra: tre righe fisse (titolo fino a 2 righe, autore, stato). Il chip sta sempre
          nello stesso punto: il titolo occupa sempre lo spazio di 2 righe. */}
      {current ? (
        <div className="vr__info">
          <p className="vr__title" title={current.title}>{current.title || 'Senza titolo'}</p>
          <p className="vr__author" title={current.author || undefined}>{current.author || 'Autore sconosciuto'}</p>
          <div className="vr__meta">
            <span className={`vr__pill vr__pill--${tone}`}>
              {tone === 'play' ? <I.Play aria-hidden="true" /> : <I.Pause aria-hidden="true" />}
              {pillText}
            </span>
          </div>
        </div>
      ) : (
        <div className="vr__info vr__info--empty">
          <p className="vr__title">Niente in riproduzione</p>
          <p className="vr__author">{offline || 'FranzDSMusic'}</p>
        </div>
      )}

      {current && (
        <span className="vr__time">
          {dur > 0 ? `${formatTime(pos)} / ${formatTime(dur)}` : formatTime(pos)}
        </span>
      )}

      {current && dur > 0 && (
        <div className={`vr__bar vr__bar--${tone}`} aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
