import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { suggerimento } from './Suggerimento.jsx';
import * as I from './icons.jsx';

/*
 * Libreria di playlist condivisa dal server Discord, dentro il pannello Soundbar (id `suoni`).
 * Protocollo: playlistSave / playlistLoad / playlistRename / playlistDelete → playlistResult;
 * l'elenco arriva a parte nel messaggio `playlists`. Vedi SERVER-protocollo.md.
 */

// Scheda scelta (Soundbar, Libreria o Recenti), ricordata per persona nel browser.
const TAB_KEY = 'franzdsmusic.suoni.scheda';
export function useSuoniTab() {
  const [tab, setTab] = useState(() => {
    try {
      const v = localStorage.getItem(TAB_KEY);
      return v === 'libreria' || v === 'recenti' ? v : 'suoni';
    } catch {
      return 'suoni';
    }
  });
  const pick = useCallback((t) => {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* browser senza storage: la scelta vale solo per questa visita */
    }
  }, []);
  return [tab, pick];
}

export const brani = (n) => `${n} ${n === 1 ? 'brano' : 'brani'}`;

/** Durata leggibile: «1 h 38 min», «52 min», «2 h». Zero (solo dirette) → null. */
export function formatLength(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const min = Math.max(1, Math.round(sec / 60));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const canEditFor = (user) => (p) => Boolean(user && (user.isAdmin || p?.createdBy?.id === user.id));
const sameName = (a, b) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();
const NAME_CODES = new Set(['nome_usato', 'nome_vuoto', 'nome_lungo', 'permesso']);

/** Contenitore che scorre più vicino (per tenere visibile il menu «⋮» aperto). */
function scrollParent(el) {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if (o === 'auto' || o === 'scroll') return n;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Interruttore «Soundbar | Libreria | Recenti» nel titolo del pannello        */
/* ------------------------------------------------------------------ */

/**
 * Tre schede (role tablist): frecce, Home e Fine cambiano scheda. `wide` (pannello ≥ 480 px)
 * aggiunge icone e contatori. `idBase` rende unici gli id; il pannello ha id `${idBase}-pannello`.
 */
export function SuoniSwitch({ tab, onPick, wide = false, sounds, playlists, recents, idBase }) {
  const refs = { suoni: useRef(null), libreria: useRef(null), recenti: useRef(null) };
  // Indicatore verde che scivola sulla scheda scelta (microanimazioni.css, .seg__ind): posizione misurata.
  const segRef = useRef(null);
  const [ind, setInd] = useState(null); // { x, w, go } — go: dopo la prima misura le variazioni si animano
  useLayoutEffect(() => {
    const seg = segRef.current;
    const measure = () => {
      const b = refs[tab]?.current;
      if (!seg || !b) return;
      setInd((old) => (old && old.x === b.offsetLeft && old.w === b.offsetWidth ? old : { x: b.offsetLeft, w: b.offsetWidth, go: Boolean(old) }));
    };
    measure();
    if (!seg || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(seg);
    return () => ro.disconnect();
  }, [tab, wide]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = [
    ['suoni', 'Soundbar', I.Wave, sounds],
    ['libreria', 'Libreria', I.Library, playlists],
    ['recenti', 'Recenti', I.Clock, recents],
  ];
  const onKey = (e) => {
    const order = ['suoni', 'libreria', 'recenti'];
    let next = null;
    if (e.key === 'ArrowRight') next = order[(order.indexOf(tab) + 1) % 3];
    else if (e.key === 'ArrowLeft') next = order[(order.indexOf(tab) + 2) % 3];
    else if (e.key === 'Home') next = 'suoni';
    else if (e.key === 'End') next = 'recenti';
    if (!next) return;
    e.preventDefault();
    onPick(next);
    refs[next].current?.focus();
  };
  return (
    // title vuoto: niente suggerimento «Trascina…» della barra sopra i pulsanti.
    <div className="seg" role="tablist" aria-label="Contenuto del pannello" title="" onKeyDown={onKey} ref={segRef}>
      {ind && (
        <span
          className={`seg__ind ${ind.go ? 'seg__ind--go' : ''}`}
          aria-hidden="true"
          style={{ width: ind.w, transform: `translateX(${ind.x}px)` }}
        />
      )}
      {items.map(([id, label, Icon, n]) => (
        <button
          key={id}
          ref={refs[id]}
          id={`${idBase}-${id}`}
          type="button"
          role="tab"
          aria-selected={tab === id}
          aria-controls={`${idBase}-pannello`}
          tabIndex={tab === id ? 0 : -1}
          className={`seg__b ${tab === id ? 'seg__b--on' : ''}`}
          onClick={() => onPick(id)}
        >
          {wide && <Icon width={16} height={16} />}
          {label}
          {wide && n != null && <span className="seg__n">{n}</span>}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Libreria                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param playlists elenco dal server (null = non ancora arrivato)
 * @param user      { id, name, isAdmin } dal `welcome`
 * @param request   (msg) => Promise<playlistResult>
 * @param narrow    pannello stretto: il conteggio delle playlist sta nel corpo, non nel titolo
 */
export default function Library({ playlists, user, current, queue = [], disabled = false, narrow = true, request }) {
  const canEdit = canEditFor(user);
  const [save, setSave] = useState(null); // null | { name, err, busy }
  const [note, setNote] = useState(null); // riscontro in alto: { text }
  const [active, setActive] = useState(null); // { id, mode: 'menu'|'rename'|'replace'|'delete', name?, err?, busy? }
  const [flash, setFlash] = useState(null); // riscontro su una riga: { id, text, kind: 'ok'|'error' }
  const [loading, setLoading] = useState(null); // { id, mode } durante un caricamento
  const noteTimer = useRef(null);
  const flashTimer = useRef(null);
  const saveBtn = useRef(null);
  const nameInput = useRef(null);

  useEffect(() => () => {
    clearTimeout(noteTimer.current);
    clearTimeout(flashTimer.current);
  }, []);

  const showNote = (text) => {
    clearTimeout(noteTimer.current);
    setNote({ text });
    noteTimer.current = setTimeout(() => setNote(null), 4500);
  };
  const showFlash = (id, text, kind = 'ok') => {
    clearTimeout(flashTimer.current);
    setFlash({ id, text, kind });
    flashTimer.current = setTimeout(() => setFlash(null), kind === 'error' ? 8000 : 4500);
  };

  // Una playlist sparita (eliminata da un altro) chiude menu e conferme aperte su di lei.
  useEffect(() => {
    if (active && playlists && !playlists.some((p) => p.id === active.id)) setActive(null);
  }, [playlists, active]);

  const count = (current ? 1 : 0) + queue.length;
  const seconds = (current?.duration || 0) + queue.reduce((s, t) => s + (t.duration || 0), 0);

  /* ---------- salva la coda ---------- */
  const openSave = () => {
    setActive(null);
    setNote(null);
    setSave({ name: '', err: null, busy: false });
  };
  const closeSave = () => {
    setSave(null);
    requestAnimationFrame(() => saveBtn.current?.focus());
  };
  const submitSave = async (overwrite = false) => {
    const name = save.name.trim().replace(/\s+/g, ' ');
    if (!name) {
      setSave((s) => ({ ...s, err: { code: 'nome_vuoto', error: 'Scrivi un nome per la playlist.' } }));
      nameInput.current?.focus();
      return;
    }
    setSave((s) => ({ ...s, busy: true }));
    const r = await request({ type: 'playlistSave', name, ...(overwrite ? { overwrite: true } : {}) });
    if (r.ok) {
      setSave(null);
      const n = r.playlist?.count ?? count;
      showNote(
        `${r.overwritten ? 'Sovrascritta' : 'Salvata'} «${r.playlist?.name || name}»: ${brani(n)}` +
          (r.truncated ? ' (solo i primi 1000)' : '') + '.',
      );
      requestAnimationFrame(() => saveBtn.current?.focus());
      return;
    }
    const existing = r.code === 'nome_usato' ? playlists?.find((p) => sameName(p.name, name)) : null;
    setSave((s) => (s ? { ...s, busy: false, err: { code: r.code, error: r.error || 'Non sono riuscito a salvare.', existing } } : s));
    if (r.code !== 'nome_usato') nameInput.current?.focus();
  };

  /* ---------- azioni su una playlist ---------- */
  const load = async (p, mode) => {
    setActive(null);
    setLoading({ id: p.id, mode });
    const r = await request({ type: 'playlistLoad', id: p.id, mode });
    setLoading(null);
    if (!r.ok) return showFlash(p.id, r.error || 'Non sono riuscito a caricarla.', 'error');
    const n = r.count ?? p.count;
    showFlash(p.id, mode === 'replace' ? `Coda sostituita: ${brani(n)}.` : `${n === 1 ? 'Aggiunto' : 'Aggiunti'} ${brani(n)} in coda.`);
  };
  const rename = async (p, raw) => {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (!name) return setActive((a) => ({ ...a, err: { code: 'nome_vuoto', error: 'Scrivi un nome per la playlist.' } }));
    if (name === p.name) return setActive(null);
    setActive((a) => ({ ...a, busy: true, err: null }));
    const r = await request({ type: 'playlistRename', id: p.id, name });
    if (r.ok) {
      setActive(null);
      showFlash(p.id, 'Nome cambiato.');
    } else {
      setActive((a) => (a?.id === p.id ? { ...a, busy: false, err: { code: r.code, error: r.error || 'Non sono riuscito a rinominarla.' } } : a));
    }
  };
  const remove = async (p) => {
    setActive((a) => ({ ...a, busy: true }));
    const r = await request({ type: 'playlistDelete', id: p.id });
    if (r.ok) {
      setActive(null);
      showNote(`Eliminata «${p.name}».`);
      requestAnimationFrame(() => saveBtn.current?.focus());
    } else {
      setActive(null);
      showFlash(p.id, r.error || 'Non sono riuscito a eliminarla.', 'error');
    }
  };

  const list = playlists || [];
  const err = save?.err;
  // Sovrascrivere si può solo con canEdit; `permesso` (il server ha rifiutato) chiede comunque un altro nome.
  const dupLocked = err?.code === 'permesso' || (err?.code === 'nome_usato' && err.existing && !canEdit(err.existing));
  const dupCase = err?.code === 'nome_usato' || err?.code === 'permesso';

  return (
    <div className="lib">
      <div className="lib__head">
        {save ? (
          <form
            className="lib__form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!save.busy && !dupCase) submitSave(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                closeSave();
              }
            }}
          >
            <label className="lib__label">
              <span className="lab">Nome della playlist</span>
              <span className={`field ${err && NAME_CODES.has(err.code) ? 'field--err' : ''}`}>
                <input
                  ref={nameInput}
                  type="text"
                  name="nome"
                  value={save.name}
                  maxLength={80}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Es. Serata rock…"
                  aria-invalid={Boolean(err && NAME_CODES.has(err.code))}
                  aria-describedby="lib-save-msg"
                  onChange={(e) => setSave((s) => ({ ...s, name: e.target.value, err: null }))}
                />
              </span>
            </label>
            {err ? (
              <>
                <p className="err" role="alert" id="lib-save-msg">
                  <I.Alert width={16} height={16} />
                  <span>
                    {err.code === 'nome_usato' && err.existing
                      ? dupLocked
                        ? `Nome già usato: questo nome è di una playlist di ${err.existing.createdBy?.name || 'un’altra persona'} (${brani(err.existing.count)}). Scegli un altro nome.`
                        : `Nome già usato: c’è già «${err.existing.name}» (di ${err.existing.createdBy?.name || 'un altro'}, ${brani(err.existing.count)}). Sovrascrivila o scegli un altro nome.`
                      : err.error}
                  </span>
                </p>
                {dupCase ? (
                  <div className="lib__btns">
                    {!dupLocked && (
                      <button type="button" className="btn btn--danger" disabled={save.busy || disabled} onClick={() => submitSave(true)}>
                        {save.busy ? <span className="spinner spinner--btn" aria-hidden="true" /> : null}
                        Sovrascrivi
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setSave((s) => ({ ...s, err: null }));
                        requestAnimationFrame(() => nameInput.current?.select());
                      }}
                    >
                      Cambia nome
                    </button>
                  </div>
                ) : (
                  <SaveButtons busy={save.busy} disabled={disabled || count === 0} onCancel={closeSave} />
                )}
              </>
            ) : (
              <>
                <p className="muted" id="lib-save-msg">
                  {count === 0
                    ? 'La coda è vuota: aggiungi qualche brano prima di salvarla.'
                    : current
                      ? `Salva il brano in corso e ${queue.length === 1 ? 'quello' : `i ${queue.length}`} in coda${formatLength(seconds) ? ` (${formatLength(seconds)})` : ''}.`
                      : `Salva ${count === 1 ? 'il brano' : `i ${count} brani`} in coda${formatLength(seconds) ? ` (${formatLength(seconds)})` : ''}.`}
                </p>
                <SaveButtons busy={save.busy} disabled={disabled || count === 0} onCancel={closeSave} />
              </>
            )}
          </form>
        ) : (
          <div className="lib__bar">
            <button type="button" ref={saveBtn} className="cpill" disabled={disabled} onClick={openSave}>
              <I.QueueAdd width={16} height={16} />
              Salva la coda
            </button>
            <span className="lib__fill" />
            {narrow && playlists && <span className="muted lib__count">{list.length} playlist</span>}
          </div>
        )}
        <p className="lib__note" role="status">{note?.text}</p>
      </div>

      <div className="lib__scroll">
        {playlists == null ? (
          <p className="muted lib__wait"><span className="spinner" aria-hidden="true" />Carico la libreria…</p>
        ) : list.length === 0 ? (
          <div className="lib__empty">
            <span className="lib__empty-icon"><I.Library width={26} height={26} strokeWidth={1.8} /></span>
            <p className="lib__empty-title">Nessuna playlist.</p>
            <p className="muted">Salva la coda per crearne una: la vedrà tutto il server.</p>
          </div>
        ) : (
          <ul className="lib__list">
            {list.map((p) => (
              <PlaylistRow
                key={p.id}
                p={p}
                editable={canEdit(p)}
                active={active?.id === p.id ? active : null}
                setActive={setActive}
                flash={flash?.id === p.id ? flash : null}
                loading={loading?.id === p.id ? loading.mode : null}
                busyAny={Boolean(loading)}
                disabled={disabled}
                queueLen={queue.length}
                onLoad={load}
                onRename={rename}
                onDelete={remove}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SaveButtons({ busy, disabled, onCancel }) {
  return (
    <div className="lib__btns">
      <button type="submit" className="btn btn--solid" disabled={busy || disabled}>
        {busy ? <span className="spinner spinner--btn" aria-hidden="true" /> : null}
        Salva
      </button>
      <button type="button" className="btn" onClick={onCancel}>Annulla</button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Una riga della libreria                                             */
/* ------------------------------------------------------------------ */

function PlaylistRow({ p, editable, active, setActive, flash, loading, busyAny, disabled, queueLen, onLoad, onRename, onDelete }) {
  const mode = active?.mode || null;
  const rowRef = useRef(null);
  const moreRef = useRef(null);
  const replaceRef = useRef(null);
  const menuRef = useRef(null);
  const [draft, setDraft] = useState(p.name);

  const close = (focus) => {
    setActive(null);
    if (focus) requestAnimationFrame(() => focus.current?.focus());
  };

  // Menu aperto: primo elemento attivo a fuoco e menu tenuto visibile dentro il pannello che scorre.
  useLayoutEffect(() => {
    if (mode !== 'menu') return;
    const m = menuRef.current;
    if (!m) return;
    (m.querySelector('[role="menuitem"]:not([aria-disabled="true"])') || m).focus();
    const sc = scrollParent(m);
    if (sc) {
      const a = m.getBoundingClientRect();
      const b = sc.getBoundingClientRect();
      if (a.bottom > b.bottom - 8) sc.scrollTop += a.bottom - b.bottom + 8;
    }
    const outside = (e) => {
      if (!m.contains(e.target) && !moreRef.current?.contains(e.target)) setActive(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [mode, setActive]);

  const menuKey = (e) => {
    const items = [...menuRef.current.querySelectorAll('[role="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close(moreRef);
    } else if (e.key === 'Tab') {
      setActive(null);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(i + step + items.length) % items.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus();
    }
  };

  const meta = [brani(p.count), formatLength(p.duration), p.createdBy?.name ? `di ${p.createdBy.name}` : null].filter(Boolean).join(' · ');
  const who = p.createdBy?.name || 'chi l’ha creata';
  const warn = mode === 'replace' || mode === 'delete';

  if (mode === 'rename') {
    const err = active.err;
    return (
      <li className="pl" ref={rowRef}>
        <form
          className="pl__rename"
          onSubmit={(e) => {
            e.preventDefault();
            if (!active.busy) onRename(p, draft);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close(moreRef);
            }
          }}
        >
          <label className="lib__label">
            <span className="lab">Nuovo nome</span>
            <span className={`field ${err && NAME_CODES.has(err.code) ? 'field--err' : ''}`}>
              <input
                type="text"
                name="rinomina"
                value={draft}
                maxLength={80}
                autoFocus
                onFocus={(e) => e.target.select()}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(err && NAME_CODES.has(err.code))}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (err) setActive((a) => ({ ...a, err: null }));
                }}
              />
            </span>
          </label>
          {err && (
            <p className="err" role="alert">
              <I.Alert width={16} height={16} />
              <span>{err.code === 'nome_usato' ? 'Nome già usato da un’altra playlist: scegline un altro.' : err.error}</span>
            </p>
          )}
          <div className="lib__btns">
            <button type="submit" className="btn btn--solid" disabled={active.busy || disabled}>
              {active.busy ? <span className="spinner spinner--btn" aria-hidden="true" /> : null}
              Rinomina
            </button>
            <button type="button" className="btn" onClick={() => close(moreRef)}>Annulla</button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className={`pl ${warn ? 'is-warn' : ''} ${mode === 'menu' ? 'is-open' : ''}`} ref={rowRef}>
      <div className="pl__top">
        <span className="pl__name one" title={p.name}>{p.name}</span>
        <button
          ref={moreRef}
          type="button"
          className={`icon-btn icon-btn--sm ${mode === 'menu' ? 'is-open' : ''}`}
          aria-label={`Altre azioni per «${p.name}»`}
          {...suggerimento('Altre azioni')}
          aria-haspopup="menu"
          aria-expanded={mode === 'menu'}
          onClick={() => (mode === 'menu' ? close() : setActive({ id: p.id, mode: 'menu' }))}
        >
          <I.More width={18} height={18} />
        </button>
      </div>
      <p className="muted one pl__meta">{meta}</p>

      {mode === 'replace' ? (
        <div
          className="pl__confirm"
          role="alertdialog"
          aria-label="Conferma sostituzione della coda"
          onKeyDown={(e) => e.key === 'Escape' && close(replaceRef)}
        >
          <p>Sostituire {queueLen === 1 ? 'il brano' : `i ${queueLen} brani`} in coda con {p.count === 1 ? 'quello' : `i ${p.count}`} di questa playlist? La coda attuale si perde, il brano che suona continua.</p>
          <div className="lib__btns">
            <button type="button" className="btn btn--danger" disabled={disabled} onClick={() => onLoad(p, 'replace')}>Sostituisci</button>
            <ConfirmCancel onClick={() => close(replaceRef)} />
          </div>
        </div>
      ) : mode === 'delete' ? (
        <div
          className="pl__confirm"
          role="alertdialog"
          aria-label={`Conferma eliminazione di «${p.name}»`}
          onKeyDown={(e) => e.key === 'Escape' && close(moreRef)}
        >
          <p>Eliminare «{p.name}» per tutto il server? Non si può annullare.</p>
          <div className="lib__btns">
            <button type="button" className="btn btn--danger" disabled={active.busy || disabled} onClick={() => onDelete(p)}>
              {active.busy ? <span className="spinner spinner--btn" aria-hidden="true" /> : null}
              Elimina
            </button>
            <ConfirmCancel onClick={() => close(moreRef)} />
          </div>
        </div>
      ) : (
        <div className="pl__acts">
          <button
            type="button"
            className="cpill"
            aria-label={`Aggiungi «${p.name}» in fondo alla coda`}
            disabled={disabled || busyAny}
            onClick={() => onLoad(p, 'append')}
          >
            {loading === 'append' ? <span className="spinner spinner--pill" aria-hidden="true" /> : <I.Plus width={16} height={16} />}
            In coda
          </button>
          <button
            ref={replaceRef}
            type="button"
            className="cpill"
            aria-label={`Sostituisci la coda con «${p.name}»`}
            disabled={disabled || busyAny}
            onClick={() => (queueLen > 0 ? setActive({ id: p.id, mode: 'replace' }) : onLoad(p, 'replace'))}
          >
            {loading === 'replace' ? <span className="spinner spinner--pill" aria-hidden="true" /> : <I.Swap width={16} height={16} />}
            {/* Playlist stretta: «Sostituisci» su una riga, sempre con testo (styles.css, .pl__acts). */}
            <span className="pl__txt pl__txt--lungo">Sostituisci la coda</span>
            <span className="pl__txt pl__txt--corto">Sostituisci</span>
          </button>
        </div>
      )}

      {flash && (
        <p className={flash.kind === 'error' ? 'err pl__flash' : 'pl__flash pl__flash--ok'} role={flash.kind === 'error' ? 'alert' : 'status'}>
          {flash.kind === 'error' ? <I.Alert width={16} height={16} /> : <I.Check width={16} height={16} />}
          <span>{flash.text}</span>
        </p>
      )}

      {mode === 'menu' && (
        <div className="pop" role="menu" aria-label={`Azioni per «${p.name}»`} ref={menuRef} tabIndex={-1} onKeyDown={menuKey}>
          <button
            type="button"
            role="menuitem"
            className="pop__item"
            aria-disabled={!editable || disabled}
            onClick={() => {
              if (!editable || disabled) return;
              setDraft(p.name);
              setActive({ id: p.id, mode: 'rename', err: null });
            }}
          >
            <I.Pencil width={18} height={18} />
            Rinomina
          </button>
          {editable && <div className="pop__sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={`pop__item ${editable ? 'pop__item--danger' : ''}`}
            aria-disabled={!editable || disabled}
            onClick={() => {
              if (!editable || disabled) return;
              setActive({ id: p.id, mode: 'delete' });
            }}
          >
            <I.Trash width={18} height={18} />
            {editable ? 'Elimina…' : 'Elimina'}
          </button>
          {!editable && (
            <>
              <div className="pop__sep" role="separator" />
              <p className="pop__note">
                <I.Lock width={16} height={16} />
                <span>Solo {who} o un amministratore può modificarla.</span>
              </p>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** «Annulla» delle conferme: prende il fuoco all'apertura, così Invio non distrugge niente per sbaglio. */
function ConfirmCancel({ onClick }) {
  const ref = useRef(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <button type="button" className="btn" ref={ref} onClick={onClick}>Annulla</button>
  );
}
