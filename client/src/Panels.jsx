import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { suggerimento } from './Suggerimento.jsx';

/**
 * Disposizione a pannelli a schede, come in Premiere (tavole «Pannelli a schede» e «Schede miste»).
 *
 * Tre posti per colonna (sinistra, centro, destra); ogni colonna ha da zero a tre pannelli, e almeno un
 * pannello c'è sempre. Una colonna vuota non si vede: le altre si prendono il suo spazio. Ogni pannello è una
 * lista di schede con una scheda attiva:
 * - una sola scheda: riga titolo come prima (nome a 12 px dal bordo e strumenti sulla stessa riga); il
 *   pannello si trascina dal titolo;
 * - due o più schede: riga di linguette (40 px) e sotto la riga strumenti della scheda attiva (46 px, solo
 *   se la scheda ne ha). Le linguette si trascinano: tra le linguette si riordinano o entrano in un altro
 *   pannello, al centro di un pannello si uniscono, su un bordo (un quarto) fanno nascere un pannello nuovo.
 * La × e il menu ≡ chiudono le schede; quelle chiuse tornano dal menu ≡ (che compare anche nei pannelli a
 * scheda sola finché ce n'è una chiusa) o con «Ripristina» nel menu dell'intestazione.
 *
 * `ratio[c]` dice come si dividono l'altezza i pannelli della colonna c (il separatore di 12 px tra due
 * pannelli resta fuori dal conto: le frazioni valgono per i pannelli veri):
 * - un numero (due pannelli): la parte del primo;
 * - un array di frazioni, una per pannello (tre pannelli);
 * - null: parti uguali (anche una colonna con un solo pannello). Il Lettore si adatta a qualunque altezza.
 */
export const TAB_IDS = ['lettore', 'coda', 'canale', 'soundbar', 'libreria', 'recenti'];
export const TAB_LABEL = {
  lettore: 'Lettore',
  coda: 'Coda',
  canale: 'Nel canale',
  soundbar: 'Soundbar',
  libreria: 'Libreria',
  recenti: 'Recenti',
};
// Schede con una riga strumenti (per l'altezza minima con le linguette): il Lettore e i Recenti non ne hanno.
const WITH_TOOLS = new Set(['coda', 'canale', 'soundbar', 'libreria']);
const MAX_IN_COL = 3;
const GAP = 12; // separatori tra colonne e tra pannelli (uguale a --gap)
const MIN_SIDE = 240;
const MAX_SIDE = 480;
const MIN_CENTER = 520;
// Larghezza minima della colonna con la scheda Lettore, in qualunque colonna sia.
const MIN_PLAYER = 300;
// Il Lettore è orizzontale quando il suo pannello è più largo che alto e largo almeno così (NowPlaying.jsx).
// 440: a 1280 px la colonna centrale di Player orizzontale è larga circa 520 px.
export const H_PLAYER = 440;
const BAR = 46; // riga titolo (scheda sola) e riga strumenti
const TABS_H = 40; // riga delle linguette
const BORDER = 2;

// Altezza minima di ogni scheda da sola (barra 46 px + bordo 2 px + il contenuto essenziale), sotto la quale
// il separatore non scende: niente tagli. Se una colonna è troppo bassa per i minimi dei suoi pannelli, la
// colonna scorre (i pannelli restano al minimo, non si schiacciano). Misure prese con l'anteprima.
const MIN_H = {
  // Lettore orizzontale: titolo, autore · richiesto da, copertina, comandi, tempi, barra e fader con la
  // percentuale (cursore alto almeno 56 px). Sotto i 640 px di larghezza barra e comandi vanno su due righe.
  lettoreH: 188,
  // Lettore verticale: copertina piccola, titolo, comandi; il resto scorre dentro il pannello.
  lettoreV: 300,
  coda: 200, // intestazione con la ricerca + la riga del brano in corso + un brano (o un risultato)
  canale: 140, // due persone
  soundbar: 180, // una riga di suoni
  libreria: 180, // la barra della libreria e una riga
  recenti: 180, // un brano dei Recenti coi suoi pulsanti
};
const tabMin = (t, width) => (t === 'lettore' ? (width >= H_PLAYER ? MIN_H.lettoreH : MIN_H.lettoreV) : MIN_H[t] ?? 120);
/**
 * Altezza minima del pannello largo `width`. Una scheda: il suo minimo. Più schede: il contenuto più alto tra
 * le schede + linguette (40 px) + la riga strumenti (46 px) se quella scheda ne ha una.
 */
export function minHeight(panel, width) {
  if (panel.tabs.length === 1) return tabMin(panel.tabs[0], width);
  return Math.max(...panel.tabs.map((t) => tabMin(t, width) - BAR + TABS_H + (WITH_TOOLS.has(t) ? BAR : 0)));
}

const P = (...tabs) => ({ tabs, act: tabs[0] });
export const PRESETS = {
  orizzontale: {
    label: 'Player orizzontale',
    sub: 'Canale e soundbar a sinistra, lettore largo e coda al centro, libreria a destra',
    // Misurata a 1597×720: colonne 275 / 959 / 307, altezze [206, 470] [208, 468] [624].
    cols: [[P('canale'), P('soundbar')], [P('lettore'), P('coda', 'recenti')], [P('libreria')]],
    w: [275, 307],
    ratio: [0.3047337278106509, 0.3076923076923077, null],
    chiuse: [],
  },
  verticale: {
    label: 'Player verticale',
    sub: 'Lettore alto a sinistra, coda al centro, canale e soundbar a destra',
    // Misurata a 1597×720: colonne 330 / 907 / 304, altezze [624] [688] [199, 477].
    cols: [[P('lettore')], [P('coda')], [P('canale'), P('soundbar', 'libreria', 'recenti')]],
    w: [330, 304],
    ratio: [null, null, 0.29500277366863903],
    chiuse: [],
  },
};
export const CUSTOM = 'personalizzata';
export const CHOICES = [...Object.keys(PRESETS), CUSTOM];
const DEFAULT = 'orizzontale';
const STORE = 'franzdsmusic.disposizione'; // { formato: 2, scelta, personalizzata, attive }
const STORE_V1 = 'franzdsmusic.disposizione.v1'; // copia di quella di prima della migrazione (per tornare indietro)
const OLD_LAYOUT = 'franzdsmusic.pannelli'; // prima: la disposizione attiva, qualunque fosse
const OLD_VIEW = 'franzdsmusic.vista'; // ancora prima: scelta C/A, 'a' = «Player verticale»
const OLD_SUONI_TAB = 'franzdsmusic.suoni.scheda'; // sotto-scheda del vecchio pannello Soundbar

const clone = (x) => JSON.parse(JSON.stringify(x));
/** Solo la disposizione (niente nome e descrizione dei preset). */
const copy = (p) => clone({ cols: p.cols, w: p.w, ratio: p.ratio, chiuse: p.chiuse || [] });
const num = (x) => typeof x === 'number' && Number.isFinite(x);
// null = automatico; numero = parte del primo di due; array = una frazione positiva per pannello.
const ratioOk = (x, n) => x === null || num(x) || (Array.isArray(x) && x.length === n && x.every((v) => num(v) && v > 0));
const hasTab = (col, t) => col.some((p) => p.tabs.includes(t));

/* ---------------------------------------------------------------------------------------------------- */
/* Formato di prima (1): un pannello = un id ('lettore', 'coda', 'canale', 'suoni'; ancora prima 'recenti'). */
/* ---------------------------------------------------------------------------------------------------- */

