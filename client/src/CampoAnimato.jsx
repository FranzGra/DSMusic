import { useLayoutEffect, useRef } from 'react';

const REDUCED = '(prefers-reduced-motion: reduce)';

/**
 * Contenitore della ricerca nella barra del pannello Coda: a ricerca chiusa contiene la pillola «Cerca»,
 * aperta il campo. All'apertura la barra si riorganizza di colpo (spariscono le pillole, il campo prende tutto
 * lo spazio): qui il campo parte dalla posizione e dalla larghezza della pillola e si allarga piano fino a
 * quelle nuove (250 ms, ease-out). Alla chiusura la pillola torna subito al suo posto (è centrata con un
 * transform, che l'animazione cancellerebbe). Non cambia nessun comportamento: è solo un'animazione sopra il
 * layout già deciso dal CSS. Con «movimento ridotto» il campo salta subito alla misura finale.
 */
// Posizione dal bordo della barra (getBoundingClientRect: la pillola è spostata con un transform, che
// offsetLeft non vede) e larghezza.
const misura = (el, bar) => {
  const r = el.getBoundingClientRect();
  return { left: r.left - (bar?.getBoundingClientRect().left ?? 0), width: r.width };
};

export default function CampoAnimato({ open, children, ...rest }) {
  const box = useRef(null);
  const last = useRef(null); // { left, width, open } del campo all'ultimo disegno fermo

  useLayoutEffect(() => {
    const el = box.current?.firstElementChild;
    if (!el) return;
    const busy = el.getAnimations?.().length > 0;
    const now = { ...misura(el, box.current.parentElement), open };
    const prev = last.current;
    if (prev && open && !prev.open && !window.matchMedia(REDUCED).matches && el.animate) {
      const dx = prev.left - now.left;
      if (dx !== 0 || prev.width !== now.width) {
        el.animate(
          [
            { transform: `translateX(${dx}px)`, width: `${prev.width}px` },
            { transform: 'translateX(0)', width: `${now.width}px` },
          ],
          { duration: 250, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
        );
      }
    }
    // A animazione in corso si ricorda solo lo stato aperto/chiuso: la misura ferma resta quella di partenza.
    last.current = busy && prev ? { ...prev, open } : now;
  });

  // Se la finestra cambia misura senza un nuovo disegno, la misura di partenza si aggiorna.
  useLayoutEffect(() => {
    if (!box.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      const cur = box.current?.firstElementChild;
      if (!cur || cur.getAnimations?.().length) return;
      last.current = { ...misura(cur, box.current.parentElement), open: last.current?.open };
    });
    // Si osserva la barra: a ricerca chiusa il contenitore è largo 0 e non cambierebbe mai misura.
    ro.observe(box.current.parentElement || box.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={box} {...rest}>
      {children}
    </div>
  );
}
