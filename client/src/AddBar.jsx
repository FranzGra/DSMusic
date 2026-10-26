import { forwardRef, useEffect, useRef } from 'react';
import { suggerimento } from './Suggerimento.jsx';
import * as I from './icons.jsx';

export const isLink = (s) => /^https?:\/\//i.test(s.trim());
const DEBOUNCE_MS = 700;

const LINK_DEBOUNCE_MS = 250;

/**
 * Campo a pillola: un testo apre la ricerca (all'Invio o dopo una breve pausa di scrittura);
 * un link mostra la riga di anteprima con le scelte (in coda, riproduci dopo, riproduci ora).
 * Invio su un link = in coda, senza aspettare l'anteprima.
 * `compact`: versione corta per la barra del pannello Coda. `onOpen` (fuoco o scrittura) apre la
 * vista di ricerca; `onEscape` la chiude (senza, Esc svuota soltanto il campo).
 */
const AddBar = forwardRef(function AddBar(
  { value, onChange, onAdd, onSearch, onLink, onClear, onOpen, onEscape, busy, disabled, compact = false },
  ref,
) {
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const change = (v) => {
    onChange(v);
    clearTimeout(timer.current);
    const q = v.trim();
    if (q) onOpen?.();
    if (!q) return onClear();
    if (isLink(q)) timer.current = setTimeout(() => onLink(q), LINK_DEBOUNCE_MS);
    else if (q.length >= 2) timer.current = setTimeout(() => onSearch(q), DEBOUNCE_MS);
  };

  const submit = (e) => {
    e.preventDefault();
    clearTimeout(timer.current);
    const q = value.trim();
    if (!q || disabled) return;
    if (isLink(q)) {
      if (busy) return;
      onAdd(q, 'fine');
      onChange('');
      onClear();
    } else {
      onSearch(q);
    }
  };

  const link = isLink(value);
  const size = compact ? 18 : 20;

  return (
    <form
      className={`search ${compact ? 'search--compact' : ''}`}
      role="search"
      onSubmit={submit}
      // Clic sull'icona o sul bordo del campo: il fuoco va comunque nel testo.
      onMouseDown={(e) => {
        if (e.target.closest('input, button')) return;
        e.preventDefault();
        ref?.current?.focus();
      }}
    >
      <label htmlFor="add-input" className="sr-only">
        Cerca un brano o incolla un link
      </label>
      <span className="search__icon" aria-hidden="true">
        {busy ? <span className="spinner" /> : <I.Search width={size} height={size} />}
      </span>
      <input
        ref={ref}
        id="add-input"
        name="query"
        type="search"
        enterKeyHint={link ? 'go' : 'search'}
        autoComplete="off"
        spellCheck={false}
        placeholder={compact ? 'Cerca o incolla un link…' : 'Cosa vuoi ascoltare? Cerca o incolla un link…'}
        value={value}
        onChange={(e) => change(e.target.value)}
        onFocus={() => onOpen?.()}
        onClick={() => onOpen?.()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            clearTimeout(timer.current);
            onChange('');
            onClear();
            onEscape?.();
          }
        }}
        disabled={disabled}
      />
      {value && (
        <button
          type="button"
          className="search__clear"
          onClick={() => {
            clearTimeout(timer.current);
            onChange('');
            onClear();
            ref?.current?.focus();
          }}
          aria-label="Svuota il campo"
          {...suggerimento('Svuota il campo')}
        >
          <I.Close width={compact ? 16 : 18} height={compact ? 16 : 18} />
        </button>
      )}
    </form>
  );
});

export default AddBar;