const V1_IDS = ['lettore', 'coda', 'canale', 'suoni'];
const V1_MAX = [2, 2, 3];
const V1_PRESETS = {
  orizzontale: { cols: [['coda'], ['lettore', 'suoni'], ['canale']], w: [480, 300], ratio: [null, 1 / 3, null] },
  verticale: { cols: [['lettore'], ['coda'], ['canale', 'suoni']], w: [310, 340], ratio: [null, null, 1 / 3] },
};
const copy1 = (p) => ({ cols: p.cols.map((c) => c.slice()), w: p.w.slice(), ratio: p.ratio.map((r) => (Array.isArray(r) ? r.slice() : r)) });
const same1 = (a, b) => JSON.stringify(copy1(a)) === JSON.stringify(copy1(b));
// Versioni passate dei preset, per riconoscerle in una disposizione salvata: chi aveva esattamente una di
// queste ritrova il preset di oggi con lo stesso nome. (Prima le frazioni fisse, poi il Lettore automatico.)
const OLD_ORIZZ = { cols: [['canale', 'recenti'], ['lettore', 'coda'], ['suoni']], w: [300, 300] };
const OLD_VERT = { cols: [['lettore', 'canale'], ['coda'], ['recenti', 'suoni']], w: [360, 340] };
// I preset con il pannello «Recenti» (tolto: poi è stato la terza scheda del pannello Soundbar).
const PRE_RECENTI = {
  orizzontale: { cols: [['coda'], ['lettore', 'suoni'], ['canale', 'recenti']], w: [480, 300], ratio: [null, 1 / 3, 0.5] },
  verticale: { cols: [['lettore'], ['coda', 'recenti'], ['canale', 'suoni']], w: [310, 340], ratio: [null, 2 / 3, 1 / 3] },
};
const LEGACY = {
  orizzontale: [PRE_RECENTI.orizzontale, { ...OLD_ORIZZ, ratio: [0.4, 0.36, 0.5] }, { ...OLD_ORIZZ, ratio: [0.4, null, 0.5] }],
  verticale: [PRE_RECENTI.verticale, { ...OLD_VERT, ratio: [0.7, 0.5, 0.5] }, { ...OLD_VERT, ratio: [null, 0.5, 0.5] }],
};

/**
 * Disposizione salvata col vecchio pannello «Recenti»: il pannello sparisce e lo spazio va agli altri della
 * stessa colonna (la colonna che cambia riparte da parti uguali, `ratio: null`). Se la colonna restasse vuota
 * ci va l'ultimo pannello di una colonna con due o più pannelli. Restituisce una copia; senza Recenti, la stessa copia.
 */
function dropRecenti(l) {
  if (!l || !Array.isArray(l.cols) || l.cols.length !== 3 || !l.cols.every(Array.isArray) || !Array.isArray(l.ratio)) return l;
  if (!l.cols.some((c) => c.includes('recenti'))) return l;
  const cols = l.cols.map((c) => c.filter((id) => id !== 'recenti'));
  const ratio = l.ratio.slice();
  l.cols.forEach((c, i) => {
    if (c.includes('recenti')) ratio[i] = null;
  });
  const empty = cols.findIndex((c) => c.length === 0);
  if (empty >= 0) {
    let from = -1;
    cols.forEach((c, i) => {
      if (c.length > 1 && (from < 0 || c.length > cols[from].length)) from = i;
    });
    if (from >= 0) {
      cols[empty].push(cols[from].pop());
      ratio[empty] = null;
      ratio[from] = null;
    }
  }
  return { ...l, cols, ratio };
}

/** Disposizione del formato 1 valida? Tutti i pannelli una volta sola, 3 colonne da 1 a 2 (o 3) pannelli. */
function valid1(l) {
  if (!l || !Array.isArray(l.cols) || l.cols.length !== 3) return false;
  if (!Array.isArray(l.w) || l.w.length !== 2 || !Array.isArray(l.ratio) || l.ratio.length !== 3) return false;
  if (l.cols.some((c, i) => !Array.isArray(c) || c.length < 1 || c.length > V1_MAX[i] || !c.every((id) => typeof id === 'string'))) return false;
  if (!l.w.every(num) || !l.ratio.every((r, i) => ratioOk(r, l.cols[i].length))) return false;
  const flat = l.cols.flat();
  return flat.length === V1_IDS.length && V1_IDS.every((id) => flat.includes(id));
}

/** Sotto-scheda scelta nel vecchio pannello Soundbar ('suoni' | 'libreria' | 'recenti') come scheda nuova. */
function oldSuoniAct() {
  try {
    const v = localStorage.getItem(OLD_SUONI_TAB);
    return v === 'libreria' || v === 'recenti' ? v : 'soundbar';
  } catch {
    return 'soundbar';
  }
}

/** Formato 1 → 2: ogni pannello diventa una scheda; il pannello Soundbar diventa tre schede insieme. */
function fromV1(l, act) {
  return {
    cols: l.cols.map((c) => c.map((id) => (id === 'suoni' ? { tabs: ['soundbar', 'libreria', 'recenti'], act } : { tabs: [id], act: id }))),
    w: l.w.slice(),
    ratio: l.ratio.map((r) => (Array.isArray(r) ? r.slice() : r)),
    chiuse: [],
  };
}

/* ---------------------------------------------------------------------------------------------------- */
/* Formato 2                                                                                              */
/* ---------------------------------------------------------------------------------------------------- */

/** Disposizione valida? 3 colonne da 0 a 3 pannelli (almeno un pannello), ogni scheda una volta sola. */
function valid(l) {
  if (!l || !Array.isArray(l.cols) || l.cols.length !== 3) return false;
  if (!Array.isArray(l.w) || l.w.length !== 2 || !l.w.every(num)) return false;
  if (!Array.isArray(l.ratio) || l.ratio.length !== 3 || !Array.isArray(l.chiuse)) return false;
  const panelOk = (p) => p && Array.isArray(p.tabs) && p.tabs.length > 0 && p.tabs.includes(p.act);
  if (l.cols.some((c) => !Array.isArray(c) || c.length > MAX_IN_COL || !c.every(panelOk))) return false;
  if (!l.cols.some((c) => c.length > 0)) return false;
  if (!l.ratio.every((r, i) => ratioOk(r, l.cols[i].length))) return false;
  const flat = [...l.cols.flat().flatMap((p) => p.tabs), ...l.chiuse];
  return flat.length === TAB_IDS.length && TAB_IDS.every((t) => flat.includes(t));
}

/** Una disposizione salvata (formato 2, oppure 1 da convertire) nel formato 2; null se non è valida. */
function toV2(raw) {
  if (valid(raw)) return copy(raw);
  const l = dropRecenti(raw);
  return valid1(l) ? fromV1(l, oldSuoniAct()) : null;
}

/** Minimo della colonna laterale i (0 = sinistra, 1 = destra): più alto se ci sta il Lettore. */
const sideMin = (cols, i) => (hasTab(cols[i === 0 ? 0 : 2], 'lettore') ? MIN_PLAYER : MIN_SIDE);
/** Riporta tra minimo e massimo una larghezza salvata fuori misura (vecchia Personalizzata, Lettore spostato di lato). */
function fit(l) {
  const w = l.w.map((v, i) => Math.round(Math.min(MAX_SIDE, Math.max(sideMin(l.cols, i), v))));
  return w[0] === l.w[0] && w[1] === l.w[1] ? l : { ...l, w };
}

