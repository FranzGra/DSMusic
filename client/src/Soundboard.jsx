import { useEffect, useMemo, useRef, useState } from 'react';
import { suggerimento } from './Suggerimento.jsx';
import { formatTime } from './format.js';
import * as I from './icons.jsx';
import './soundbar.css';

const MAX_SECONDI = 20;
const MAX_BYTE = 2 * 1024 * 1024;
const TOLLERANZA_S = 0.25; // come il server: 20,25 s passano
const NOME_MAX = 40;
const PAUSA_CLIC_MS = 1500; // dopo un clic il pulsante resta spento un attimo (anti-spam, come il server)
const VOL_MIN = 10; // percentuali, come il server (0,1 - 2, passo 0,05)
const VOL_MAX = 200;
const VOL_PASSO = 5;
const CODICI_NOME = new Set(['nome_usato', 'nome_vuoto', 'nome_lungo', 'nome_non_valido']);

const comeNome = (fileName) => String(fileName || '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOME_MAX);
const mb = (n) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toLocaleString('it-IT', { maximumFractionDigits: 1 })} MB`;
const pct = (v) => Math.round((Number(v) || 1) * 100);
const volDiverso = (v) => typeof v === 'number' && Math.abs(v - 1) > 0.001;
const secondi = (n) => `${Math.round(n * 10) / 10}`.replace('.', ',');

/** Durata di un file audio letta dal browser, o null se non si riesce entro 3 s (allora decide il server). */
function leggiDurata(file) {
  return new Promise((resolve) => {
    let url = null;
    let fatto = false;
    const audio = new Audio();
    const fine = (v) => {
      if (fatto) return;
      fatto = true;
      clearTimeout(timer);
      audio.removeAttribute('src');
      if (url) URL.revokeObjectURL(url);
      resolve(v);
    };
    const timer = setTimeout(() => fine(null), 3000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => fine(Number.isFinite(audio.duration) ? audio.duration : null);
    audio.onerror = () => fine(null);
    try {
      url = URL.createObjectURL(file);
      audio.src = url;
    } catch {
      fine(null);
    }
  });
}

/**
 * Manda il file al server: POST /api/suoni con il biglietto (X-Biglietto) e il nome (X-Nome).
 * Restituisce sempre { ok, suono?, code?, error? }, mai un'eccezione.
 */
export async function caricaSuonoRete(file, nome, ticket, volume = 1) {
  try {
    const res = await fetch('/api/suoni', {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Biglietto': ticket,
        'X-Nome': encodeURIComponent(nome),
        'X-Volume': String(volume), // 1 = 100%
      },
      body: file,
      signal: AbortSignal.timeout(60_000),
    });
    let json = null;
    try {
      json = await res.json();
    } catch { /* risposta non JSON (es. pagina d'errore del proxy) */ }
    if (res.ok && json?.ok) return json;
    const ripiego =
      res.status === 413 ? 'File troppo grande (massimo 2 MB)'
        : res.status === 401 ? 'Il permesso è scaduto: riprova.'
          : `Caricamento non riuscito (errore ${res.status}). Riprova.`;
    return { ok: false, code: json?.code, error: json?.error || ripiego };
  } catch {
    return { ok: false, code: 'rete', error: 'Non riesco a mandare il file: controlla la connessione e riprova.' };
  }
}

/**
 * «Prova» del caricamento: il file scelto si ascolta solo in locale, al volume del cursore. Il volume passa da un
 * GainNode (Web Audio) così anche sopra 100% funziona (HTMLAudioElement.volume si ferma a 1) e si può cambiare mentre suona.
 */
function useProvaLocale(file, volume) {
  const r = useRef({ audio: null, ctx: null, gain: null, url: null });
  const [suona, setSuona] = useState(false);
  const [errore, setErrore] = useState(null);

  useEffect(() => {
    const c = r.current;
    if (c.gain) c.gain.gain.value = volume;
    else if (c.audio) c.audio.volume = Math.min(1, volume);
  }, [volume]);

  useEffect(() => () => {
    const c = r.current;
    c.audio?.pause();
    c.audio?.removeAttribute('src');
    if (c.url) URL.revokeObjectURL(c.url);
    c.ctx?.close?.().catch(() => {});
  }, []);

  const prova = async () => {
    const c = r.current;
    if (suona) {
      c.audio?.pause();
      return setSuona(false);
    }
    setErrore(null);
    try {
      if (!c.audio) {
        c.url = URL.createObjectURL(file);
        c.audio = new Audio(c.url);
        c.audio.onended = () => setSuona(false);
        c.audio.onerror = () => { setSuona(false); setErrore('Il browser non riesce a far sentire questo file.'); };
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          c.ctx = new AC();
          c.gain = c.ctx.createGain();
          c.ctx.createMediaElementSource(c.audio).connect(c.gain).connect(c.ctx.destination);
        }
      }
      if (c.gain) c.gain.gain.value = volume;
      else c.audio.volume = Math.min(1, volume);
      if (c.ctx?.state === 'suspended') await c.ctx.resume();
      c.audio.currentTime = 0;
      await c.audio.play();
      setSuona(true);
    } catch {
      setSuona(false);
      setErrore('Il browser non riesce a far sentire questo file.');
    }
  };

  return { suona, errore, prova };
}

/**
 * Cursore del volume (10%-200%, passo 5%, segno fisso a 100%, percentuale a destra).
 * `onChange` a ogni spostamento (solo a schermo); `onCommit` al rilascio (mouse, dito, tasto): è lì che si salva,
 * perché ogni modifica fa lavorare ffmpeg sul server.
 */
function VolumeSlider({ id, label, value, onChange, onCommit, disabled = false, icon = true }) {
  const v = Math.round(value * 100);
  const sporco = useRef(false); // c'è uno spostamento non ancora salvato
  const fine = (e) => {
    if (!sporco.current) return;
    sporco.current = false;
    onCommit?.(Number(e.currentTarget.value) / 100);
  };
  return (
    <div className={`vol ${icon ? '' : 'vol--noico'}`}>
      {icon && <span className="vol__ico" aria-hidden="true"><I.Volume width={20} height={20} /></span>}
      <div className="vol__track">
        <input
          id={id}
          type="range"
          className="vol__range"
          min={VOL_MIN}
          max={VOL_MAX}
          step={VOL_PASSO}
          value={v}
          disabled={disabled}
          aria-label={label}
          aria-valuetext={`${v}%`}
          style={{ '--frac': (v - VOL_MIN) / (VOL_MAX - VOL_MIN) }}
          onChange={(e) => { sporco.current = true; onChange(Number(e.target.value) / 100); }}
          onPointerUp={fine}
          onKeyUp={fine}
          onBlur={fine}
        />
        <span className="vol__mark" aria-hidden="true" />
      </div>
      <output className={`vol__pct ${v > 100 ? 'vol__pct--up' : ''}`} htmlFor={id}>{v}%</output>
      <div className="vol__scale" aria-hidden="true"><em>10%</em><em>100%</em><em>200%</em></div>
    </div>
  );
}

/** Modulo di caricamento: nome, volume con «Prova» (ascolto solo locale), Annulla, Carica. */
function UploadForm({ up, setUp, disabled, onSubmit, onCancel }) {
  const prova = useProvaLocale(up.file, up.vol);
  return (
    <form
      className="sb__form"
      onSubmit={onSubmit}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !up.busy) {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <label className="sb__label">
        <span className="lab">Nome del suono</span>
        <span className={`field ${up.err && CODICI_NOME.has(up.err.code) ? 'field--err' : ''}`}>
          <input
            type="text"
            name="nome-suono"
            value={up.name}
            maxLength={NOME_MAX}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            onFocus={(e) => e.target.select()}
            aria-invalid={Boolean(up.err && CODICI_NOME.has(up.err.code))}
            onChange={(e) => setUp({ ...up, name: e.target.value, err: null })}
          />
        </span>
      </label>
      <p className="muted sb__file one" title={up.file.name}>
        {up.file.name} · {mb(up.file.size)}{up.dur != null ? ` · ${formatTime(Math.round(up.dur))}` : ''}
      </p>
      <div className="sb__label">
        <span className="lab">Volume</span>
        <VolumeSlider
          id="sb-up-volume"
          label="Volume del suono"
          value={up.vol}
          disabled={up.busy}
          onChange={(v) => setUp((u) => u && { ...u, vol: v })}
        />
        <p className="muted">Premi «Prova» prima di caricare: senti il suono al volume scelto.</p>
        {prova.errore && <p className="err" role="alert"><I.Alert width={16} height={16} /><span>{prova.errore}</span></p>}
      </div>
      {up.err && (
        <p className="err" role="alert">
          <I.Alert width={16} height={16} />
          <span>{up.err.error}</span>
        </p>
      )}
      <div className="lib__btns sb__acts">
        <button type="button" className="btn sb__prova" disabled={up.busy} aria-pressed={prova.suona} onClick={prova.prova}>
          {prova.suona ? <I.Stop width={16} height={16} /> : <I.Play width={16} height={16} />}
          {prova.suona ? 'Ferma' : 'Prova'}
        </button>
        <span className="sb__spacer" />
        <button type="button" className="btn" disabled={up.busy} onClick={onCancel}>Annulla</button>
        <button type="submit" className="btn btn--solid" disabled={up.busy || disabled}>
          {up.busy ? <span className="spinner spinner--btn" aria-hidden="true" /> : null}
          {up.busy ? 'Carico…' : 'Carica'}
        </button>
      </div>
    </form>
  );
}

/** Soundbar: elenco dei suoni del server, caricamento, volume, rinomina ed eliminazione. */
export default function Soundboard({
  sounds, send, request, upload, user, suono = null, disabled = false, className = '', compact = false, bare = false,
}) {
  const list = sounds || [];
  const puoCaricare = Boolean(user?.puoCaricare || user?.isAdmin);
  const fileRef = useRef(null);
  const addRef = useRef(null);
  const [active, setActive] = useState(null); // { id, mode: 'menu'|'rename'|'delete', err?, busy? }
  const [draft, setDraft] = useState('');
  const [lock, setLock] = useState(null); // id appena premuto, spento per un attimo
  const [flash, setFlash] = useState(null); // { kind: 'ok'|'error', text }
  const [up, setUp] = useState(null); // { file, name, dur, busy, err }
  const [checking, setChecking] = useState(false);
  const flashTimer = useRef(null);
  const lockTimer = useRef(null);
  useEffect(() => () => { clearTimeout(flashTimer.current); clearTimeout(lockTimer.current); }, []);

  const say = (kind, text) => {
    clearTimeout(flashTimer.current);
    setFlash({ kind, text });
    flashTimer.current = setTimeout(() => setFlash(null), kind === 'error' ? 8000 : 4000);
  };

  // Un suono sparito (eliminato da un altro) chiude menu e conferme aperte su di lui.
  useEffect(() => {
    if (active && !list.some((s) => s.id === active.id)) setActive(null);
  }, [sounds]); // eslint-disable-line react-hooks/exhaustive-deps

  const canEdit = (s) => Boolean(user?.isAdmin || (user?.id && s.byId === user.id));

  const play = (s) => {
    if (lock || disabled) return;
    setFlash(null);
    send?.(suono?.id === s.id ? { type: 'suonoFerma' } : { type: 'suona', id: s.id });
    setLock(s.id);
    clearTimeout(lockTimer.current);
    lockTimer.current = setTimeout(() => setLock(null), PAUSA_CLIC_MS);
  };

  const pickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFlash(null);
    if (file.size > MAX_BYTE) return say('error', `Il file pesa ${mb(file.size)}: il massimo è 2 MB.`);
    setChecking(true);
    const dur = await leggiDurata(file);
    setChecking(false);
    if (dur != null && dur > MAX_SECONDI + TOLLERANZA_S) {
      return say('error', `Questo suono dura ${secondi(dur)} s: il massimo è ${MAX_SECONDI} s.`);
    }
    setUp({ file, name: comeNome(file.name), dur, vol: 1, busy: false, err: null });
  };

  const submitUp = async (e) => {
    e.preventDefault();
    if (!up || up.busy) return;
    const name = up.name.replace(/\s+/g, ' ').trim();
    if (!name) return setUp({ ...up, err: { code: 'nome_vuoto', error: 'Scrivi un nome per il suono.' } });
    setUp({ ...up, busy: true, err: null });
    const t = await request?.({ type: 'suonoBiglietto' });
    if (!t?.ok || !t.ticket) {
      return setUp((u) => u && { ...u, busy: false, err: { code: t?.code, error: t?.error || 'Non puoi caricare suoni.' } });
    }
    const r = await upload?.(up.file, name, t.ticket, up.dur, up.vol);
    if (r?.ok) {
      setUp(null);
      say('ok', `«${r.suono?.name || name}» è nella Soundbar.`);
      addRef.current?.focus();
    } else {
      setUp((u) => u && { ...u, busy: false, err: { code: r?.code, error: r?.error || 'Caricamento non riuscito. Riprova.' } });
    }
  };

  const rename = async (s) => {
    const name = draft.replace(/\s+/g, ' ').trim();
    if (!name) return setActive({ ...active, err: { code: 'nome_vuoto', error: 'Il nome non può essere vuoto.' } });
    if (name === s.name) return setActive(null);
    setActive({ ...active, busy: true, err: null });
    const r = await request?.({ type: 'suonoRinomina', id: s.id, name });
    if (r?.ok) {
      setActive(null);
      say('ok', `Rinominato in «${name}».`);
    } else {
      setActive((a) => a && { ...a, busy: false, err: { code: r?.code, error: r?.error || 'Non sono riuscito a rinominare.' } });
    }
  };

  /** Salva il volume di un suono (al rilascio del cursore). Restituisce la risposta: il menu mostra l'errore. */
  const setVolume = async (s, volume) => {
    const r = await request?.({ type: 'suonoVolume', id: s.id, volume });
    if (r?.ok) say('ok', `Volume di «${s.name}»: ${pct(volume)}%. Vale dal prossimo suono.`);
    return r;
  };

  const remove = async (s) => {
    setActive({ ...active, busy: true, err: null });
    const r = await request?.({ type: 'suonoElimina', id: s.id });
    if (r?.ok) {
      setActive(null);
      say('ok', `«${s.name}» eliminato.`);
    } else {
      setActive((a) => a && { ...a, busy: false, err: { code: r?.code, error: r?.error || 'Non sono riuscito a eliminarlo.' } });
    }
  };

  const noRole = !puoCaricare;
  const uploadBlocked = disabled || noRole || checking || Boolean(up);

  return (
    <section className={`${bare ? 'side-card--bare' : 'card'} side-card side-card--grow sb ${className}`} aria-label="Soundbar">
      {!bare && (
        <div className="side-card__head">
          <h2 className="lab">Soundbar</h2>
        </div>
      )}

      {sounds == null ? (
        <p className="muted sb__wait"><span className="spinner" aria-hidden="true" /> Carico i suoni…</p>
      ) : list.length === 0 ? (
        <div className="sb__empty">
          <span className="sb__empty-icon"><I.Wave width={28} height={28} strokeWidth={1.8} /></span>
          <p className="sb__empty-title">Carica il primo suono</p>
          <p className="muted">
            {noRole
              ? 'Qui compaiono i suoni che tutti possono far partire nel canale. Per caricarne serve il ruolo Soundbar.'
              : `Un breve audio (fino a ${MAX_SECONDI} secondi) che tutti nel canale potranno far partire con un tocco.`}
          </p>
        </div>
      ) : (
        <ul className={`sb__grid ${compact ? 'sb__grid--compact' : ''}`}>
          {list.map((s) => (
            <Tile
              key={s.id}
              s={s}
              on={suono?.id === s.id}
              suono={suono}
              locked={Boolean(lock) || disabled}
              editable={canEdit(s)}
              mode={active?.id === s.id ? active.mode : null}
              state={active?.id === s.id ? active : null}
              draft={draft}
              setDraft={setDraft}
              onPlay={() => play(s)}
              setActive={setActive}
              onRename={() => rename(s)}
              onVolume={(v) => setVolume(s, v)}
              onRemove={() => remove(s)}
              disabled={disabled}
            />
          ))}
        </ul>
      )}

      <span className="soundboard__fill" />

      {flash && (
        <p className={flash.kind === 'error' ? 'err sb__flash' : 'sb__flash sb__flash--ok'} role={flash.kind === 'error' ? 'alert' : 'status'}>
          {flash.kind === 'error' ? <I.Alert width={16} height={16} /> : <I.Check width={16} height={16} />}
          <span>{flash.text}</span>
        </p>
      )}

      <div className={`sb__foot ${up ? 'sb__foot--form' : ''}`}>
        {up ? (
          <UploadForm
            up={up}
            setUp={setUp}
            disabled={disabled}
            onSubmit={submitUp}
            onCancel={() => { setUp(null); addRef.current?.focus(); }}
          />
        ) : (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="audio/*,.mp3,.ogg,.wav,.m4a,.opus,.webm"
              hidden
              onChange={pickFile}
              tabIndex={-1}
            />
            <button
              ref={addRef}
              type="button"
              className="btn btn--tall sb__add"
              disabled={uploadBlocked}
              aria-describedby={noRole ? 'sb-ruolo' : undefined}
              title={noRole ? 'Serve il ruolo Soundbar' : `Carica un suono (max ${MAX_SECONDI} s)`}
              onClick={() => fileRef.current?.click()}
            >
              {checking ? <span className="spinner spinner--btn" aria-hidden="true" /> : <I.Plus width={16} height={16} />}
              {checking ? 'Controllo il file…' : `Carica un suono (max ${MAX_SECONDI} s)`}
            </button>
            {noRole && (
              <p id="sb-ruolo" className="muted sb__role">
                <I.Lock width={16} height={16} />
                <span>Serve il ruolo Soundbar</span>
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** Un suono: pulsante grande per farlo partire, menu ⋯ (solo per chi può), rinomina e conferma di eliminazione. */
function Tile({ s, on, suono, locked, editable, mode, state, draft, setDraft, onPlay, setActive, onRename, onRemove, onVolume, disabled }) {
  const rowRef = useRef(null);
  const moreRef = useRef(null);
  const menuRef = useRef(null);
  const close = (focus = true) => {
    setActive(null);
    if (focus) setTimeout(() => moreRef.current?.focus(), 0);
  };

  // Menu aperto: primo elemento a fuoco, menu visibile nel pannello che scorre, clic fuori lo chiude.
  useEffect(() => {
    if (mode !== 'menu') return undefined;
    const m = menuRef.current;
    m?.querySelector('[role="menuitem"]')?.focus();
    m?.scrollIntoView({ block: 'nearest' });
    const fuori = (e) => { if (!rowRef.current?.contains(e.target)) setActive(null); };
    document.addEventListener('pointerdown', fuori);
    return () => document.removeEventListener('pointerdown', fuori);
  }, [mode, setActive]);

  const menuKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      return close();
    }
    if (e.target.closest?.('.sb__vol')) return; // dentro il cursore le frecce regolano il volume
    const items = [...menuRef.current.querySelectorAll('[role="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    }
  };

  // Barra di avanzamento del suono in corso: un'animazione CSS che parte dal punto giusto.
  const barStyle = useMemo(() => {
    if (!on) return null;
    const tot = Math.max(1, (s.duration || 0) * 1000);
    let resto = typeof suono?.fine === 'number' ? suono.fine - Date.now() : tot;
    if (!(resto > 0) || resto > tot + 2000) resto = tot; // orologi diversi o dato strano: vale la durata
    resto = Math.min(resto, tot);
    return { animationDuration: `${tot}ms`, animationDelay: `${-(tot - resto)}ms` };
  }, [on, suono?.fine, s.duration]);

  if (mode === 'rename') {
    const err = state?.err;
    const nomeErr = Boolean(err && CODICI_NOME.has(err.code));
    return (
      <li className="sb__tile sb__tile--wide" ref={rowRef}>
        <form
          className="sb__form"
          onSubmit={(e) => { e.preventDefault(); if (!state?.busy) onRename(); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}
        >
          <label className="sb__label">
            <span className="lab">Nuovo nome</span>
            <span className={`field ${nomeErr ? 'field--err' : ''}`}>
              <input
                type="text"
                name="rinomina-suono"
                value={draft}
                maxLength={NOME_MAX}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                onFocus={(e) => e.target.select()}
                aria-invalid={nomeErr}
                onChange={(e) => { setDraft(e.target.value); if (err) setActive((a) => ({ ...a, err: null })); }}
              />
            </span>
          </label>
          {err && (
            <p className="err" role="alert"><I.Alert width={16} height={16} /><span>{err.error}</span></p>
          )}
          <div className="lib__btns">
            <button type="submit" className="btn btn--solid" disabled={state?.busy || disabled}>
              {state?.busy ? <span className="spinner spinner--btn" aria-hidden="true" /> : null}
              Rinomina
            </button>
            <button type="button" className="btn" disabled={state?.busy} onClick={() => close()}>Annulla</button>
          </div>
        </form>
      </li>
    );
  }

  if (mode === 'delete') {
    const err = state?.err;
    return (
      <li className="sb__tile sb__tile--wide sb__tile--warn" ref={rowRef}>
        <div className="sb__confirm" role="alertdialog" aria-label={`Conferma eliminazione di «${s.name}»`} onKeyDown={(e) => e.key === 'Escape' && close()}>
          <p>Eliminare «{s.name}» per tutto il server? Non si può annullare.</p>
          {err && <p className="err" role="alert"><I.Alert width={16} height={16} /><span>{err.error}</span></p>}
          <div className="lib__btns">
            <button type="button" className="btn btn--danger" disabled={state?.busy || disabled} onClick={onRemove}>
              {state?.busy ? <span className="spinner spinner--btn" aria-hidden="true" /> : null}
              Elimina
            </button>
            <CancelFocus onClick={() => close()} disabled={state?.busy} />
          </div>
        </div>
      </li>
    );
  }

  const meta = [s.duration ? formatTime(s.duration) : null, s.by].filter(Boolean).join(' · ');
  return (
    <li className={`sb__tile ${on ? 'is-on' : ''} ${mode === 'menu' ? 'is-open' : ''} ${editable ? 'has-more' : ''}`} ref={rowRef}>
      <button
        type="button"
        className="sb__play"
        disabled={locked && !on}
        aria-pressed={on}
        onClick={onPlay}
        title={on ? `Ferma «${s.name}»` : `Suona «${s.name}»`}
      >
        <span className="sb__name">
          {on && <span className="sb__eq" aria-hidden="true"><i /><i /><i /><i /></span>}
          <span className="one">{s.name}</span>
        </span>
        <span className="sb__meta muted">
          <span className="one">{on ? 'In corso · tocca per fermare' : meta}</span>
          {!on && volDiverso(s.volume) && (
            <span className={`vb ${s.volume > 1 ? 'vb--up' : ''}`} title={`Volume ${pct(s.volume)}%`}>
              <span className="sr-only">Volume </span>{pct(s.volume)}%
            </span>
          )}
        </span>
        {on && <span className="sb__bar" aria-hidden="true"><span className="sb__bar-fill" style={barStyle} /></span>}
      </button>
      {editable && (
        <button
          ref={moreRef}
          type="button"
          className={`icon-btn icon-btn--sm sb__more ${mode === 'menu' ? 'is-open' : ''}`}
          aria-label={`Altre azioni per «${s.name}»`}
          {...suggerimento('Altre azioni')}
          aria-haspopup="menu"
          aria-expanded={mode === 'menu'}
          onClick={() => (mode === 'menu' ? close(false) : setActive({ id: s.id, mode: 'menu' }))}
        >
          <I.More width={18} height={18} />
        </button>
      )}
      {mode === 'menu' && (
        <div className="pop" role="menu" aria-label={`Azioni per «${s.name}»`} ref={menuRef} tabIndex={-1} onKeyDown={menuKey}>
          <button
            type="button"
            role="menuitem"
            className="pop__item"
            onClick={() => { setDraft(s.name); setActive({ id: s.id, mode: 'rename', err: null }); }}
          >
            <I.Pencil width={18} height={18} />
            Rinomina
          </button>
          <VolumeItem s={s} onVolume={onVolume} disabled={disabled} />
          <div className="pop__sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="pop__item pop__item--danger"
            onClick={() => setActive({ id: s.id, mode: 'delete' })}
          >
            <I.Trash width={18} height={18} />
            Elimina…
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * Voce «Volume» del menu: si apre il cursore (10%-200%) e «Riporta a 100%». Il salvataggio parte al rilascio del
 * cursore e vale per tutti nel server. Non c'è «Prova» qui: far sentire il suono nel canale a ogni prova disturberebbe
 * tutti (e il pulsante del suono, qui sopra, lo fa già partire col volume salvato).
 */
function VolumeItem({ s, onVolume, disabled }) {
  const salvato = typeof s.volume === 'number' ? s.volume : 1;
  const [aperto, setAperto] = useState(false);
  const [val, setVal] = useState(salvato);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const trascino = useRef(false);
  const inVolo = useRef(0); // salvataggi in corso: finché ce ne sono, la risposta del server non sposta il cursore
  useEffect(() => { if (!trascino.current && inVolo.current === 0) setVal(salvato); }, [salvato]);

  const salva = async (v) => {
    trascino.current = false;
    if (Math.abs(v - salvato) < 0.001) return;
    inVolo.current += 1;
    setBusy(true);
    setErr(null);
    const r = await onVolume(v);
    inVolo.current -= 1;
    if (inVolo.current === 0) setBusy(false);
    if (!r?.ok) {
      setVal(salvato);
      setErr(r?.error || 'Non sono riuscito a cambiare il volume.');
    }
  };

  return (
    <>
      <button
        type="button"
        role="menuitem"
        className={`pop__item ${aperto ? 'is-on' : ''}`}
        aria-expanded={aperto}
        aria-controls={`sb-vol-${s.id}`}
        onClick={() => setAperto((a) => !a)}
      >
        <I.Volume width={18} height={18} />
        Volume
        <span className="sb__spacer" />
        <span className={`vb ${salvato > 1 ? 'vb--up' : ''}`}>{pct(salvato)}%</span>
      </button>
      {aperto && (
        <div className="sb__vol" id={`sb-vol-${s.id}`} role="group" aria-label={`Volume di «${s.name}»`}>
          <VolumeSlider
            id={`sb-vol-range-${s.id}`}
            label={`Volume di «${s.name}»`}
            value={val}
            icon={false}
            disabled={disabled}
            onChange={(v) => { trascino.current = true; setVal(v); setErr(null); }}
            onCommit={salva}
          />
          <div className="sb__vol-acts">
            <button type="button" className="btn" disabled={busy || disabled || pct(val) === 100} onClick={() => { setVal(1); salva(1); }}>
              {busy ? <span className="spinner spinner--btn" aria-hidden="true" /> : null}
              Riporta a 100%
            </button>
          </div>
          {err && <p className="err" role="alert"><I.Alert width={16} height={16} /><span>{err}</span></p>}
          <p className="muted">Il cambio vale per tutti nel server.</p>
        </div>
      )}
    </>
  );
}

/** «Annulla» delle conferme: prende il fuoco all'apertura, così Invio non elimina per sbaglio. */
function CancelFocus({ onClick, disabled }) {
  const ref = useRef(null);
  useEffect(() => ref.current?.focus(), []);
  return <button type="button" className="btn" ref={ref} disabled={disabled} onClick={onClick}>Annulla</button>;
}
