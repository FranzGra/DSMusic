// Icone SVG in linea (nessuna richiesta esterna: la CSP delle Activity le bloccherebbe).
const base = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true };
const stroke = { stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };

export const Play = (p) => (
  <svg {...base} {...p}><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" fill="currentColor" /></svg>
);
export const Pause = (p) => (
  <svg {...base} {...p}><rect x="6" y="4" width="4.5" height="16" rx="1.2" fill="currentColor" /><rect x="13.5" y="4" width="4.5" height="16" rx="1.2" fill="currentColor" /></svg>
);
export const Next = (p) => (
  <svg {...base} {...p}><path d="M5 5.2v13.6a1 1 0 0 0 1.53.85L16 13.7V18a1 1 0 0 0 2 0V6a1 1 0 1 0-2 0v4.3L6.53 4.35A1 1 0 0 0 5 5.2Z" fill="currentColor" /></svg>
);
export const Stop = (p) => (
  <svg {...base} {...p}><rect x="5.5" y="5.5" width="13" height="13" rx="2" fill="currentColor" /></svg>
);
export const Shuffle = (p) => (
  <svg {...base} {...p} {...stroke}><path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22" /><path d="m18 2 4 4-4 4" /><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2" /><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8" /><path d="m18 14 4 4-4 4" /></svg>
);
export const Repeat = (p) => (
  <svg {...base} {...p} {...stroke}><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></svg>
);
export const RepeatOne = (p) => (
  <svg {...base} {...p} {...stroke}><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /><path d="M11 10h1v4" /></svg>
);
export const Volume = (p) => (
  <svg {...base} {...p} {...stroke}><path d="M11 5 6 9H3v6h3l5 4V5Z" fill="currentColor" stroke="none" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></svg>
);
export const VolumeOff = (p) => (
  <svg {...base} {...p} {...stroke}><path d="M11 5 6 9H3v6h3l5 4V5Z" fill="currentColor" stroke="none" /><path d="m22 9-6 6" /><path d="m16 9 6 6" /></svg>
);
export const Close = (p) => (
  <svg {...base} {...p} {...stroke}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
);
export const Grip = (p) => (
  <svg {...base} {...p}>{[6, 12, 18].flatMap((y) => [9, 15].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" fill="currentColor" />))}</svg>
);
export const Plus = (p) => (
  <svg {...base} {...p} {...stroke}><path d="M12 5v14" /><path d="M5 12h14" /></svg>
);
export const Note = (p) => (
  <svg {...base} {...p} {...stroke}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
);
export const Search = (p) => (
  <svg {...base} {...p} {...stroke}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m20 20-4.6-4.6" /></svg>
);
export const Check = (p) => (
  <svg {...base} {...p} {...stroke} strokeWidth={2.4}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
);
export const Clock = (p) => (
  <svg {...base} {...p} {...stroke}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
export const QueueAdd = (p) => (
  <svg {...base} {...p} {...stroke}><path d="M4 6h12" /><path d="M4 12h8" /><path d="M4 18h8" /><path d="M18 13v8" /><path d="M14 17h8" /></svg>
);
/** Barre animate del brano in corso (ferme in pausa o con movimento ridotto). */
export const Equalizer = ({ paused, ...p }) => (
  <span className={`eq ${paused ? 'eq--paused' : ''}`} aria-hidden="true" {...p}>
    <span /><span /><span /><span />
  </span>
);
export const Prev = (p) => (
  <svg {...base} {...p}><path transform="matrix(-1 0 0 1 24 0)" d="M5 5.2v13.6a1 1 0 0 0 1.53.85L16 13.7V18a1 1 0 0 0 2 0V6a1 1 0 1 0-2 0v4.3L6.53 4.35A1 1 0 0 0 5 5.2Z" fill="currentColor" /></svg>
);
/** «Riproduci dopo»: elenco con una freccia che sale in cima. */
export const PlayNext = (p) => (
  <svg {...base} {...p} {...stroke}><path d="M4 12h9" /><path d="M4 18h9" /><path d="M4 6h5" /><path d="M18 20V6" /><path d="m14 10 4-4 4 4" /></svg>
);
/** «Sposta in cima» nella coda. */
export const ToTop = (p) => (
  <svg {...base} {...p} {...stroke}><path d="M5 4h14" /><path d="M12 20V9" /><path d="m7 13 5-5 5 5" /></svg>
);
export const Chevron = (p) => (
  <svg {...base} {...p} {...stroke}><path d="m6 9 6 6 6-6" /></svg>
);
/** Disposizione a colonne (pillola accanto al logo). */
export const Columns = (p) => (
  <svg {...base} {...p} {...stroke}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></svg>
);
/** «Ripristina» la disposizione predefinita. */
export const Reset = (p) => (
  <svg {...base} {...p} {...stroke}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
);

// Libreria di playlist (interruttore del pannello Soundboard e azioni sulle playlist).
export const Wave = (p) => (
  <svg {...base} {...p} {...stroke}><path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 11v2" /></svg>
);
export const Library = (p) => (
  <svg {...base} {...p} {...stroke}><path d="M3 6h12M3 12h12M3 18h7" /><path d="M19 4v11" /><circle cx="17" cy="16" r="2.5" /></svg>
);
export const Swap = (p) => (
  <svg {...base} {...p} {...stroke}><path d="M4 8h13l-3-3M20 16H7l3 3" /></svg>
);
export const More = (p) => (
  <svg {...base} {...p}><circle cx="12" cy="5" r="1.8" fill="currentColor" /><circle cx="12" cy="12" r="1.8" fill="currentColor" /><circle cx="12" cy="19" r="1.8" fill="currentColor" /></svg>
);
export const Pencil = (p) => (
  <svg {...base} {...p} {...stroke}><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
);
export const Trash = (p) => (
  <svg {...base} {...p} {...stroke}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
);
export const Lock = (p) => (
  <svg {...base} {...p} {...stroke}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
);
export const Alert = (p) => (
  <svg {...base} {...p} {...stroke}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
);