/** Schede attivate di recente: valgono nei preset (cambiare scheda non crea la Personalizzata). */
const cleanAttive = (a) => (Array.isArray(a) ? a.filter((t, i) => TAB_IDS.includes(t) && a.indexOf(t) === i) : []);
const seedAttive = () => (oldSuoniAct() === 'soundbar' ? [] : [oldSuoniAct()]);

/** Scelta salvata; se manca, la ricava dai vecchi valori (una disposizione diversa dai preset diventa la Personalizzata). */
function readChoice() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (s && CHOICES.includes(s.scelta)) {
      // Prima della migrazione al formato 2 se ne tiene una copia, per poter tornare al codice di prima.
      if (s.formato !== 2) {
        try {
          if (!localStorage.getItem(STORE_V1)) localStorage.setItem(STORE_V1, JSON.stringify(s));
        } catch {
          // niente memoria: pazienza
        }
      }
      const pers = s.personalizzata ? toV2(s.personalizzata) : null;
      const custom = pers ? fit(pers) : null;
      const attive = s.formato === 2 ? cleanAttive(s.attive) : seedAttive();
      return { choice: s.scelta === CUSTOM && !custom ? DEFAULT : s.scelta, custom, attive };
    }
    const raw = JSON.parse(localStorage.getItem(OLD_LAYOUT) || 'null');
    const old = dropRecenti(raw);
    if (valid1(old)) {
      const preset = Object.keys(V1_PRESETS).find((k) => same1(V1_PRESETS[k], old) || LEGACY[k].some((x) => same1(x, raw)));
      return preset
        ? { choice: preset, custom: null, attive: seedAttive() }
        : { choice: CUSTOM, custom: fit(fromV1(old, oldSuoniAct())), attive: seedAttive() };
    }
    return { choice: localStorage.getItem(OLD_VIEW) === 'a' ? 'verticale' : DEFAULT, custom: null, attive: seedAttive() };
  } catch {
    return { choice: DEFAULT, custom: null, attive: [] };
  }
}

function saveChoice({ choice, custom, attive }) {
  try {
    localStorage.setItem(STORE, JSON.stringify({ formato: 2, scelta: choice, personalizzata: custom, attive }));
  } catch {
    // niente memoria (finestra privata, dati bloccati): vale fino alla chiusura
  }
}

/** Preset con le schede attive scelte dalla persona (la più recente di ogni pannello). */
function withAttive(l, attive) {
  return {
    ...l,
    cols: l.cols.map((c) => c.map((p) => ({ ...p, act: attive.find((t) => p.tabs.includes(t)) ?? p.act }))),
  };
}

/**
 * Disposizione della persona: un preset oppure la sua unica Personalizzata, salvata nel browser.
 * Ogni modifica (schede, pannelli, larghezze, altezze) finisce nella Personalizzata; partendo da un preset
 * la scelta passa a «Personalizzata» e `saved` aumenta (il menu mostra «Salvata in questo browser»).
 * Cambiare la scheda attiva non è una modifica: nei preset si ricorda a parte (`attive`).
 * Tornare a un preset non la cancella; `reset` sì, e torna a Player orizzontale con tutte le schede.
 */
export function useLayout() {
  const [state, setState] = useState(readChoice);
  const [saved, setSaved] = useState(0);
  const stateRef = useRef(state);
  const apply = useCallback((next) => {
    stateRef.current = next;
    setState(next);
    saveChoice(next);
  }, []);
  useEffect(() => saveChoice(stateRef.current), []); // fissa subito il risultato della migrazione
  const change = useCallback((layout) => {
    if (stateRef.current.choice !== CUSTOM) setSaved((n) => n + 1);
    apply({ ...stateRef.current, choice: CUSTOM, custom: fit(copy(layout)) });
  }, [apply]);
  // Scheda attiva del pannello [c, k].
  const setAct = useCallback((c, k, tab) => {
    const s = stateRef.current;
    const attive = [tab, ...s.attive.filter((t) => t !== tab)];
    if (s.choice === CUSTOM && s.custom?.cols[c]?.[k]?.tabs.includes(tab)) {
      const custom = clone(s.custom);
      custom.cols[c][k].act = tab;
      apply({ ...s, custom, attive });
    } else {
      apply({ ...s, attive });
    }
  }, [apply]);
  const pick = useCallback((choice) => {
    if (choice === CUSTOM && !stateRef.current.custom) return;
    apply({ ...stateRef.current, choice });
  }, [apply]);
  const reset = useCallback(() => apply({ ...stateRef.current, choice: DEFAULT, custom: null }), [apply]);
  const layout = useMemo(
    () => (state.choice === CUSTOM ? state.custom : withAttive(copy(PRESETS[state.choice]), state.attive)),
    [state],
  );
  return { layout, choice: state.choice, custom: state.custom, saved, change, setAct, pick, reset };
}

/* ---------------------------------------------------------------------------------------------------- */
/* Operazioni sulle schede (pure: restituiscono una disposizione nuova)                                   */
/* ---------------------------------------------------------------------------------------------------- */

/** Toglie la scheda dal pannello S; un pannello senza schede si chiude e lo spazio va ai vicini. */
function leave(l, S, tab) {
  const oi = S.tabs.indexOf(tab);
  if (oi < 0) return;
  S.tabs.splice(oi, 1);
  if (S.tabs.length === 0) {
    l.cols.forEach((col) => {
      const i = col.indexOf(S);
      if (i >= 0) col.splice(i, 1);
    });
  } else if (S.act === tab) {
    S.act = S.tabs[Math.min(oi, S.tabs.length - 1)];
  }
}

/** Le colonne che cambiano numero di pannelli ripartono da parti uguali. */
function resetRatios(l, before) {
  l.cols.forEach((col, i) => {
    if (col.length !== before[i]) l.ratio[i] = null;
  });
  return l;
}

/**
 * Sposta la scheda `tab` dal pannello `src` ({c, k}) secondo `to`:
 * { kind: 'tab', c, k, idx } tra le linguette · { kind: 'join', c, k } in fondo alle linguette ·
 * { kind: 'split', c, k, side } pannello nuovo sopra/sotto (stessa colonna) o a sinistra/destra (colonna vuota accanto).
 */
export function moveTab(l0, tab, src, to) {
  const l = copy(l0);
  const before = l.cols.map((c) => c.length);
  const S = l.cols[src.c]?.[src.k];
  const T = l.cols[to.c]?.[to.k];
  if (!S || !T || !S.tabs.includes(tab)) return l0;
  if (to.kind === 'tab' || to.kind === 'join') {
    if (T === S) {
      const oi = S.tabs.indexOf(tab);
      let i = to.kind === 'join' ? S.tabs.length : to.idx;
      S.tabs.splice(oi, 1);
      if (oi < i) i -= 1;
      S.tabs.splice(i, 0, tab);
      S.act = tab;
    } else {
      const i = to.kind === 'join' ? T.tabs.length : Math.min(to.idx, T.tabs.length);
      T.tabs.splice(i, 0, tab);
      T.act = tab;
      leave(l, S, tab);
    }
  } else {
    const np = { tabs: [tab], act: tab };
    if (to.side === 'top' || to.side === 'bottom') {
      const col = l.cols[to.c];
      col.splice(col.indexOf(T) + (to.side === 'bottom' ? 1 : 0), 0, np);
    } else {
      l.cols[to.c + (to.side === 'left' ? -1 : 1)].push(np);
    }
    leave(l, S, tab);
  }
  return resetRatios(l, before);
}

