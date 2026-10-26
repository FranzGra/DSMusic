import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { connect, insideDiscord } from './connection.js';
import { STUCK_AFTER_MS, statusLabel as labelFor, stuckMessage } from './session.js';
import NowPlaying, { useLeaveCountdown } from './NowPlaying.jsx';
import Intestazione, { statoBot, usePosizione } from './Intestazione.jsx';
import Presence from './Presence.jsx';
import Recent from './Recent.jsx';
import Soundboard, { caricaSuonoRete } from './Soundboard.jsx';
import Library, { SuoniSwitch, useSuoniTab } from './Library.jsx';
import { formatTime } from './format.js';
import * as I from './icons.jsx';
import Queue, { QueueTools } from './Queue.jsx';
import Panels, { useLayout } from './Panels.jsx';
import AddBar from './AddBar.jsx';
import SearchView, { CloseSearch } from './SearchView.jsx';
import CampoAnimato from './CampoAnimato.jsx';
import { suggerimento } from './Suggerimento.jsx';
import { useCoverColors } from './coverColor.js';
import { useAmbiente } from './ambiente.js';
import VistaRidotta, { useVistaRidotta } from './VistaRidotta.jsx';

// Dentro Discord in basso c'è la fila dei partecipanti: la barra del lettore resta sopra.
if (insideDiscord) document.documentElement.classList.add('in-discord');

// Anteprima della grafica solo in sviluppo: /?anteprima=1 mostra uno stato finto, senza server.
const anteprima = import.meta.env.DEV && new URLSearchParams(location.search).has('anteprima');

// Senza interazioni nel pannello di ricerca per questo tempo si torna da soli alla coda.
// Solo in sviluppo, per le prove: ?ritorno=3 (secondi).
const RITORNO_MS = (() => {
  const q = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get('ritorno')) : 0;
  return q > 0 ? q * 1000 : 30_000;
})();

/**
 * Ritorno automatico alla coda: `poke()` a ogni interazione fa ripartire il conto; mentre `busy`
 * (ricerca in corso, aggiunta in attesa) il conto è fermo e riparte quando finisce.
 */
