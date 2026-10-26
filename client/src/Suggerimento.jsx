/**
 * Suggerimenti (tooltip) dei pulsanti con solo icona: variante A, con freccia (tavola «Suggerimenti»
 * dell'artifact Design). Un solo fumetto per tutta l'app, in fondo a document.body, guidato da eventi
 * delegati sul documento: nessun involucro attorno ai pulsanti, quindi i listener di @dnd-kit e degli
 * altri componenti restano quelli di prima.
 *
 * Uso: <button aria-label="…" {...suggerimento('Testo', 'Esc')}>. Mette data-tip (+ data-tip-key) e
 * title="" (il title vuoto spegne anche il fumetto nativo degli antenati, es. la barra del pannello).
 *
 * Regole: mouse/penna dopo 300 ms; tastiera subito (solo :focus-visible); mai al tocco; posizione
 * sopra, poi sotto, a destra, a sinistra, sempre dentro la finestra; sparisce con Esc e altri tasti,
 * scroll, clic, trascinamento, uscita dalla finestra. Se il pulsante mostra già un testo (es. «Mescola»
 * nella barra della Coda larga, «Ora» nei Recenti) il fumetto non serve e non compare.
 */
import { useEffect } from 'react';
import './suggerimento.css';

const RITARDO = 300; // ms di hover prima di mostrare
const DISTANZA = 8; // px tra pulsante e fumetto
const BORDO = 8; // px minimi dal bordo della finestra
const FRECCIA_MARGINE = 12; // px minimi tra la freccia e gli angoli del fumetto

export function suggerimento(testo, tasto) {
  const p = { 'data-tip': testo, title: '' };
  if (tasto) p['data-tip-key'] = tasto;
  return p;
}

/**
 * Il pulsante mostra già un testo visibile (.cpill__text, .rpill__text…): niente fumetto, qualunque sia il
 * testo (tavola «Pulsanti con testo»: «Mescola» scritto basta, anche se il suggerimento dice «Mischia la coda»).
 * Il fumetto resta per i pulsanti con la sola icona.
 */
function testoGiaVisibile(el) {
  return [...el.querySelectorAll('[class*="__text"]')].some((t) => {
    const r = t.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  });
}