/** Frazioni d'altezza dei pannelli di una colonna da n pannelli (come slotFlex). */
function fractions(n, r) {
  if (Array.isArray(r) && r.length === n) return r.slice();
  if (n === 2 && num(r)) return [r, 1 - r];
  return Array.from({ length: n }, () => 1 / n);
}

/**
 * Sposta tutto il pannello `src` ({c, k}) con tutte le sue schede, secondo `to` (come moveTab):
 * { kind: 'tab', idx } le sue schede entrano tra le linguette di T · { kind: 'join' } in fondo alle linguette ·
 * { kind: 'split', side } sopra/sotto T oppure in una colonna vuota accanto alla colonna c.
 * Riordinare nella stessa colonna tiene le altezze dei pannelli; le colonne che cambiano numero ripartono uguali.
 */
export function movePanel(l0, src, to) {
  const l = copy(l0);
  const before = l.cols.map((c) => c.length);
  const S = l.cols[src.c]?.[src.k];
  if (!S) return l0;
  if (to.kind === 'split' && (to.side === 'left' || to.side === 'right')) {
    const nc = to.c + (to.side === 'left' ? -1 : 1);
    if (nc < 0 || nc > 2 || l.cols[nc].length > 0) return l0;
    l.cols[src.c].splice(src.k, 1);
    l.cols[nc].push(S);
    return resetRatios(l, before);
  }
  const T = l.cols[to.c]?.[to.k];
  if (!T || T === S) return l0;
  if (to.kind === 'tab' || to.kind === 'join') {
    l.cols[src.c].splice(src.k, 1);
    const i = to.kind === 'join' ? T.tabs.length : Math.min(to.idx, T.tabs.length);
    T.tabs.splice(i, 0, ...S.tabs);
    T.act = S.act;
    return resetRatios(l, before);
  }
  const col = l.cols[to.c];
  if (src.c === to.c) {
    const fr = fractions(col.length, l.ratio[to.c]);
    const [f] = fr.splice(src.k, 1);
    col.splice(src.k, 1);
    const ti = col.indexOf(T) + (to.side === 'bottom' ? 1 : 0);
    col.splice(ti, 0, S);
    fr.splice(ti, 0, f);
    if (l.ratio[to.c] !== null) l.ratio[to.c] = col.length === 2 ? fr[0] : fr;
    return l;
  }
  if (col.length >= MAX_IN_COL) return l0;
  l.cols[src.c].splice(src.k, 1);
  col.splice(col.indexOf(T) + (to.side === 'bottom' ? 1 : 0), 0, S);
  return resetRatios(l, before);
}

/** Trascinamento in corso: una scheda (`mode: 'tab'`) o il pannello intero (`'panel'`) da [c, k]. */
const dropOn = (l, d, to) => (d.mode === 'panel' ? movePanel(l, d, to) : moveTab(l, d.tab, d, to));

/**
 * Dove si può lasciare ciò che si trascina sul pannello [c, k]: { head, top, bottom, join } (null: da nessuna
 * parte, il pannello di partenza). `head`: tra le linguette (o sul titolo di una scheda sola = unisci).
 */
function dropOptions(l, d, c, k) {
  const S = l.cols[d.c]?.[d.k];
  const T = l.cols[c]?.[k];
  if (!S || !T) return null;
  const self = S === T;
  const whole = d.mode === 'panel';
  if (self && (whole || S.tabs.length === 1)) return null;
  const n = l.cols[c].length;
  let top;
  let bottom;
  if (whole && d.c === c) {
    // Riordino nella stessa colonna: niente posti che lascerebbero il pannello dov'è.
    top = k !== d.k + 1;
    bottom = k !== d.k - 1;
  } else {
    top = n < MAX_IN_COL;
    bottom = top;
  }
  const join = !self;
  const head = T.tabs.length > 1 ? true : join;
  return { head, top, bottom, join };
}

/** Colonne vuote accanto alla colonna c dove può nascere una colonna nuova: { left, right }. */
const colOptions = (l, c) => ({ left: c > 0 && l.cols[c - 1].length === 0, right: c < 2 && l.cols[c + 1].length === 0 });

/** Dove può nascere un pannello nuovo dal pannello [c, k] (per «Separa la scheda»): sotto, oppure a destra/sinistra. */
function freeSide(l, c, k, srcLeaves = false) {
  const n = l.cols[c].length - (srcLeaves ? 1 : 0);
  if (n < MAX_IN_COL) return 'bottom';
  if (c < 2 && l.cols[c + 1].length === 0) return 'right';
  if (c > 0 && l.cols[c - 1].length === 0) return 'left';
  return null;
}

function closeTab(l0, c, k, tab) {
  const l = copy(l0);
  const S = l.cols[c][k];
  if (S.tabs.length < 2) return l0;
  leave(l, S, tab);
  l.chiuse.push(tab);
  return l;
}

function closePanel(l0, c, k) {
  const l = copy(l0);
  if (l.cols.flat().length < 2) return l0;
  const before = l.cols.map((col) => col.length);
  const [S] = l.cols[c].splice(k, 1);
  l.chiuse.push(...S.tabs);
  return resetRatios(l, before);
}

function reopenTab(l0, c, k, tab) {
  const l = copy(l0);
  const T = l.cols[c][k];
  l.chiuse = l.chiuse.filter((t) => t !== tab);
  T.tabs.push(tab);
  T.act = tab;
  return l;
}

/* ---------------------------------------------------------------------------------------------------- */
/* Misure                                                                                                 */
/* ---------------------------------------------------------------------------------------------------- */

const visibleCols = (cols) => [0, 1, 2].filter((i) => cols[i].length > 0);
/** La colonna che prende lo spazio che resta: il centro, se c'è; altrimenti l'ultima visibile. */
const flexCol = (vis) => (vis.includes(1) ? 1 : vis[vis.length - 1]);
const wIndex = (c) => (c === 0 ? 0 : 1); // colonna laterale → posto in `w`

/**
 * Larghezze vere delle tre colonne (0 per una colonna vuota): le laterali scelte, la colonna libera (il centro)
 * prende il resto (almeno MIN_CENTER se c'è spazio). La colonna del Lettore non scende mai sotto MIN_PLAYER:
 * di lato non si restringe oltre, al centro le laterali cedono fino a 200 px.
 */
function columnWidths(total, w, cols) {
  const out = [0, 0, 0];
  const vis = visibleCols(cols);
  if (!vis.length) return out;
  const avail = Math.max(0, total - GAP * (vis.length - 1));
  if (vis.length === 1) {
    out[vis[0]] = avail;
    return out;
  }
  const flex = flexCol(vis);
  const fixed = vis.filter((i) => i !== flex);
  const player = (i) => hasTab(cols[i], 'lettore');
  const floor = (i) => (player(i) ? MIN_PLAYER : 200);
  let ws = fixed.map((i) => Math.max(w[wIndex(i)], player(i) ? MIN_PLAYER : 0));
  const sum = () => ws.reduce((a, b) => a + b, 0);
  const maxSides = avail - MIN_CENTER;
  if (sum() > maxSides) {
    const k = Math.max(0, maxSides) / sum();
    ws = ws.map((v, j) => Math.max(floor(fixed[j]), Math.floor(v * k)));
  }
  if (player(flex) && avail - sum() < MIN_PLAYER) {
    const over = MIN_PLAYER - (avail - sum());
    const spare = ws.map((v) => Math.max(0, v - 200));
    const tot = spare.reduce((a, b) => a + b, 0);
    if (tot > 0) {
      let left = over;
      ws = ws.map((v, j) => {
        const d = j === ws.length - 1 ? Math.min(spare[j], left) : Math.min(spare[j], Math.round((over * spare[j]) / tot));
        left -= d;
        return v - d;
      });
    }
  }
  fixed.forEach((i, j) => {
    out[i] = ws[j];
  });
  out[flex] = Math.max(0, avail - sum());
  return out;
}

