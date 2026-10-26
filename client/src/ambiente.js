import { useCallback, useState } from 'react';
import './ambiente.css';

/**
 * Modalità Ambiente: lo sfondo dell'app prende un gradiente soffuso dai 3 colori della copertina
 * (coverColor.js, styles.css «.app.amb»). Preferenze personali salvate nel browser, come la posizione
 * dell'intestazione: non cambiano per gli altri nel canale. Di base: accesa, Media, pannelli opachi.
 */
export const AMB_KEY = 'franzdsmusic.ambiente';
export const AMB_INT_KEY = 'franzdsmusic.ambiente.intensita';
export const AMB_PAN_KEY = 'franzdsmusic.ambiente.pannelli';

export const INTENSITA = [
  ['lieve', 'Lieve', 15],
  ['media', 'Media', 25],
  ['marcata', 'Marcata', 40],
];
export const PANNELLI = [
  ['opachi', 'Opachi'],
  ['traslucidi', 'Traslucidi'],
];

const leggi = (key, ok, base) => {
  try {
    const v = localStorage.getItem(key);
    return ok.includes(v) ? v : base;
  } catch {
    return base;
  }
};
const scrivi = (key, v) => {
  try {
    localStorage.setItem(key, v);
  } catch {
    // browser senza memoria: la scelta vale fino al ricaricamento
  }
};

export function useAmbiente() {
  const [on, setOn] = useState(() => leggi(AMB_KEY, ['1', '0'], '1') === '1');
  const [intensita, setInt] = useState(() => leggi(AMB_INT_KEY, INTENSITA.map(([k]) => k), 'media'));
  const [pannelli, setPan] = useState(() => leggi(AMB_PAN_KEY, PANNELLI.map(([k]) => k), 'opachi'));
  const accendi = useCallback((v) => {
    setOn(v);
    scrivi(AMB_KEY, v ? '1' : '0');
  }, []);
  const scegliIntensita = useCallback((k) => {
    if (!INTENSITA.some(([x]) => x === k)) return;
    setInt(k);
    scrivi(AMB_INT_KEY, k);
  }, []);
  const scegliPannelli = useCallback((k) => {
    if (!PANNELLI.some(([x]) => x === k)) return;
    setPan(k);
    scrivi(AMB_PAN_KEY, k);
  }, []);
  const k = INTENSITA.find(([x]) => x === intensita)[2];
  return { on, intensita, pannelli, k, accendi, scegliIntensita, scegliPannelli };
}
