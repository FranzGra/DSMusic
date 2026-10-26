import { useCallback, useEffect, useRef, useState } from 'react';
import { suggerimento } from './Suggerimento.jsx';
import { createPortal } from 'react-dom';
import * as I from './icons.jsx';
import { CHOICES, CUSTOM, LAYOUT_KEY, PANEL_GAP, PRESETS, MINI_EMPTY, Mini, labelOf, leggiDisposizione, miniOf, stessaDisposizione } from './Panels.jsx';
import { INTENSITA, PANNELLI } from './ambiente.js';
import { Volume } from './NowPlaying.jsx';
import './intestazione.css';

/**
 * Intestazione in alto a sinistra: [pallino di stato] FranzDSMusic ⌄ e sotto una riga con lo stato.
 *  verde  = bot nel canale e musica che suona;
 *  arancio = nel canale ma musica ferma (pausa, coda vuota, uscita in arrivo);
 *  rosso  = bot fuori dal canale o non collegato.
 * Un clic sul titolo apre il menu: stato, Ferma, Disposizione, Esporta e Importa disposizione, Aspetto (Modalità Ambiente).
 */
const COLORI = { ok: '#1ed760', warn: '#ffa42b', off: '#f15e6c' };

/** Tono e riga di stato ricavati dai dati veri dello stato del client. */
export function statoBot({ state, status, statusLabel, leaveText }) {
  if (status !== 'online') return { tone: 'off', line: statusLabel || 'Non collegato' };
  if (!state) return { tone: 'off', line: statusLabel || 'Mi collego…' };
  if (!state.inVoice || state.away) return { tone: 'off', line: 'Fuori dal canale' };
  const nome = state.channelName ? ` · ${state.channelName}` : '';
  const suona = Boolean(state.current) && !state.paused;
  if (suona) return { tone: 'ok', line: `Nel canale${nome}`, playing: true };
  return { tone: 'warn', line: `${leaveText || 'Musica ferma'}${nome}` };
}

const Chevron = () => <I.Chevron width={16} height={16} />;

/** Angolo dell'intestazione nella vista a pannelli, salvato nel browser per persona come le disposizioni. */
export const POS_KEY = 'franzdsmusic.intestazione.posizione';
export const POSIZIONI = [
  ['tl', 'In alto a sinistra'],
  ['tr', 'In alto a destra'],
  ['bl', 'In basso a sinistra'],
  ['br', 'In basso a destra'],
];
const POS_OK = POSIZIONI.map(([k]) => k);

export function usePosizione() {
  const [pos, setPos] = useState(() => {
    try {
      const v = localStorage.getItem(POS_KEY);
      return POS_OK.includes(v) ? v : 'tl';
    } catch {
      return 'tl';
    }
  });
  const scegli = useCallback((k) => {
    if (!POS_OK.includes(k)) return;
    setPos(k);
    try {
      localStorage.setItem(POS_KEY, k);
    } catch {
      // browser senza memoria: la scelta vale fino al ricaricamento
    }
  }, []);
  return [pos, scegli];
}

// Cambiando colonna l'intestazione rinasce in un altro punto della pagina: il menu si riapre da solo lì,
// con il fuoco sull'angolo appena scelto.
let riapriSuPosizione = false;

/** Misure vere dei pannelli sullo schermo (px), per ricavare le frazioni giuste dei preset. */
function misura(layout) {
  const cols = [...document.querySelectorAll('.panels__col')];
  return {
    colonne: cols.map((c) => Math.round(c.getBoundingClientRect().width)),
    // Altezza di ogni pannello (separatore escluso), nello stesso ordine di cols.
    altezze: layout.cols.map((ids, c) => {
      const slots = cols[c] ? [...cols[c].querySelectorAll('.panels__slot')] : [];
      return ids.map((_, k) => (slots[k] ? Math.round(slots[k].getBoundingClientRect().height - (k < ids.length - 1 ? PANEL_GAP : 0)) : null));
    }),
  };
}