function posiziona(bolla, freccia, el) {
  const r = el.getBoundingClientRect();
  const W = window.innerWidth;
  const H = window.innerHeight;
  const w = bolla.offsetWidth;
  const h = bolla.offsetHeight;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const lati = [
    ['up', r.top - DISTANZA - h >= BORDO],
    ['dn', r.bottom + DISTANZA + h <= H - BORDO],
    ['rt', r.right + DISTANZA + w <= W - BORDO],
    ['lt', r.left - DISTANZA - w >= BORDO],
  ];
  const lato = (lati.find(([, ok]) => ok) || lati[0])[0];
  let x;
  let y;
  if (lato === 'up' || lato === 'dn') {
    x = clamp(cx - w / 2, BORDO, Math.max(BORDO, W - BORDO - w));
    y = lato === 'up' ? r.top - DISTANZA - h : r.bottom + DISTANZA;
    y = clamp(y, BORDO, Math.max(BORDO, H - BORDO - h));
    freccia.style.left = `${clamp(cx - x, FRECCIA_MARGINE, w - FRECCIA_MARGINE)}px`;
    freccia.style.top = '';
  } else {
    y = clamp(cy - h / 2, BORDO, Math.max(BORDO, H - BORDO - h));
    x = lato === 'rt' ? r.right + DISTANZA : r.left - DISTANZA - w;
    x = clamp(x, BORDO, Math.max(BORDO, W - BORDO - w));
    freccia.style.top = `${clamp(cy - y, Math.min(FRECCIA_MARGINE, h / 2), Math.max(h - FRECCIA_MARGINE, h / 2))}px`;
    freccia.style.left = '';
  }
  bolla.dataset.lato = lato;
  bolla.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

/** Montato una volta (main.jsx). Non disegna niente in React: gestisce il fumetto a mano. */
export default function Suggerimenti() {
  useEffect(() => {
    const bolla = document.createElement('div');
    bolla.className = 'sugg';
    bolla.setAttribute('aria-hidden', 'true'); // il nome accessibile resta l'aria-label del pulsante
    const testo = document.createElement('span');
    const tasto = document.createElement('kbd');
    tasto.className = 'sugg__kbd';
    const freccia = document.createElement('i');
    freccia.className = 'sugg__arrow';
    bolla.append(testo, tasto, freccia);
    document.body.appendChild(bolla);

    let el = null; // pulsante del fumetto visibile o in attesa
    let timer = 0;
    let raf = 0;
    let bloccato = null; // pulsante appena cliccato: niente fumetto finché il puntatore non esce
    let ultimoTocco = 0;

    const riempi = () => {
      const t = el.getAttribute('data-tip') || '';
      const k = el.getAttribute('data-tip-key') || '';
      if (testo.textContent !== t) testo.textContent = t;
      if (tasto.textContent !== k) tasto.textContent = k;
      tasto.hidden = !k;
    };
    const segui = () => {
      // Finché è visibile: segue il pulsante (layout che cambia) e sparisce se il pulsante se ne va.
      if (!el || !el.isConnected || !el.hasAttribute('data-tip') || el.closest('[hidden]')) return nascondi();
      riempi();
      posiziona(bolla, freccia, el);
      raf = requestAnimationFrame(segui);
    };
    const mostra = () => {
      clearTimeout(timer);
      if (!el || !el.isConnected) return;
      const t = el.getAttribute('data-tip');
      if (!t || testoGiaVisibile(el)) return;
      riempi();
      bolla.classList.add('is-on');
      posiziona(bolla, freccia, el);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(segui);
    };
    const nascondi = () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      el = null;
      bolla.classList.remove('is-on');
    };

    const daPuntatore = (e) => {
      if (e.pointerType === 'touch' || Date.now() - ultimoTocco < 800) return;
      if (e.buttons) return; // tasto premuto: clic o trascinamento in corso
      const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
      if (t !== bloccato) bloccato = null;
      if (!t || t === bloccato) {
        if (el && !el.matches(':focus-visible')) nascondi();
        return;
      }
      if (t === el) return;
      nascondi();
      el = t;
      timer = setTimeout(mostra, RITARDO);
    };
    const uscitaFinestra = (e) => {
      if (!e.relatedTarget) { bloccato = null; if (el && !el.matches(':focus-visible')) nascondi(); }
    };
    const fuoco = (e) => {
      const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
      if (!t || !t.matches(':focus-visible')) return;
      nascondi();
      el = t;
      mostra();
    };
    const perditaFuoco = (e) => {
      if (el && e.target instanceof Element && el.contains(e.target)) nascondi();
    };
    const premuto = (e) => {
      if (e.pointerType === 'touch') ultimoTocco = Date.now();
      bloccato = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
      nascondi();
    };
    const tocco = () => { ultimoTocco = Date.now(); nascondi(); };
    const tastiera = (e) => {
      // Tab e frecce spostano il fuoco: il fumetto del nuovo pulsante arriva con focusin.
      if (el && e.key !== 'Shift') nascondi();
    };

    const opz = { capture: true, passive: true };
    document.addEventListener('pointerover', daPuntatore, opz);
    document.addEventListener('pointermove', daPuntatore, opz);
    document.addEventListener('pointerout', uscitaFinestra, opz);
    document.addEventListener('pointerdown', premuto, opz);
    document.addEventListener('touchstart', tocco, opz);
    document.addEventListener('focusin', fuoco, true);
    document.addEventListener('focusout', perditaFuoco, true);
    document.addEventListener('keydown', tastiera, true);
    document.addEventListener('dragstart', nascondi, true);
    window.addEventListener('scroll', nascondi, opz);
    window.addEventListener('wheel', nascondi, opz);
    window.addEventListener('resize', nascondi, opz);
    window.addEventListener('blur', nascondi);
    return () => {
      nascondi();
      document.removeEventListener('pointerover', daPuntatore, opz);
      document.removeEventListener('pointermove', daPuntatore, opz);
      document.removeEventListener('pointerout', uscitaFinestra, opz);
      document.removeEventListener('pointerdown', premuto, opz);
      document.removeEventListener('touchstart', tocco, opz);
      document.removeEventListener('focusin', fuoco, true);
      document.removeEventListener('focusout', perditaFuoco, true);
      document.removeEventListener('keydown', tastiera, true);
      document.removeEventListener('dragstart', nascondi, true);
      window.removeEventListener('scroll', nascondi, opz);
      window.removeEventListener('wheel', nascondi, opz);
      window.removeEventListener('resize', nascondi, opz);
      window.removeEventListener('blur', nascondi);
      bolla.remove();
    };
  }, []);
  return null;
}