function useIdleClose(open, busy, onIdle, ms = RITORNO_MS) {
  const timer = useRef(null);
  const idleRef = useRef(onIdle);
  idleRef.current = onIdle;
  const state = useRef({ open, busy });
  state.current = { open, busy };
  const poke = useCallback(() => {
    clearTimeout(timer.current);
    if (state.current.open && !state.current.busy) timer.current = setTimeout(() => idleRef.current(), ms);
  }, [ms]);
  useEffect(() => {
    poke();
  }, [open, busy, poke]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return poke;
}

/** Messaggio leggero `members` (è cambiato solo chi parla): si unisce allo stato, non lo sostituisce. */
const mergeMembers = (s, msg) => (s ? { ...s, members: msg.members ?? null } : s);

// Sotto questa larghezza vale sempre la vista telefono (una colonna con le schede).
const PHONE_QUERY = '(max-width: 900px)';
function usePhone() {
  const [phone, setPhone] = useState(() => matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const mq = matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

export default function App() {
  // Stato del collegamento (vedi session.js): status, step (passo in corso), since, error, mode.
  const [conn, setConn] = useState({ status: 'connecting', step: null, since: 0, error: null, mode: null });
  const [stuck, setStuck] = useState(false); // fermi da troppo: spiegazione e «Riprova»
  // Ultimo stato noto: durante la riconnessione resta a schermo (in grigio), non si svuota.
  const [state, setState] = useState(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [search, setSearch] = useState(null); // { reqId, query, status, results, error }
  // Vista di ricerca aperta (fuoco o scrittura nel campo), anche quando il campo è ancora vuoto.
  const [searchOpen, setSearchOpen] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [user, setUser] = useState(null); // { id, name, isAdmin } dal `welcome`
  const [playlists, setPlaylists] = useState(null); // libreria del server (messaggio `playlists`)
  const [suoni, setSuoni] = useState(null); // suoni della Soundbar (messaggio `suoni`)
  const socketRef = useRef(null);
  const noticeTimer = useRef(null);
  const reqSeq = useRef(0);
  const inputRef = useRef(null);
  // Pillola «Cerca» nella barra del pannello Coda (desktop): al clic si apre la ricerca e il fuoco va nel campo;
  // alla chiusura il fuoco torna sulla pillola. `focusDopo` dice dove va il fuoco dopo il prossimo disegno.
  const cercaRef = useRef(null);
  const focusDopo = useRef(null); // null | 'campo' | 'pillola'
  const scrollRef = useRef(null);

  const searchRef = useRef(null);
  searchRef.current = search;
  // Aggiunte in attesa di risposta: reqId -> resolve({ ok }). Il pulsante premuto resta fermo fino a qui.
  const pendingRef = useRef(new Map());
  // Richieste alla libreria in attesa di `playlistResult`: reqId -> resolve(result).
  const playlistPendingRef = useRef(new Map());
  // Richieste alla Soundbar in attesa di `suonoBiglietto` / `suonoResult`: reqId -> resolve(risposta).
  const suoniPendingRef = useRef(new Map());
  const stateRef = useRef(null);
  stateRef.current = state;

  const { tint, palette } = useCoverColors(state?.current?.thumbnail);
  // Modalità Ambiente (menu del titolo, sezione «Aspetto»): gradiente dai 3 colori della copertina.
  const amb = useAmbiente();

  const showNotice = useCallback((n) => {
    clearTimeout(noticeTimer.current);
    setNotice(n);
    if (n.kind !== 'busy') noticeTimer.current = setTimeout(() => setNotice(null), n.kind === 'error' ? 7000 : 3000);
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV && anteprima) {
      let stop = null;
      let gone = false;
      import('./anteprima.js').then(({ statoAnteprima, simulaParlato, utenteAnteprima, playlistAnteprima, suoniAnteprima }) => {
        if (gone) return;
        setConn((c) => ({ ...c, status: 'online', mode: 'prova' }));
        setUser(utenteAnteprima);
        setPlaylists(playlistAnteprima());
        setSuoni(suoniAnteprima());
        setState(statoAnteprima);
        // Solo anteprima: cambia la copertina del brano in corso dalla console o da Playwright.
        window.__anteprimaCopertina = (thumbnail) => setState((s) => ({ ...s, current: s?.current && { ...s.current, thumbnail } }));
        setReceivedAt(performance.now());
        // Ogni pochi secondi un messaggio `members` finto, per provare l'unione allo stato.
        stop = simulaParlato((msg) => setState((s) => mergeMembers(s, msg)));
      });
      return () => {
        gone = true;
        stop?.();
      };
    }
    const sock = connect({
      onStatus: (view) => setConn(view),
      onMessage: (msg) => {
        if (msg.type === 'welcome') {
          setUser(msg.user || null);
        } else if (msg.type === 'playlists') {
          setPlaylists(Array.isArray(msg.playlists) ? msg.playlists : []);
        } else if (msg.type === 'suoni') {
          setSuoni(Array.isArray(msg.suoni) ? msg.suoni : []);
        } else if (msg.type === 'suonoResult' || msg.type === 'suonoBiglietto') {
          const done = msg.reqId != null && suoniPendingRef.current.get(msg.reqId);
          if (done) {
            suoniPendingRef.current.delete(msg.reqId);
            done(msg);
          }
        } else if (msg.type === 'playlistResult') {
          const done = msg.reqId != null && playlistPendingRef.current.get(msg.reqId);
          if (done) {
            playlistPendingRef.current.delete(msg.reqId);
            done(msg);
          }
        } else if (msg.type === 'state') {
          setState(msg.state);
          setReceivedAt(performance.now());
        } else if (msg.type === 'members') {
          setState((s) => mergeMembers(s, msg));
        } else if (msg.type === 'results') {
          // Vale solo la risposta all'ultima ricerca fatta.
          setSearch((s) =>
            s && s.reqId === msg.reqId
              ? { ...s, status: msg.error ? 'error' : 'done', results: msg.results || [], error: msg.error || null }
              : s,
          );
        } else if (msg.type === 'anteprimaLink') {
          setSearch((s) =>
            s && s.kind === 'link' && s.reqId === msg.reqId ? { ...s, status: 'done', info: msg.info || null } : s,
          );
        } else if (msg.type === 'notice') {
          if (msg.kind !== 'busy') setBusy(false);
          if (msg.kind === 'busy') return; // lo spinner del campo basta
          const done = msg.reqId != null && pendingRef.current.get(msg.reqId);
          if (done) {
            pendingRef.current.delete(msg.reqId);
            done({ ok: msg.kind !== 'error' });
          }
          showNotice(msg);
        }
      },
    });
    socketRef.current = sock;
    return () => sock.close();
  }, [showNotice]);

  // Mai un'attesa infinita senza spiegazione: dopo STUCK_AFTER_MS compaiono messaggio e «Riprova».
  const { status } = conn;
  useEffect(() => {
    if (status === 'online' || status === 'fatal') return setStuck(false);
    if (status === 'blocked' || status === 'denied' || status === 'reopen') return setStuck(true);
    const left = STUCK_AFTER_MS - (Date.now() - conn.since);
    if (left <= 0) return setStuck(true);
    setStuck(false);
    const t = setTimeout(() => setStuck(true), left);
    return () => clearTimeout(t);
  }, [status, conn.since]);

  const send = useCallback((msg) => {
    if (import.meta.env.DEV && anteprima) {
      // Anteprima senza server: solo «Svuota» cambia la coda finta (resta il brano in corso).
      // I messaggi restano in window.__inviati, per controllarli nelle prove.
      (window.__inviati ||= []).push(msg);
      import('./anteprima.js').then(({ rispondiCoda, rispondiSuonare }) => {
        rispondiSuonare(msg, setState);
        const patch = rispondiCoda(msg);
        if (patch) setState((s) => (s ? { ...s, ...(typeof patch === 'function' ? patch(s) : patch) } : s));
      });
      return;
    }
    socketRef.current?.send(msg);
  }, []);

  /** Invia un'aggiunta e aspetta il suo avviso (stesso reqId); dopo 20 s si smette di aspettare. */
  const request = useCallback(
    (msg) => {
      const reqId = ++reqSeq.current;
      if (import.meta.env.DEV && anteprima) {
        // Anteprima senza server: risposta finta dopo un attimo, per vedere attesa e avviso.
        send(msg);
        return new Promise((resolve) =>
          setTimeout(() => {
            const titolo = msg.titolo || msg.query || 'brano';
            const testo = { fine: 'Aggiunto in coda', prossimo: 'Riproduce dopo', ora: 'In riproduzione' }[msg.posizione || 'fine'];
            showNotice({ kind: 'info', message: `${testo}: ${titolo}` });
            resolve({ ok: true });
          }, 600),
        );
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingRef.current.delete(reqId);
          resolve({ ok: false });
        }, 20_000);
        pendingRef.current.set(reqId, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        const { titolo: _t, ...rest } = msg;
        send({ ...rest, reqId });
      });
    },
    [send, showNotice],
  );

  /** Richiesta alla libreria (playlistSave/Load/Rename/Delete): aspetta il suo `playlistResult`. */
  const playlistRequest = useCallback(
    (msg) => {
      const reqId = `pl${++reqSeq.current}`;
      if (import.meta.env.DEV && anteprima) {
        // Anteprima senza server: libreria finta in anteprima.js, risposta dopo un attimo.
        return import('./anteprima.js').then(
          ({ rispondiPlaylist }) =>
            new Promise((resolve) =>
              setTimeout(() => {
                const r = rispondiPlaylist(msg, stateRef.current);
                if (r.patch) setState((s) => (s ? { ...s, ...r.patch } : s));
                if (r.playlists) setPlaylists(r.playlists);
                resolve({ type: 'playlistResult', reqId, action: msg.type, ...r.result });
              }, 450),
            ),
        );
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          playlistPendingRef.current.delete(reqId);
          resolve({ ok: false, code: 'timeout', error: 'Il server non risponde: riprova tra poco.' });
        }, 15_000);
        playlistPendingRef.current.set(reqId, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        send({ ...msg, reqId });
      });
    },
    [send],
  );

  /** Richiesta alla Soundbar (suonoBiglietto, suonoRinomina, suonoVolume, suonoElimina): aspetta la risposta con lo stesso reqId. */
  const suoniRequest = useCallback(
    (msg) => {
      const reqId = `su${++reqSeq.current}`;
      if (import.meta.env.DEV && anteprima) {
        return import('./anteprima.js').then(
          ({ rispondiSuoni }) =>
            new Promise((resolve) =>
              setTimeout(() => {
                const r = rispondiSuoni(msg);
                if (r.suoni) setSuoni(r.suoni);
                resolve({ type: msg.type === 'suonoBiglietto' ? 'suonoBiglietto' : 'suonoResult', reqId, action: msg.type, ...r.result });
              }, 350),
            ),
        );
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          suoniPendingRef.current.delete(reqId);
          resolve({ ok: false, code: 'timeout', error: 'Il server non risponde: riprova tra poco.' });
        }, 15_000);
        suoniPendingRef.current.set(reqId, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        send({ ...msg, reqId });
      });
    },
    [send],
  );

  /** Manda il file al server (con il biglietto già ottenuto). In anteprima: caricamento finto, niente rete. */
  const caricaSuono = useCallback(async (file, nome, ticket, durata, volume = 1) => {
    if (import.meta.env.DEV && anteprima) {
      const { caricaSuonoFinto } = await import('./anteprima.js');
      const r = await caricaSuonoFinto(file, nome, durata, volume);
      if (r.suoni) setSuoni(r.suoni);
      return r.result;
    }
    return caricaSuonoRete(file, nome, ticket, volume);
  }, []);

  /** Link o testo dalla barra: posizione 'fine' (in coda), 'prossimo' (riproduci dopo) o 'ora'. */
  const addQuery = useCallback(
    async (query, posizione = 'fine') => {
      setBusy(true);
      const r = await request({ type: 'add', query, posizione });
      setBusy(false);
      return r;
    },
    [request],
  );

  /** Anteprima di un link incollato: la riga compare subito, titolo e copertina arrivano dal server. */
  const previewLink = useCallback(
    (url) => {
      const s = searchRef.current;
      if (s && s.kind === 'link' && s.query === url) return;
      const reqId = ++reqSeq.current;
      setSearch({ kind: 'link', reqId, query: url, status: 'loading', info: null, results: [] });
      scrollRef.current?.scrollTo({ top: 0 });
      if (import.meta.env.DEV && anteprima) {
        import('./anteprima.js').then(({ anteprimaLink }) =>
          setTimeout(() => setSearch((x) => (x?.reqId === reqId ? { ...x, status: 'done', info: anteprimaLink(url) } : x)), 400),
        );
        return;
      }
      send({ type: 'anteprimaLink', query: url, reqId });
    },
    [send],
  );

  const runSearch = useCallback(
    (query) => {
      const s = searchRef.current;
      if (s && s.query === query && s.status !== 'error') return; // stessa ricerca già fatta o in corso
      const reqId = ++reqSeq.current;
      setSearch({ reqId, query, status: 'loading', results: [], error: null });
      if (import.meta.env.DEV && anteprima) {
        import('./anteprima.js').then(({ risultatiAnteprima }) =>
          setTimeout(() => setSearch((x) => (x?.reqId === reqId ? { ...x, status: 'done', results: risultatiAnteprima(query) } : x)), 400),
        );
      } else {
        send({ type: 'search', query, reqId });
      }
      scrollRef.current?.scrollTo({ top: 0 });
    },
    [send],
  );

  const closeSearch = useCallback(() => setSearch(null), []);
  const openRef = useRef(false);
  openRef.current = searchOpen;
  const openSearch = useCallback(() => {
    if (openRef.current) return;
    openRef.current = true;
    setSearchOpen(true);
    setAnnounce('Ricerca aperta');
  }, []);
  /** Chiude la ricerca e torna alla coda: campo vuoto, risultati via. */
  const leaveSearch = useCallback((auto = false) => {
    if (!auto && document.activeElement?.closest?.('.pnl__bar')) focusDopo.current = 'pillola';
    setSearch(null);
    setText('');
    setSearchOpen(false);
    setAnnounce(auto ? 'Nessuna attività: torno alla coda' : 'Tornato alla coda');
    if (auto && document.activeElement === inputRef.current) inputRef.current?.blur();
  }, []);
  const addResult = useCallback(
    (id, posizione) => {
      const titolo = searchRef.current?.results?.find((r) => r.id === id)?.title;
      return request({ type: 'addResult', id, posizione, now: posizione === 'ora', titolo });
    },
    [request],
  );
  const addLink = useCallback(
    async (url, posizione) => {
      const s = searchRef.current;
      const r = await request({ type: 'add', query: url, posizione, titolo: s?.info?.title || url });
      // Fatto: il campo si svuota e si torna alla coda (l'avviso resta in basso).
      if (r.ok && searchRef.current?.kind === 'link' && searchRef.current.query === url) {
        setTimeout(() => {
          if (searchRef.current?.kind === 'link' && searchRef.current.query === url) leaveSearch();
        }, 900);
      }
      return r;
    },
    [request, leaveSearch],
  );
  const focusSearch = useCallback(() => {
    if (inputRef.current) return inputRef.current.focus();
    // Desktop a ricerca chiusa: nella barra c'è la pillola, il campo compare dopo l'apertura.
    focusDopo.current = 'campo';
    openSearch();
  }, [openSearch]);
  const retry = useCallback(() => socketRef.current?.retry(), []);
  // Discord non risponde più a questa pagina: l'unico rimedio è chiudere e riaprire l'Activity.
  const [reopenAsked, setReopenAsked] = useState(null); // null | true (chiesto) | false (non riuscito)
  const reopen = useCallback(() => setReopenAsked(Boolean(socketRef.current?.reopen?.())), []);

  // Disposizione dei pannelli (desktop), scelta dal menu del logo e salvata per persona.
  const lay = useLayout();
  const [posTitolo, setPosTitolo] = usePosizione();
  const phone = usePhone();
  // Finestrella in sovraimpressione di Discord (PIP/griglia) o finestra piccola: vista solo da guardare.
  const ridotta = useVistaRidotta();
  // Telefono: si apre sulla scheda Canale (la prima della barra in basso).
  const [tab, setTab] = useState('canale');
  // Telefono: altezza del player fluttuante (con l'eventuale avviso), per lo spazio in fondo alle liste
  // (telefono.css, --mfloat-h): l'ultima riga deve poter salire sopra il player.
  const dockRef = useRef(null);
  useLayoutEffect(() => {
    const el = dockRef.current;
    if (!phone || !el || typeof ResizeObserver === 'undefined') return undefined;
    const root = document.documentElement;
    const set = () => root.style.setProperty('--mfloat-h', `${Math.ceil(el.offsetHeight)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--mfloat-h');
    };
  });
  const [suoniTab, pickSuoniTab] = useSuoniTab();
  const leaveIn = useLeaveCountdown(state, receivedAt);
  const searching = searchOpen || search !== null;
  useEffect(() => {
    const dove = focusDopo.current;
    if (!dove) return;
    focusDopo.current = null;
    (dove === 'campo' ? inputRef : cercaRef).current?.focus();
  }, [searching]);
  const pokeSearch = useIdleClose(searching, busy || search?.status === 'loading', () => leaveSearch(true));
  // Ogni interazione nel pannello di ricerca (campo nella barra e corpo) fa ripartire il conto.
  const activity = searching
    ? { onPointerMove: pokeSearch, onPointerDown: pokeSearch, onKeyDown: pokeSearch, onWheel: pokeSearch, onFocus: pokeSearch, onInput: pokeSearch }
    : null;
  // Telefono: scorre la pagina, non il pannello (styles.css, .layout-m): anche lo scorrimento della pagina
  // conta come attività, così la ricerca non si chiude mentre si scorrono i risultati col dito.
  useEffect(() => {
    if (!searching || !phone) return undefined;
    window.addEventListener('scroll', pokeSearch, { passive: true });
    return () => window.removeEventListener('scroll', pokeSearch);
  }, [searching, phone, pokeSearch]);

  if (status === 'fatal') {
    return (
      <main className="app app--center">
        <div className="fatal" role="alert">
          <h1>Non riesco ad avviare la musica</h1>
          <p>{conn.error}</p>
        </div>
      </main>
    );
  }

  // Viene prima della vista telefono: la finestrella è stretta ma va mostrata così.
  if (ridotta) {
    return <VistaRidotta state={state} receivedAt={receivedAt} offline={status !== 'online' ? labelFor(conn, {}) : null} />;
  }

  const mode = conn.mode;
  const statusLabel = labelFor(conn, { botOnline: state?.botOnline, connected: state?.connected });
  // Stato vecchio a schermo mentre la connessione non c'è: si vede in grigio e i comandi sono fermi.
  const stale = status !== 'online' && state !== null;
  const leaveText = leaveIn != null ? (state?.leaveReason === 'idle' ? `Esco tra ${formatTime(leaveIn)}` : `Esco tra ${leaveIn} s`) : null;
  // Titolo con pallino di stato, comandi di Ferma e disposizioni: tutto nello stesso menu.
  const brand = (
    <Intestazione
      info={statoBot({ state, status, statusLabel, leaveText })}
      state={state}
      send={send}
      lay={lay}
      phone={phone}
      pos={posTitolo}
      onPos={phone ? undefined : setPosTitolo}
      amb={amb}
    />
  );
  const addBar = (
    <AddBar
      ref={inputRef}
      value={text}
      onChange={setText}
      onAdd={(q, p) => {
        // Link + Invio: dritto in coda e si torna alla coda, come prima.
        // Link a un singolo brano già riconosciuto: Invio = come prossimo; playlist o link non letto: in fondo.
        const s = searchRef.current;
        const singolo = p === 'fine' && s?.kind === 'link' && s.query === q && s.info && !s.info.playlist;
        leaveSearch();
        return addQuery(q, singolo ? 'prossimo' : p);
      }}
      onSearch={runSearch}
      onLink={previewLink}
      onClear={closeSearch}
      onOpen={openSearch}
      onEscape={() => leaveSearch()}
      busy={busy}
      disabled={status !== 'online'}
      compact
    />
  );

  const suoniSwitch = (wide, idBase) => (
    <SuoniSwitch
      tab={suoniTab}
      onPick={pickSuoniTab}
      wide={wide}
      sounds={suoni?.length ?? null}
      playlists={playlists?.length ?? null}
      recents={state ? Math.min(5, state.history?.length ?? 0) : null}
      idBase={idBase}
    />
  );
  const suoniBody = (narrow, idBase) => (
    <div key={suoniTab} className="suoni-body" role="tabpanel" id={`${idBase}-pannello`} aria-labelledby={`${idBase}-${suoniTab}`}>
      {suoniTab === 'recenti' ? (
        <Recent history={state?.history} send={send} bare />
      ) : suoniTab === 'libreria' ? (
        <Library
          playlists={playlists}
          user={user}
          current={state?.current}
          queue={state?.queue || []}
          disabled={status !== 'online'}
          narrow={narrow}
          request={playlistRequest}
        />
      ) : (
        <Soundboard
          sounds={suoni}
          send={send}
          request={suoniRequest}
          upload={caricaSuono}
          user={user}
          suono={state?.suono}
          disabled={status !== 'online'}
          bare
          compact={phone}
        />
      )}
    </div>
  );

  const panel = (
    <main
      className={`${phone ? 'card ' : ''}panel`}
      ref={scrollRef}
      onScroll={searching ? pokeSearch : undefined}
      {...activity}
    >
      {!insideDiscord && mode === 'prova' && (
        <p className="banner">
          Prova nel browser: il tempo scorre ma non esce audio. Dentro Discord suona nel canale vocale.
        </p>
      )}
      {phone && tab !== 'coda' ? (
        <div className="view">
          {tab === 'canale' && (
            // Come «Nel canale» su PC: titolo con il nome del canale e conteggio, poi le persone.
            <section className="mcanale" aria-label="Nel canale vocale">
              <header className="mcanale__head">
                <h2 className="mcanale__title">{state?.channelName ? `Nel canale · ${state.channelName}` : 'Nel canale'}</h2>
                {state?.members && (
                  <span className="ipill">{state.members.length} {state.members.length === 1 ? 'persona' : 'persone'}</span>
                )}
              </header>
              <Presence members={state?.members} bare />
            </section>
          )}
          {tab === 'suoni' && (
            <div className="suoni-m">
              <div className="suoni-m__bar">{suoniSwitch(false, 'suoni-m')}</div>
              {suoniBody(true, 'suoni-m')}
            </div>
          )}
        </div>
      ) : (
        <>
          {phone && (
            // Telefono, scheda Coda (variante A): «Cerca» largo + Mescola, Ripeti, Svuota a sola icona; a ricerca
            // aperta il campo prende la riga con «Chiudi», come nella barra del pannello Coda su PC.
            <header className={`mqhead${searching ? ' mqhead--search' : ''}`} {...activity}>
              {searching ? (
                <div className="mqhead__row">
                  <CampoAnimato open className="mqhead__search">{addBar}</CampoAnimato>
                  <CloseSearch link={search?.kind === 'link'} onClose={() => leaveSearch()} />
                </div>
              ) : (
                <QueueTools
                  state={state}
                  send={send}
                  phone
                  lead={(
                    <CampoAnimato open={false} className="mqhead__search">
                      <button
                        ref={cercaRef}
                        type="button"
                        className="cpill cpill--cerca mqhead__cerca"
                        onClick={() => {
                          focusDopo.current = 'campo';
                          openSearch();
                        }}
                        disabled={status !== 'online'}
                        aria-label="Cerca un brano o incolla un link"
                      >
                        <I.Search width={18} height={18} />
                        <span className="cpill__text">Cerca</span>
                      </button>
                    </CampoAnimato>
                  )}
                />
              )}
            </header>
          )}
          {searching ? (
            <SearchView
              search={search}
              onAdd={addResult}
              onAddLink={addLink}
              onClose={() => leaveSearch()}
              closeInHead
              phone={phone}
            />
          ) : (
            <Queue state={state} loading={state === null} send={send} onFocusSearch={focusSearch} columns={!phone} head={false} />
          )}
        </>
      )}
    </main>
  );

  const np = <NowPlaying state={state} receivedAt={receivedAt} send={send} layout="m" />;
  // Come la testata della coda: il brano in corso è la riga n° 1.
  const queueLen = (state?.queue?.length || 0) + (state?.current ? 1 : 0);

  let body;
  if (phone) {
    // Barra delle schede in basso: Canale · Coda · Suoni, icona sopra il testo (tavola «Mobile — proposta completa»).
    const TABS = [
      ['canale', `Canale${state?.members ? ` · ${state.members.length}` : ''}`, I.People],
      ['coda', `Coda${queueLen ? ` · ${queueLen}` : ''}`, I.Lines],
      ['suoni', 'Suoni', I.Wave],
    ];
    body = (
      <div className="layout-m">
        <div className="layout-m__top">{brand}</div>
        {panel}
        <div className="mdock" ref={dockRef}>{np}</div>
        <nav className="mtabs" role="tablist" aria-label="Sezioni">
          {TABS.map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              className="mtab"
              aria-selected={tab === id}
              onClick={() => {
                if (tab === id) return;
                setTab(id);
                if (searching) leaveSearch();
                window.scrollTo({ top: 0 });
              }}
            >
              <Icon width={22} height={22} />
              <span className="mtab__txt">{label}</span>
            </button>
          ))}
        </nav>
      </div>
    );
  } else {
    // Contenuto di ogni scheda: titolo, `lead` e strumenti nella barra (scheda sola) o nella riga strumenti
    // sotto le linguette (più schede), corpo sotto. Vedi Panels.jsx.
    const conta = (n, uno, tanti) => <span className="ipill">{n} {n === 1 ? uno : tanti}</span>;
    const renderTab = (id) => {
      switch (id) {
        case 'lettore':
          return {
            title: 'Lettore',
            body: <NowPlaying state={state} receivedAt={receivedAt} send={send} layout="auto" bare />,
          };
        case 'coda':
          // Una sola riga: «Coda» · conteggio · pillola «Cerca» (al centro esatto della barra) · Shuffle, Ripeti, Svuota.
          // Il clic sulla pillola apre la ricerca: la barra mostra il campo largo e «Chiudi» al posto delle
          // pillole, il corpo solo i risultati (queue-head.css).
          return {
            title: 'Coda',
            lead: (
              <CampoAnimato
                open={searching}
                className={`pnl__search${searching ? '' : ' pnl__search--pill'}`}
                title=""
                {...activity}
                // Dal campo non parte il trascinamento del pannello.
                onPointerDown={(e) => {
                  e.stopPropagation();
                  activity?.onPointerDown();
                }}
              >
                {searching ? addBar : (
                  <button
                    ref={cercaRef}
                    type="button"
                    className="cpill cpill--cerca"
                    onClick={() => {
                      focusDopo.current = 'campo';
                      openSearch();
                    }}
                    disabled={status !== 'online'}
                    aria-label="Cerca un brano o incolla un link"
                    {...suggerimento('Cerca un brano o incolla un link')}
                  >
                    <I.Search width={16} height={16} />
                    <span className="cpill__text">Cerca</span>
                  </button>
                )}
              </CampoAnimato>
            ),
            tools: searching
              ? <CloseSearch link={search?.kind === 'link'} onClose={() => leaveSearch()} />
              : <QueueTools state={state} send={send} bar />,
            body: <div className="pnl__queue">{panel}</div>,
          };
        case 'canale':
          return {
            title: 'Nel canale',
            tools: state?.members ? conta(state.members.length, 'persona', 'persone') : null,
            body: <Presence members={state?.members} bare />,
          };
        case 'soundbar':
          return {
            title: 'Soundbar',
            tools: suoni ? conta(suoni.length, 'suono', 'suoni') : null,
            body: (
              <div className="suoni-body">
                <Soundboard
                  sounds={suoni}
                  send={send}
                  request={suoniRequest}
                  upload={caricaSuono}
                  user={user}
                  suono={state?.suono}
                  disabled={status !== 'online'}
                  bare
                />
              </div>
            ),
          };
        case 'libreria':
          return {
            title: 'Libreria',
            tools: playlists ? <span className="ipill">{playlists.length} playlist</span> : null,
            body: (
              <div className="suoni-body">
                <Library
                  playlists={playlists}
                  user={user}
                  current={state?.current}
                  queue={state?.queue || []}
                  disabled={status !== 'online'}
                  narrow={false}
                  request={playlistRequest}
                />
              </div>
            ),
          };
        default:
          return {
            title: 'Recenti',
            body: (
              <div className="suoni-body">
                <Recent history={state?.history} send={send} bare />
              </div>
            ),
          };
      }
    };
    body = (
      <div className="layout-p">
        <Panels
          layout={lay.layout}
          onChange={lay.change}
          onAct={lay.setAct}
          render={renderTab}
          head={<header className="layout-p__top">{brand}</header>}
          headPos={posTitolo}
        />
      </div>
    );
  }

  return (
    <div
      className={`app${amb.on ? ` amb${amb.pannelli === 'traslucidi' ? ' amb--glass' : ''}` : ''}`}
      style={{ '--tint': tint, '--amb1': palette[0], '--amb2': palette[1], '--amb3': palette[2], '--amb-k': `${amb.k}%` }}
    >
      <div className={`app__body ${stale ? 'is-stale' : ''}`} aria-busy={stale}>{body}</div>

      {stuck && status === 'reopen' && (
        <div className="conn-banner conn-banner--error" role="alert">
          <p>
            {reopenAsked === null
              ? stuckMessage(conn)
              : reopenAsked
                ? 'Ho chiesto a Discord di chiudere l’Activity: riaprila dal canale vocale. Se resta aperta, chiudila tu con la X di Discord e riaprila.'
                : 'Non riesco a chiuderla da qui: chiudi l’Activity con la X di Discord e riaprila dal canale vocale.'}
          </p>
          {reopenAsked === null && (
            <button type="button" className="btn-pill" onClick={reopen}>Riapri l’Activity</button>
          )}
        </div>
      )}
      {stuck && status !== 'reopen' && (
        <div className="conn-banner conn-banner--error" role="alert">
          <p>{status === 'denied' ? conn.error || 'Accesso negato' : stuckMessage(conn)}</p>
          <button type="button" className="btn-pill" onClick={retry}>Riprova</button>
        </div>
      )}
      {stale && !stuck && (
        <p className="conn-banner" role="status">
          <span className="spinner" aria-hidden="true" />
          Riconnessione… mostro l’ultimo stato noto
        </p>
      )}

      <p className="sr-only" aria-live="polite">{announce}</p>
      <div className="toast-slot" aria-live="polite">
        {notice && (
          <p className={`toast toast--${notice.kind}`} role={notice.kind === 'error' ? 'alert' : undefined}>
            {notice.message}
          </p>
        )}
      </div>
    </div>
  );
}