function useWidth(ref) {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/**
 * Flex di un pannello nella colonna. Lo slot con un separatore sotto parte da GAP (il separatore) e tutti si
 * dividono il resto secondo le frazioni: così le altezze dei *pannelli* stanno esattamente in proporzione.
 * null (o un valore che non corrisponde più al numero di pannelli): parti uguali.
 */
function slotFlex(n, k, ratio) {
  if (n === 1) return '1 1 0px';
  let r = 1;
  if (Array.isArray(ratio) && ratio.length === n) r = ratio[k];
  else if (n === 2 && num(ratio)) r = k === 0 ? ratio : 1 - ratio;
  return `${r} 1 ${k < n - 1 ? GAP : 0}px`;
}

const panelKey = (p) => p.tabs.slice().sort().join('+');
const COL_NAME = ['Sinistra', 'Centro', 'Destra'];

const MenuIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);
const XIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

/* ---------------------------------------------------------------------------------------------------- */
/* Riga delle linguette                                                                                   */
/* ---------------------------------------------------------------------------------------------------- */

/**
 * Linguette di un pannello con più schede (role tablist): frecce, Home e Fine cambiano scheda. Lo sfondo
 * della linguetta attiva con la riga verde è un indicatore che scivola (come .seg__ind in microanimazioni.css).
 */
