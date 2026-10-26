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

// Pillola «Cerca» a ricerca chiusa (queue-head.css): il contenitore occupa lo spazio libero tra titolo/conteggio
// e pulsanti. La pillola sta al centro esatto della barra finché da tutti e due i lati restano almeno
// CERCA_AGIO px nel contenitore (più i gap della barra); quando un lato scende sotto, scivola con continuità
// verso il centro dello spazio libero, che raggiunge quando il centro esatto la farebbe toccare un vicino.
// Nessuna soglia di larghezza: vale per scheda sola e più schede, con o senza menu, durata o testo nei pulsanti.
const CERCA_AGIO = 12;
// Larghezza più grande vista per la pillola (con il testo «Cerca»): il passaggio verso il centro dello spazio
// libero si calcola su questa, così quando la pillola resta con la sola lente (menu ≡, pannello stretto) non salta.
const cercaPiena = new WeakMap();
export function centraCerca(box) {
  const el = box?.firstElementChild;
  const bar = box?.parentElement;
  if (!el || !bar || !box.classList.contains('pnl__search--pill')) {
    box?.style.removeProperty('--cerca-dx');
    return;
  }
  const b = bar.getBoundingClientRect();
  const r = box.getBoundingClientRect();
  const w = el.offsetWidth; // larghezza senza translate
  const wp = Math.max(w, cercaPiena.get(box) || 0);
  cercaPiena.set(box, wp);
  // Spostamento dal centro dello spazio libero al centro esatto: non dipende dalla larghezza della pillola.
  const verso = b.left + b.width / 2 - (r.left + r.width / 2);
  const libero = r.width - wp;
  let dx = 0;
  if (r.width - w > 0) {
    const a0 = libero / 2 + verso; // spazio a sinistra (pillola piena) con il centro esatto
    const t = Math.max(0, Math.min(1, Math.min(a0, libero - a0) / CERCA_AGIO));
    dx = verso * t;
  }
  box.style.setProperty('--cerca-dx', `${Math.round(dx * 10) / 10}px`);
}

export default function CampoAnimato({ open, children, ...rest }) {
  const box = useRef(null);
  const last = useRef(null); // { left, width, open } del campo all'ultimo disegno fermo

  useLayoutEffect(() => {
    centraCerca(box.current);
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
      centraCerca(box.current);
      const cur = box.current?.firstElementChild;
      if (!cur || cur.getAnimations?.().length) return;
      last.current = { ...misura(cur, box.current.parentElement), open: last.current?.open };
    });
    // Si osserva la barra: la misura di partenza dipende dalla sua larghezza.
    ro.observe(box.current.parentElement || box.current);
    // Anche il contenitore: cambia misura quando cambiano i vicini (conteggio, testo dei pulsanti) a barra ferma.
    if (box.current.parentElement) ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={box} {...rest}>
      {children}
    </div>
  );
}
