import { useLayoutEffect, useRef } from 'react';

const REDUCED = '(prefers-reduced-motion: reduce)';

/**
 * Contenitore del campo di ricerca nella barra del pannello Coda. Quando `open` cambia, la barra si
 * riorganizza di colpo (spariscono le pillole, il campo prende tutto lo spazio): qui il campo parte dalla
 * posizione e dalla larghezza di prima e si allarga piano fino a quelle nuove (250 ms, ease-out).
 * Non cambia nessun comportamento: è solo un'animazione sopra il layout già deciso dal CSS.
 * Con «movimento ridotto» il campo salta subito alla misura finale.
 */
export default function CampoAnimato({ open, children, ...rest }) {
  const box = useRef(null);
  const last = useRef(null); // { left, width, open } del campo all'ultimo disegno fermo

  useLayoutEffect(() => {
    const el = box.current?.firstElementChild;
    if (!el) return;
    const busy = el.getAnimations?.().length > 0;
    const now = { left: el.offsetLeft, width: el.offsetWidth, open };
    const prev = last.current;
    if (prev && prev.open !== open && !window.matchMedia(REDUCED).matches && el.animate) {
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
    const el = box.current?.firstElementChild;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      if (el.getAnimations?.().length) return;
      last.current = { left: el.offsetLeft, width: el.offsetWidth, open: last.current?.open };
    });
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={box} {...rest}>
      {children}
    </div>
  );
}