function TabStrip({ panel, dragTab, onPick, onGrab, onGrabPanel, onClose, onClickGuard, children }) {
  const listRef = useRef(null);
  const [ind, setInd] = useState(null); // { x, w, go }
  const order = panel.tabs.join('|');
  useLayoutEffect(() => {
    const list = listRef.current;
    const measure = () => {
      const b = list?.querySelector('.ptab.is-on');
      if (!b) return;
      setInd((old) => (old && old.x === b.offsetLeft && old.w === b.offsetWidth ? old : { x: b.offsetLeft, w: b.offsetWidth, go: Boolean(old) }));
      // La linguetta attiva resta visibile anche quando le linguette non ci stanno tutte.
      if (b.offsetLeft < list.scrollLeft) list.scrollLeft = b.offsetLeft;
      else if (b.offsetLeft + b.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = b.offsetLeft + b.offsetWidth - list.clientWidth;
    };
    measure();
    if (!list || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  }, [panel.act, order]);
  const onKey = (e) => {
    const i = panel.tabs.indexOf(panel.act);
    const n = panel.tabs.length;
    let next = null;
    if (e.key === 'ArrowRight') next = panel.tabs[(i + 1) % n];
    else if (e.key === 'ArrowLeft') next = panel.tabs[(i + n - 1) % n];
    else if (e.key === 'Home') next = panel.tabs[0];
    else if (e.key === 'End') next = panel.tabs[n - 1];
    if (!next) return;
    e.preventDefault();
    onPick(next);
    requestAnimationFrame(() => document.getElementById(`ptab-${next}`)?.focus());
  };
  return (
    <div className="ptabs" onPointerDown={onGrabPanel} title="Trascina lo spazio vuoto per spostare il pannello con tutte le schede">
      <div className="ptabs__list" role="tablist" aria-label="Schede del pannello" ref={listRef} onKeyDown={onKey}>
        {ind && (
          <span className={`ptabs__ind ${ind.go ? 'ptabs__ind--go' : ''}`} aria-hidden="true" style={{ width: ind.w, transform: `translateX(${ind.x}px)` }} />
        )}
        {panel.tabs.map((t) => {
          const on = t === panel.act;
          return (
            <div key={t} className={`ptab${on ? ' is-on' : ''}${dragTab === t ? ' is-src' : ''}`} data-tab={t}>
              <button
                type="button"
                role="tab"
                id={`ptab-${t}`}
                className="ptab__l"
                aria-selected={on}
                aria-controls={on ? `pbody-${t}` : undefined}
                tabIndex={on ? 0 : -1}
                title={`${TAB_LABEL[t]}: trascina per spostare la scheda`}
                onPointerDown={onGrab(t)}
                onClick={() => {
                  if (onClickGuard()) return;
                  onPick(t);
                }}
              >
                {TAB_LABEL[t]}
              </button>
              {on && (
                <button type="button" className="ptab__x" aria-label={`Chiudi ${TAB_LABEL[t]}`} {...suggerimento(`Chiudi ${TAB_LABEL[t]} (torna dal menu ≡)`)} onClick={() => onClose(t)}>
                  <XIcon />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------------- */
/* Menu ≡ del pannello                                                                                    */
/* ---------------------------------------------------------------------------------------------------- */

function PanelMenu({ anchor, items, chiuse, onReopen, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right), maxHeight: Math.max(160, window.innerHeight - r.bottom - 16) });
  }, [anchor]);
  useEffect(() => {
    ref.current?.querySelector('.pop__item:not([aria-disabled="true"])')?.focus();
    const down = (e) => {
      if (!ref.current?.contains(e.target) && !anchor.contains(e.target)) onClose(false);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [anchor, onClose]);
  const onKey = (e) => {
    const all = [...ref.current.querySelectorAll('.pop__item:not([aria-disabled="true"])')];
    const i = all.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = all.length;
      all[(i + (e.key === 'ArrowDown' ? 1 : n - 1) + n) % n]?.focus();
    } else if (e.key === 'Tab') {
      onClose(false);
    }
  };
  return (
    <div className="pop pnl__menu" role="menu" aria-label="Menu del pannello" ref={ref} tabIndex={-1} onKeyDown={onKey} style={pos || { visibility: 'hidden' }}>
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className={`pop__item${it.danger ? ' pop__item--danger' : ''}`}
          aria-disabled={it.disabled || undefined}
          title={it.disabled ? it.why : undefined}
          onClick={() => {
            if (it.disabled) return;
            it.run();
            onClose(true);
          }}
        >
          {it.label}
        </button>
      ))}
      {chiuse.length > 0 && (
        <>
          {items.length > 0 && <div className="pop__sep" role="separator" />}
          <p className="pnl__menulab" aria-hidden="true">Riapri qui</p>
          {chiuse.map((t) => (
            <button
              key={t}
              type="button"
              role="menuitem"
              className="pop__item"
              onClick={() => {
                onReopen(t);
                onClose(true);
              }}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------------- */
/* Pannelli                                                                                               */
/* ---------------------------------------------------------------------------------------------------- */

/**
 * `render(tab, width)` restituisce { title, lead?, tools?, body } per ogni scheda: `lead` (es. il campo di
 * ricerca della Coda) e `tools` vanno accanto al titolo (scheda sola) o nella riga strumenti (più schede).
 * `head`: il blocco fisso dell'intestazione (marchio e stato). `headPos` ('tl' | 'tr' | 'bl' | 'br') sceglie
 * l'angolo: in cima (t) o in fondo (b) alla prima (l) o all'ultima (r) colonna che ha pannelli.
 */
export default function Panels({ layout, onChange, onAct, render, head, headPos = 'tl' }) {
  const rootRef = useRef(null);
  const total = useWidth(rootRef);
  const widths = columnWidths(total, layout.w, layout.cols);
  const [drag, setDrag] = useState(null); // { mode: 'tab' | 'panel', tab?, c, k }: ciò che si sta spostando
  const [hover, setHover] = useState(null); // dove cadrebbe: { kind, c, k, idx?, side?, line?, size?, col? }
  const [resizing, setResizing] = useState(null); // 'col0-1' | 'row0-0'…
  const [menu, setMenu] = useState(null); // { c, k, anchor }
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const hoverRef = useRef(null);
  hoverRef.current = hover;
  const ghostRef = useRef(null);
  const ghostPos = useRef({ x: 0, y: 0 });
  const dragged = useRef(false); // il clic che segue un trascinamento non cambia scheda

  // Un solo gestore per puntatore e tasti finché dura il gesto; si stacca da solo alla fine.
  // Il puntatore resta «catturato» dall'elemento afferrato: anche uscendo dal separatore o dall'iframe
  // dell'Activity gli eventi continuano ad arrivare, e un rilascio perso non lascia il gesto appeso.
  const startGesture = useCallback((e, onMove, onEnd) => {
    const el = e.currentTarget;
    const id = e.pointerId;
    try {
      el.setPointerCapture(id);
    } catch {
      // puntatore già rilasciato: il gesto vive coi soli eventi della finestra
    }
    let done = false;
    const stop = (ok) => {
      if (done) return;
      done = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      el.removeEventListener('lostpointercapture', lost);
      try {
        if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
      } catch {
        // già rilasciato
      }
      onEnd(ok);
    };
    function move(ev) {
      if (ev.pointerId !== id) return;
      if (ev.pointerType === 'mouse' && ev.buttons === 0) {
        stop(true); // il rilascio è avvenuto fuori e non è arrivato: chiudi qui
        return;
      }
      onMove(ev);
    }
    function up(ev) {
      if (ev.pointerId === id) stop(true);
    }
    function cancel(ev) {
      if (ev.pointerId === id) stop(false);
    }
    function lost() {
      stop(true);
    }
    function key(ev) {
      if (ev.key === 'Escape') stop(false);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    el.addEventListener('lostpointercapture', lost);
  }, []);

  /**
   * Dove cadrebbe ciò che si trascina (`d`) lasciato nel punto (x, y): la zona di rilascio visibile sotto il
   * puntatore (data-drop, disegnate da renderSlot e dalle colonne). null = da nessuna parte.
   */
  const hitAt = useCallback((x, y, d) => {
    const z = document.elementFromPoint(x, y)?.closest?.('[data-drop]');
    if (!z || !rootRef.current?.contains(z)) return null;
    const [what, cs, ks, side] = z.getAttribute('data-drop').split('|');
    const c = Number(cs);
    const l = layoutRef.current;
    if (what === 'col') return { kind: 'split', c, k: 0, side: ks, col: true }; // col|c|lato
    const k = Number(ks);
    const T = l.cols[c]?.[k];
    const S = l.cols[d.c]?.[d.k];
    if (!T || !S) return null;
    if (what === 'zone') {
      if (side === 'join') return { kind: 'join', c, k };
      // Altezza che avrà il pannello nuovo: la colonna si divide in parti uguali (vedi resetRatios).
      const stack = z.closest('.panels__stack');
      const m = l.cols[c].length + (d.mode === 'panel' && d.c === c ? 0 : 1);
      const size = stack ? Math.round((stack.clientHeight - GAP * (m - 1)) / m) : 0;
      return { kind: 'split', c, k, side, size };
    }
    // Riga in cima: una scheda sola = unisci; più schede = tra le linguette, prima della prima linguetta che ha
    // il centro a destra del puntatore.
    if (T.tabs.length === 1) return { kind: 'join', c, k };
    const sec = z.closest('[data-pnl]');
    const r = sec.getBoundingClientRect();
    const els = [...sec.querySelectorAll('.ptab')];
    let idx = els.length;
    for (let i = 0; i < els.length; i++) {
      const b = els[i].getBoundingClientRect();
      if (x < b.left + b.width / 2) {
        idx = i;
        break;
      }
    }
    if (T === S) {
      const oi = T.tabs.indexOf(d.tab);
      if (idx === oi || idx === oi + 1) return null;
    }
    const ref = els[Math.min(idx, els.length - 1)].getBoundingClientRect();
    const line = Math.round((idx < els.length ? ref.left : ref.right) - r.left - 1);
    return { kind: 'tab', c, k, idx, line };
  }, []);

  /**
   * Afferra una linguetta (`d.mode === 'tab'`) o il pannello intero (`'panel'`). Il trascinamento parte col
   * mouse dopo 5 px; col dito dopo una pressione di 250 ms (muovendosi meno di 8 px: prima di allora è un tocco).
   */
  const grab = (d, bar = false) => (e) => {
    if (e.button !== 0) return;
    const touch = e.pointerType === 'touch';
    if (bar && !touch) e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let active = false;
    let off = false; // dito mosso prima dei 250 ms: niente trascinamento
    let timer = null;
    dragged.current = false;
    const follow = (x, y) => {
      ghostPos.current = { x: x + 12, y: y + 12 };
      if (ghostRef.current) ghostRef.current.style.transform = `translate(${ghostPos.current.x}px, ${ghostPos.current.y}px)`;
      const h = hitAt(x, y, d);
      if (JSON.stringify(h) !== JSON.stringify(hoverRef.current)) {
        hoverRef.current = h;
        setHover(h);
      }
    };
    const last = { x: x0, y: y0 };
    const activate = () => {
      active = true;
      dragged.current = true;
      setMenu(null);
      setDrag(d);
      // Le zone compaiono al prossimo disegno: si cerca subito dopo quella sotto il puntatore.
      ghostPos.current = { x: last.x + 12, y: last.y + 12 };
      requestAnimationFrame(() => follow(last.x, last.y));
    };
    if (touch) {
      timer = setTimeout(() => {
        timer = null;
        if (!off) activate();
      }, 250);
    }
    startGesture(
      e,
      (ev) => {
        last.x = ev.clientX;
        last.y = ev.clientY;
        if (!active) {
          const dist = Math.hypot(ev.clientX - x0, ev.clientY - y0);
          if (touch) {
            if (dist > 8) off = true;
            return;
          }
          if (dist < 5) return;
          activate();
        }
        follow(ev.clientX, ev.clientY);
      },
      (ok) => {
        if (timer) clearTimeout(timer);
        if (active && ok && hoverRef.current) onChange(dropOn(layoutRef.current, d, hoverRef.current));
        hoverRef.current = null;
        setDrag(null);
        setHover(null);
        // Il clic arriva subito dopo il rilascio: dopo un trascinamento lo si ignora.
        setTimeout(() => {
          dragged.current = false;
        }, 0);
      },
    );
  };
  const grabTab = (c, k, tab) => grab({ mode: 'tab', tab, c, k });
  // Pannello intero: dallo spazio vuoto della riga linguette o dal titolo della scheda sola (non dai controlli).
  const grabPanel = (c, k) => (e) => {
    if (e.target.closest('.ptab, button, input, select, textarea, a, label, [role="button"]')) return;
    grab({ mode: 'panel', c, k }, true)(e);
  };

  // Colonne: ogni passo si calcola dalle misure congelate al pointerdown + (clientX attuale − iniziale), mai
  // dal movimento: il separatore resta sotto il puntatore e, dopo un limite, riprende dal punto giusto.
  // Si congelano le larghezze *mostrate* delle laterali (quelle salvate possono essere più larghe, ristrette
  // solo a schermo per far stare il centro). Il separatore tra a e b muove la colonna laterale dei due.
  const grabColumn = (a, b) => (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const l = layoutRef.current;
    const vis = visibleCols(l.cols);
    const flex = flexCol(vis);
    const side = a !== flex ? a : b; // la colonna che ha una larghezza scelta
    const sign = side === a ? 1 : -1;
    const base = l.w.slice();
    vis.filter((i) => i !== flex).forEach((i) => {
      base[wIndex(i)] = widths[i];
    });
    const others = vis.filter((i) => i !== flex && i !== side).reduce((s, i) => s + widths[i], 0);
    const min = sideMin(l.cols, wIndex(side)); // 300 se nella colonna c'è il Lettore
    const max = Math.max(min, Math.min(MAX_SIDE, total - GAP * (vis.length - 1) - MIN_CENTER - others));
    const wi = wIndex(side);
    setResizing(`col${a}-${b}`);
    startGesture(
      e,
      (ev) => {
        const dx = ev.clientX - x0;
        const w = base.slice();
        w[wi] = Math.round(Math.max(min, Math.min(max, base[wi] + sign * dx)));
        onChange({ ...layoutRef.current, w });
      },
      () => setResizing(null),
    );
  };

  // Separatore k di una colonna (tra il pannello k e il k+1): al pointerdown si congelano le altezze
  // mostrate di tutti i pannelli; a ogni passo il pannello k prende (clientY attuale − iniziale) e il k+1 lo
  // perde, gli altri restano fermi. Le nuove altezze (dei pannelli, separatori esclusi, come in slotFlex)
  // diventano frazioni dello spazio della colonna.
  const grabRow = (c, k) => (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const y0 = e.clientY;
    const slots = [...e.currentTarget.parentElement.parentElement.children].filter((n) => n.classList.contains('panels__slot'));
    const h = slots.map((n, i) => n.getBoundingClientRect().height - (i < slots.length - 1 ? GAP : 0));
    const space = h.reduce((a, b) => a + b, 0);
    if (space <= 0 || !h[k + 1]) return;
    const pair = h[k] + h[k + 1];
    // Ognuno dei due resta almeno alla sua altezza minima; se non ci stanno tutti e due, non si muove.
    const pnls = layoutRef.current.cols[c];
    const lo = Math.min(h[k], minHeight(pnls[k], widths[c]));
    const hi = Math.max(lo, pair - Math.min(h[k + 1], minHeight(pnls[k + 1], widths[c])));
    setResizing(`row${c}-${k}`);
    startGesture(
      e,
      (ev) => {
        const next = h.slice();
        next[k] = Math.max(lo, Math.min(hi, h[k] + ev.clientY - y0));
        next[k + 1] = pair - next[k];
        const ratio = layoutRef.current.ratio.slice();
        ratio[c] = next.length === 2 ? next[0] / space : next.map((v) => v / space);
        onChange({ ...layoutRef.current, ratio });
      },
      () => setResizing(null),
    );
  };

  const closeMenu = useCallback((refocus) => {
    setMenu((m) => {
      if (refocus && m?.anchor?.isConnected) requestAnimationFrame(() => m.anchor.focus());
      return null;
    });
  }, []);

  const menuButton = (c, k) => (
    <button
      type="button"
      className="pnl__menubtn"
      aria-label="Menu del pannello"
      {...suggerimento('Menu del pannello')}
      aria-haspopup="menu"
      aria-expanded={menu?.c === c && menu?.k === k}
      onClick={(e) => {
        const anchor = e.currentTarget;
        setMenu((m) => (m && m.c === c && m.k === k ? null : { c, k, anchor }));
      }}
    >
      <MenuIcon />
    </button>
  );

  const menuItems = (c, k) => {
    const l = layout;
    const pnl = l.cols[c][k];
    const act = pnl.act;
    const items = [];
    if (pnl.tabs.length > 1) {
      const side = freeSide(l, c, k);
      items.push({
        label: `Separa «${TAB_LABEL[act]}» in un pannello nuovo`,
        disabled: !side,
        why: 'Non c’è posto per un pannello nuovo: chiudine uno o unisci due schede',
        run: () => onChange(moveTab(l, act, { c, k }, { kind: 'split', c, k, side })),
      });
      items.push({ label: `Chiudi la scheda «${TAB_LABEL[act]}»`, run: () => onChange(closeTab(l, c, k, act)) });
    }
    if (l.cols.flat().length > 1) {
      items.push({ label: 'Chiudi il pannello', danger: true, run: () => onChange(closePanel(l, c, k)) });
    }
    return items;
  };

  const vis = visibleCols(layout.cols);
  const headCol = headPos[1] === 'r' ? vis[vis.length - 1] : vis[0];
  const headBottom = headPos[0] === 'b';
  const headBox = head && (
    <div key="head" className={`panels__head panels__head--${headPos}`}>
      {head}
    </div>
  );
  const cls = ['panels', drag && 'is-moving', resizing?.startsWith('col') && 'is-resizing-x', resizing?.startsWith('row') && 'is-resizing-y']
    .filter(Boolean).join(' ');

  const renderSlot = (c, k, pnl, n) => {
    const width = widths[c];
    const p = render(pnl.act, width);
    const multi = pnl.tabs.length > 1;
    const minH = minHeight(pnl, width) + (k < n - 1 ? GAP : 0);
    const on = hover && !hover.col && hover.c === c && hover.k === k ? hover : null;
    const headH = multi ? TABS_H : BAR;
    const isSrc = drag && drag.c === c && drag.k === k && (drag.mode === 'panel' || !multi);
    // Durante il trascinamento: zone di rilascio su ogni pannello (tratteggiate) e, sotto il puntatore, la
    // sagoma verde di dove finirà, grande come sarà.
    const zo = drag ? dropOptions(layout, drag, c, k) : null;
    const cz = drag ? colOptions(layout, c) : null;
    const what = drag && (drag.mode === 'panel' ? `«${layout.cols[drag.c][drag.k].tabs.map((t) => TAB_LABEL[t]).join(' + ')}»` : `«${TAB_LABEL[drag.tab]}»`);
    const zKey = (side) => `zone|${c}|${k}|${side}`;
    const zOn = (side) => (side === 'join' ? on?.kind === 'join' && !on.head : on?.kind === 'split' && on.side === side);
    let zones = null;
    if (zo) {
      const zone = (side, label) => (
        <div key={side} aria-hidden="true" data-drop={zKey(side)} className={`pnl__zone pnl__zone--${side}${zOn(side) ? ' is-on' : ''}`}>
          <span>{label}</span>
        </div>
      );
      zones = (
        <>
          {zo.head && <div aria-hidden="true" className={`pnl__zhead${on && (on.kind === 'tab' || (on.kind === 'join' && !multi)) ? ' is-on' : ''}`} data-drop={`head|${c}|${k}`} style={{ height: headH }} />}
          <div aria-hidden="true" className={`pnl__zones${cz.left ? ' pnl__zones--l' : ''}${cz.right ? ' pnl__zones--r' : ''}`} style={{ top: headH }}>
            {zo.top ? zone('top', 'Sopra') : <div className="pnl__zgap" />}
            {zo.join ? zone('join', 'Unisci come schede') : <div className="pnl__zgap pnl__zgap--mid" />}
            {zo.bottom ? zone('bottom', 'Sotto') : <div className="pnl__zgap" />}
          </div>
        </>
      );
    }
    let overlay = null;
    if (on?.kind === 'tab') overlay = <span className="pnl__line" aria-hidden="true" style={{ left: on.line }} />;
    else if (on?.kind === 'join') {
      overlay = (
        <span className="pnl__sil" aria-hidden="true" style={{ top: headH + 4, left: 4, right: 4, bottom: 4 }}>
          <b>{`${what} entra in «${p.title}»`}</b>
        </span>
      );
    } else if (on?.kind === 'split') {
      const h = `min(${Math.max(56, on.size || 0)}px, calc(100% - 24px))`;
      const box = on.side === 'top' ? { top: 4, left: 4, right: 4, height: h } : { bottom: 4, left: 4, right: 4, height: h };
      overlay = (
        <span className="pnl__sil" aria-hidden="true" style={box}>
          <b>{`${what} ${on.side === 'top' ? 'sopra' : 'sotto'}`}</b>
        </span>
      );
    }
    const hasTools = p.lead || p.tools;
    return (
      <div key={panelKey(pnl)} className="panels__slot" style={{ flex: slotFlex(n, k, layout.ratio[c]), minHeight: minH }}>
        <section className={`pnl${multi ? ' pnl--tabs' : ''}${isSrc ? ' is-src' : ''}`} aria-label={p.title} data-pnl={`${c}-${k}`}>
          {multi ? (
            <>
              <TabStrip
                panel={pnl}
                dragTab={drag?.c === c && drag?.k === k ? drag.tab : null}
                onPick={(t) => onAct(c, k, t)}
                onGrab={(t) => grabTab(c, k, t)}
                onGrabPanel={grabPanel(c, k)}
                onClose={(t) => onChange(closeTab(layout, c, k, t))}
                onClickGuard={() => dragged.current}
              >
                {menuButton(c, k)}
              </TabStrip>
              {hasTools && (
                <div className="pnl__bar pnl__bar--tools">
                  {p.lead}
                  {p.tools}
                </div>
              )}
            </>
          ) : (
            <div className="pnl__bar" onPointerDown={grabPanel(c, k)} title="Trascina dal titolo per spostare il pannello">
              <h2 className="pnl__title">{p.title}</h2>
              {p.lead}
              {p.tools}
              {layout.chiuse.length > 0 && menuButton(c, k)}
            </div>
          )}
          <div
            className="pnl__body"
            id={multi ? `pbody-${pnl.act}` : undefined}
            role={multi ? 'tabpanel' : undefined}
            aria-labelledby={multi ? `ptab-${pnl.act}` : undefined}
          >
            {p.body}
          </div>
          {zones}
          {overlay}
        </section>
        {k < n - 1 && (
          <div
            className={`panels__hres ${resizing === `row${c}-${k}` ? 'is-on' : ''}`}
            onPointerDown={grabRow(c, k)}
            role="separator"
            aria-orientation="horizontal"
            title="Trascina per cambiare l'altezza dei pannelli"
          >
            <i />
          </div>
        )}
      </div>
    );
  };

  // Colonna nuova: una striscia tratteggiata sul bordo della colonna accanto a una colonna vuota; sotto il
  // puntatore la sagoma verde larga quanto sarà la colonna nuova.
  const colZones = (c) => {
    const cz = colOptions(layout, c);
    return ['left', 'right'].filter((side) => cz[side]).map((side) => {
      const on = hover?.col && hover.c === c && hover.side === side;
      let w = 0;
      if (on) {
        const res = dropOn(layout, drag, hover);
        w = columnWidths(total, res.w, res.cols)[c + (side === 'left' ? -1 : 1)];
      }
      return (
        <div key={side} className="panels__zcolbox" aria-hidden="true">
          <div data-drop={`col|${c}|${side}`} className={`panels__zcol panels__zcol--${side}${on ? ' is-on' : ''}`}>
            <span>{side === 'left' ? 'Nuova colonna a sinistra' : 'Nuova colonna a destra'}</span>
          </div>
          {on && (
            <span className={`pnl__sil pnl__sil--col panels__zsil--${side}`} style={{ width: `min(${w}px, 70%)` }}>
              <b>{`Nuova colonna · ${w} px`}</b>
            </span>
          )}
        </div>
      );
    });
  };

  const menuPanel = menu && layout.cols[menu.c]?.[menu.k];

  return (
    <div className={cls} ref={rootRef}>
      {total > 0 && vis.map((c, vi) => {
        const ids = layout.cols[c];
        const next = vis[vi + 1];
        return (
          <div key={c} className="panels__group">
            <div className="panels__col" style={{ width: widths[c] }}>
              {c === headCol && !headBottom && headBox}
              <div key="stack" className="panels__stackwrap">
                <div className="panels__stack">{ids.map((pnl, k) => renderSlot(c, k, pnl, ids.length))}</div>
                {drag && colZones(c)}
              </div>
              {c === headCol && headBottom && headBox}
            </div>
            {next != null && (
              <div
                className={`panels__vres ${resizing === `col${c}-${next}` ? 'is-on' : ''}`}
                onPointerDown={grabColumn(c, next)}
                role="separator"
                aria-orientation="vertical"
                title="Trascina per allargare o stringere la colonna"
              >
                <i />
                {resizing === `col${c}-${next}` && (
                  <span className="panels__tip">
                    {`${COL_NAME[c]} ${widths[c]} px · ${COL_NAME[next].toLowerCase()} ${widths[next]} px`}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
      {drag && (
        <div className="ptab-ghost" ref={ghostRef} aria-hidden="true" style={{ transform: `translate(${ghostPos.current.x}px, ${ghostPos.current.y}px)` }}>
          {drag.mode === 'panel' ? layout.cols[drag.c]?.[drag.k]?.tabs.map((t) => TAB_LABEL[t]).join(' · ') : TAB_LABEL[drag.tab]}
        </div>
      )}
      {menuPanel && (
        <PanelMenu
          anchor={menu.anchor}
          items={menuItems(menu.c, menu.k)}
          chiuse={layout.chiuse}
          onReopen={(t) => onChange(reopenTab(layout, menu.c, menu.k, t))}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}

/** Miniatura di una disposizione: [peso della colonna, [altezze dei pannelli]] (solo le colonne visibili). */
export const MINI_EMPTY = [[1, [1]], [2.2, [0.5, 1]], [1, [1, 1]]];
export function miniOf(l) {
  const f = [l.w[0], Math.max(MIN_CENTER, 1240 - l.w[0] - l.w[1]), l.w[1]];
  const rows = (ids, r) => {
    if (ids.length === 1) return [1];
    if (Array.isArray(r) && r.length === ids.length) return r;
    if (ids.length === 2 && num(r)) return [r, 1 - r];
    return ids.map(() => 1); // null: parti uguali
  };
  return l.cols.map((ids, c) => [f[c], rows(ids, l.ratio[c])]).filter((_, c) => l.cols[c].length > 0);
}
export function Mini({ cols, state }) {
  return (
    <span className={`lmenu__mini${state ? ` lmenu__mini--${state}` : ''}`} aria-hidden="true">
      {cols.map(([f, rows], i) => (
        <span key={i} style={{ flex: f }}>
          {rows.map((r, j) => <i key={j} style={{ flex: r }} />)}
        </span>
      ))}
    </span>
  );
}

export const labelOf = (choice) => (choice === CUSTOM ? 'Personalizzata' : PRESETS[choice].label);
export { STORE as LAYOUT_KEY, GAP as PANEL_GAP };