const pad = (n) => String(n).padStart(2, '0');
const adesso = () => {
  const d = new Date();
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Il JSON completo della disposizione in uso, come salvata nel browser, più la misura della finestra. */
export function esportaDisposizione(lay) {
  let salvato = null;
  try {
    salvato = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
  } catch {
    salvato = null;
  }
  const json = JSON.stringify(
    {
      data: adesso(),
      finestra: { larghezza: window.innerWidth, altezza: window.innerHeight },
      scelta: lay.choice,
      formato: 2,
      // Quella in uso: cols (per colonna i pannelli, ognuno { tabs: schede, act: scheda attiva }), w (px delle
      // colonne laterali), ratio (frazioni), chiuse (schede chiuse, da riaprire dal menu ≡).
      disposizione: lay.layout,
      misurato: misura(lay.layout),
      chiave: LAYOUT_KEY,
      salvato,
    },
    null,
    2,
  );
  // Le liste semplici (id dei pannelli, numeri) su una riga sola: più corto da incollare in chat.
  return json.replace(/\[([^[\]{}]*)\]/g,(_, dentro) => `[${dentro.split(',').map((s) => s.trim()).join(', ')}]`);
}

function ExportDialog({ lay, onClose }) {
  const [testo] = useState(() => esportaDisposizione(lay));
  const [esito, setEsito] = useState(null); // 'copiato' | 'manuale'
  const areaRef = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    areaRef.current?.focus();
    areaRef.current?.select();
  }, []);

  const copia = async () => {
    const area = areaRef.current;
    try {
      await navigator.clipboard.writeText(testo);
      setEsito('copiato');
    } catch {
      // Dentro Discord gli appunti possono essere bloccati: si seleziona tutto e si copia a mano.
      area?.focus();
      area?.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      setEsito(ok ? 'copiato' : 'manuale');
    }
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab') {
      // Il fuoco resta nel riquadro: area di testo → Copia → Chiudi.
      const els = [...e.currentTarget.querySelectorAll('textarea, button')];
      const i = els.indexOf(document.activeElement);
      const to = e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : (i === els.length - 1 ? 0 : i + 1);
      e.preventDefault();
      els[to].focus();
    }
  };

  return createPortal(
    <div className="modal" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal__box" role="dialog" aria-modal="true" aria-labelledby="esporta-titolo" onKeyDown={onKey}>
        <h2 id="esporta-titolo" className="modal__title">Esporta disposizione</h2>
        <p className="modal__text">
          Copia questo testo e incollalo in chat: serve per aggiornare le disposizioni «Player orizzontale» e «Player verticale».
        </p>
        <textarea
          ref={areaRef}
          className="modal__area"
          readOnly
          spellCheck={false}
          value={testo}
          aria-label="Disposizione in formato JSON"
          onFocus={(e) => e.target.select()}
        />
        <div className="modal__foot">
          <span className="modal__msg" role="status">
            {esito === 'copiato' && <><I.Check width={16} height={16} />Copiato</>}
            {esito === 'manuale' && 'Seleziona e copia con Ctrl+C'}
          </span>
          <button type="button" className="modal__btn" ref={closeRef} onClick={onClose}>Chiudi</button>
          <button type="button" className="modal__btn modal__btn--main" onClick={copia}>
            Copia
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Tab e Maiusc+Tab restano dentro il riquadro (area di testo e pulsanti). */
function tienFuoco(e) {
  const els = [...e.currentTarget.querySelectorAll('textarea, button:not(:disabled)')];
  if (!els.length) return;
  const i = els.indexOf(document.activeElement);
  const to = e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : (i === els.length - 1 ? 0 : i + 1);
  e.preventDefault();
  els[to].focus();
}

/**
 * «Importa disposizione»: si incolla il testo di «Esporta disposizione» (o solo { cols, w, ratio, chiuse }).
 * Le regole sono quelle del caricamento (leggiDisposizione in Panels.jsx); se non va, l'errore resta sotto
 * l'area di testo e non cambia niente. Se c'è già una Personalizzata diversa si chiede conferma con le miniature.
 */
function ImportDialog({ lay, onClose }) {
  const [testo, setTesto] = useState('');
  const [errore, setErrore] = useState(null);
  const [nuova, setNuova] = useState(null); // disposizione valida in attesa di conferma
  const areaRef = useRef(null);
  const sostRef = useRef(null);

  useEffect(() => {
    if (nuova) sostRef.current?.focus();
    else areaRef.current?.focus();
  }, [nuova]);

  const applica = (l) => {
    lay.importa(l);
    onClose();
  };
  const importa = () => {
    const { layout, errore: err } = leggiDisposizione(testo);
    if (!layout) {
      setErrore(err);
      areaRef.current?.focus();
      return;
    }
    if (lay.custom && !stessaDisposizione(lay.custom, layout)) setNuova(layout);
    else applica(layout);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (nuova) setNuova(null);
      else onClose();
    } else if (e.key === 'Tab') tienFuoco(e);
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !nuova) {
      e.preventDefault();
      importa();
    }
  };

  return createPortal(
    <div className="modal" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal__box" role="dialog" aria-modal="true" aria-labelledby="importa-titolo" onKeyDown={onKey}>
        <h2 id="importa-titolo" className="modal__title">Importa disposizione</h2>
        {nuova ? (
          <>
            <p className="modal__text" id="importa-conferma">
              Hai già una Personalizzata diversa: sostituirla con quella importata? La disposizione di adesso si perde.
            </p>
            <div className="modal__minis" aria-hidden="true">
              <figure><Mini cols={miniOf(lay.custom)} /><figcaption>Adesso</figcaption></figure>
              <I.Chevron width={18} height={18} className="modal__freccia" />
              <figure><Mini cols={miniOf(nuova)} state="on" /><figcaption>Importata</figcaption></figure>
            </div>
            <div className="modal__foot">
              <button type="button" className="modal__btn" onClick={() => setNuova(null)}>Indietro</button>
              <button type="button" className="modal__btn modal__btn--main" ref={sostRef} aria-describedby="importa-conferma" onClick={() => applica(nuova)}>
                Sostituisci
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="modal__text" id="importa-aiuto">
              Incolla qui il testo di «Esporta disposizione»: diventa la tua disposizione Personalizzata, salvata in questo browser.
            </p>
            <textarea
              ref={areaRef}
              className={`modal__area${errore ? ' is-bad' : ''}`}
              spellCheck={false}
              value={testo}
              placeholder='{"formato": 2, "disposizione": { "cols": … }}'
              aria-label="Disposizione da importare, in formato JSON"
              aria-invalid={errore ? true : undefined}
              aria-describedby={errore ? 'importa-errore' : 'importa-aiuto'}
              onChange={(e) => {
                setTesto(e.target.value);
                setErrore(null);
              }}
            />
            {errore && <p className="modal__err" id="importa-errore" role="alert">{errore}</p>}
            <div className="modal__foot">
              <button type="button" className="modal__btn" onClick={onClose}>Annulla</button>
              <button type="button" className="modal__btn modal__btn--main" disabled={!testo.trim()} onClick={importa}>
                Importa
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default function Intestazione({ info, state, send, lay, phone = false, pos = 'tl', onPos, amb }) {
  const [open, setOpen] = useState(() => riapriSuPosizione); // il segnale si spegne nell'effetto su `pos`
  const fuocoPos = useRef(open);
  const [confirm, setConfirm] = useState(false);
  const [esporta, setEsporta] = useState(false);
  const [importa, setImporta] = useState(false);
  const boxRef = useRef(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const resetRef = useRef(null);
  const refocusReset = useRef(false);
  const { tone, line } = info;
  const colore = COLORI[tone];

  const close = useCallback((toTitle) => {
    setOpen(false);
    setConfirm(false);
    if (toTitle) btnRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => !boxRef.current?.contains(e.target) && close(false);
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open, close]);

  const items = () => [...(popRef.current?.querySelectorAll('[role^="menuitem"]') ?? [])];
  useEffect(() => {
    if (!open) return;
    const sel = fuocoPos.current ? '.pq[aria-checked="true"]' : '[aria-checked="true"]';
    fuocoPos.current = false;
    (popRef.current?.querySelector(sel) || items()[0])?.focus();
  }, [open]);
  // Nella stessa colonna l'intestazione si sposta senza rinascere: il fuoco torna sull'angolo scelto.
  useEffect(() => {
    if (open) popRef.current?.querySelector('.pq[aria-checked="true"]')?.focus();
    riapriSuPosizione = false;
  }, [pos]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (confirm) popRef.current?.querySelector('.tmenu__btn--danger')?.focus();
    else if (refocusReset.current) {
      refocusReset.current = false;
      resetRef.current?.focus();
    }
  }, [confirm]);

  // Se lo stato cambia sotto il menu aperto (es. dopo «Ferma la musica») il fuoco non resta su una voce sparita.
  useEffect(() => {
    if (open && popRef.current && !popRef.current.contains(document.activeElement)) items()[0]?.focus();
  }, [tone, open]);

  const cancelConfirm = () => {
    refocusReset.current = true;
    setConfirm(false);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (confirm) cancelConfirm();
      else close(true);
      return;
    }
    if (confirm) return; // nella conferma Tab passa tra Ripristina e Annulla
    // Sul cursore del volume (telefono) le frecce cambiano il volume, non la voce del menu.
    if (e.target?.type === 'range' && e.key !== 'Tab') return;
    if (e.key === 'Tab') {
      e.preventDefault();
      close(true);
      return;
    }
    const list = items();
    const i = list.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (to === undefined || !list.length) return;
    e.preventDefault();
    list[(to + list.length) % list.length].focus();
  };

  const canStop = tone === 'ok';
  const canLeave = tone === 'ok' || tone === 'warn';
  const { choice, custom, pick, reset } = lay;

  return (
    <div
      className={`titolo${phone ? '' : ` titolo--${pos}`}`}
      ref={boxRef}
      onBlur={(e) => open && e.relatedTarget && !boxRef.current?.contains(e.relatedTarget) && close(false)}
    >
      <button
        type="button"
        ref={btnRef}
        className={`tbtn${open ? ' is-open' : ''}`}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? 'titolo-menu' : undefined}
        aria-label={`FranzDSMusic, ${line}. Apri il menu`}
      >
        <span className="tdot" aria-hidden="true">
          <i style={{ background: colore, boxShadow: `0 0 0 5px ${colore}33` }} />
        </span>
        <span className="ttxt">
          <span className="tname">FranzDSMusic<Chevron /></span>
          <span className="tstat">{line}</span>
        </span>
      </button>

      {open && (
        <div className="tmenu" id="titolo-menu" role="menu" aria-label="FranzDSMusic" ref={popRef} onKeyDown={onKey}>
          <p className="tmenu__stat"><i style={{ background: colore }} />{line}</p>
          {canStop && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="mi"
              title="Mette la musica in pausa; il bot resta nel canale"
              onClick={() => {
                send({ type: 'toggle' });
                close(true);
              }}
            >
              <span className="mi__ico"><I.Stop width={18} height={18} /></span>
              Ferma la musica
            </button>
          )}
          {canLeave && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="mi mi--danger"
              disabled={!state}
              onClick={() => {
                send({ type: 'stop' });
                close(true);
              }}
            >
              <span className="mi__ico">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" />
                </svg>
              </span>
              Ferma ed esci dal canale
            </button>
          )}

          {phone && (
            // Telefono: il Lettore a pagina intera non c'è più, il volume sta qui (decisione provvisoria, 26-10-2026).
            <>
              {(canStop || canLeave) && <div className="tmenu__sep" role="separator" />}
              <p className="tmenu__lab" id="titolo-vol-lab">Volume</p>
              <div className="tmenu__vol" role="group" aria-labelledby="titolo-vol-lab">
                <Volume state={state} send={send} />
              </div>
            </>
          )}

          {!phone && (
            <>
              {(canStop || canLeave) && <div className="tmenu__sep" role="separator" />}
              <p className="tmenu__lab" aria-hidden="true">Disposizione</p>
              {CHOICES.map((name) => {
                const on = choice === name;
                const off = name === CUSTOM && !custom;
                const mini = name !== CUSTOM ? miniOf(PRESETS[name]) : custom ? miniOf(custom) : MINI_EMPTY;
                return (
                  <button
                    key={name}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    aria-disabled={off || undefined}
                    tabIndex={-1}
                    className={`mi${on ? ' mi--on' : ''}`}
                    title={off ? 'Sposta un pannello per crearla' : undefined}
                    onClick={() => {
                      if (off) return;
                      pick(name);
                      close(true);
                    }}
                  >
                    <span className="mi__ico"><Mini cols={mini} state={off ? 'off' : on ? 'on' : null} /></span>
                    <span className="mi__txt">{labelOf(name)}</span>
                    {on && <I.Check width={16} height={16} />}
                  </button>
                );
              })}
              {onPos && (
                <>
                  <p className="tmenu__lab" id="titolo-pos-lab">Posizione</p>
                  <div className="tmenu__pos" role="group" aria-labelledby="titolo-pos-lab">
                    {POSIZIONI.map(([k, label]) => (
                      <button
                        key={k}
                        type="button"
                        role="menuitemradio"
                        aria-checked={pos === k}
                        aria-label={label}
                        {...suggerimento(label)}
                        tabIndex={-1}
                        className={`pq pq--${k}`}
                        onClick={() => {
                          if (k === pos) return;
                          riapriSuPosizione = true; // se l'intestazione cambia colonna, il menu si riapre là
                          onPos(k);
                        }}
                      >
                        <i aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </>
              )}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="mi"
                onClick={() => {
                  close(false);
                  setEsporta(true);
                }}
              >
                <span className="mi__ico">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" />
                  </svg>
                </span>
                Esporta disposizione
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="mi"
                onClick={() => {
                  close(false);
                  setImporta(true);
                }}
              >
                <span className="mi__ico">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 15V3" /><path d="m7 8 5-5 5 5" /><path d="M5 21h14" />
                  </svg>
                </span>
                Importa disposizione
              </button>
              {confirm ? (
                <div className="tmenu__confirm" role="group" aria-labelledby="titolo-confirm-txt">
                  <p id="titolo-confirm-txt">Riportare la Personalizzata alla disposizione di partenza (Player orizzontale)? Gli spostamenti fatti si perdono.</p>
                  <div className="tmenu__btns">
                    <button
                      type="button"
                      className="tmenu__btn tmenu__btn--danger"
                      onClick={() => {
                        reset();
                        close(true);
                      }}
                    >
                      Ripristina
                    </button>
                    <button type="button" className="tmenu__btn" onClick={cancelConfirm}>Annulla</button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  ref={resetRef}
                  tabIndex={-1}
                  aria-disabled={!custom || undefined}
                  className="mi"
                  onClick={() => custom && setConfirm(true)}
                >
                  <span className="mi__ico"><I.Reset width={18} height={18} /></span>
                  Ripristina la Personalizzata…
                </button>
              )}
            </>
          )}

          {amb && (
            <>
              <div className="tmenu__sep" role="separator" />
              <p className="tmenu__lab" aria-hidden="true">Aspetto</p>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={amb.on}
                tabIndex={-1}
                className="mi"
                title="Lo sfondo prende i colori della copertina del brano in corso"
                onClick={() => amb.accendi(!amb.on)}
              >
                <span className="mi__ico">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" /><circle cx="9" cy="10" r="1.5" /><circle cx="15" cy="9" r="1.5" /><circle cx="14" cy="15" r="1.5" />
                  </svg>
                </span>
                <span className="mi__txt">Modalità Ambiente</span>
                <span className={`msw${amb.on ? ' msw--on' : ''}`} aria-hidden="true" />
              </button>
              {amb.on && (
                <>
                  <p className="tmenu__lab tmenu__lab--sub" id="titolo-amb-int">Intensità</p>
                  <div className="tmenu__seg" role="group" aria-labelledby="titolo-amb-int">
                    {INTENSITA.map(([k, label, pct]) => (
                      <button
                        key={k}
                        type="button"
                        role="menuitemradio"
                        aria-checked={amb.intensita === k}
                        aria-label={`${label}, ${pct} %`}
                        tabIndex={-1}
                        className="mseg"
                        onClick={() => amb.scegliIntensita(k)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="tmenu__lab tmenu__lab--sub" id="titolo-amb-pan">Pannelli</p>
                  <div className="tmenu__seg" role="group" aria-labelledby="titolo-amb-pan">
                    {PANNELLI.map(([k, label]) => (
                      <button
                        key={k}
                        type="button"
                        role="menuitemradio"
                        aria-checked={amb.pannelli === k}
                        tabIndex={-1}
                        className="mseg"
                        title={k === 'traslucidi' ? 'Il colore passa anche dentro i pannelli (84 %)' : 'Pannelli pieni: leggibilità massima'}
                        onClick={() => amb.scegliPannelli(k)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
      {importa && (
        <ImportDialog
          lay={lay}
          onClose={() => {
            setImporta(false);
            btnRef.current?.focus();
          }}
        />
      )}
      {esporta && (
        <ExportDialog
          lay={lay}
          onClose={() => {
            setEsporta(false);
            btnRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
