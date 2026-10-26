import { useState } from 'react';
import './presence.css';

/**
 * Chi è nel canale vocale: `state.members` dal server,
 * [{ id, name, avatar, avatarUrl, speaking, muted, deaf, serverMuted, serverDeaf, streaming, video }].
 * `avatar` passa già dal proxy /api/thumb. `null` = elenco sconosciuto (prova senza bot), `[]` = nessuno.
 * Chi parla cambia spesso (messaggio leggero `members`): si vede solo dall'anello verde, senza testo che
 * salta, così la riga non si muove. Stati nella riga, in quest'ordine: badge rosso «LIVE» (condivide
 * lo schermo, come in Discord), «Video» (videocamera), poi muto / «non sente» (anche «dal server»).
 * Con due o più stati, quelli dopo LIVE diventano solo icone. Riga sempre su una linea: se non ci sta,
 * prima si accorcia il nome, poi gli stati, con i puntini.
 */
function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || '?';
}

export function Avatar({ member }) {
  // Immagine che non si carica (avatar cambiato, proxy giù): torna l'iniziale.
  const [broken, setBroken] = useState(null);
  const src = member.avatar && broken !== member.avatar ? member.avatar : null;
  return (
    <span className={`avatar ${member.speaking ? 'avatar--talk' : ''}`} aria-hidden="true">
      {src ? <img src={src} alt="" width="32" height="32" loading="lazy" decoding="async" onError={() => setBroken(src)} /> : initials(member.name)}
    </span>
  );
}

const MicOff = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.8" />
    <path d="M19 11a7 7 0 0 1-1.2 3.9M5 11a7 7 0 0 0 11 5.7M12 18v3M3 3l18 18" />
  </svg>
);
const DeafIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 15v-3a8 8 0 0 1 12.7-6.5M20 12v3M4 15h3v5H5a1 1 0 0 1-1-1zM20 15h-3v5h2a1 1 0 0 0 1-1zM3 3l18 18" />
  </svg>
);

const CamIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="6" width="14" height="12" rx="2" />
    <path d="m16 10 6-3v10l-6-3z" />
  </svg>
);

/** Stati della persona in ordine: { key, testo, descrizione per title / lettori di schermo }. */
export function statiPersona(m) {
  const out = [];
  if (m.video) out.push({ key: 'video', testo: 'Video', desc: 'videocamera accesa' });
  if (m.deaf) {
    const srv = m.serverDeaf;
    out.push({ key: 'deaf', testo: srv ? 'non sente (server)' : 'non sente', desc: srv ? 'audio tolto dal server' : 'audio disattivato' });
  } else if (m.muted) {
    const srv = m.serverMuted;
    out.push({ key: 'muted', testo: srv ? 'muto (server)' : 'muto', desc: srv ? 'silenziato dal server' : 'microfono spento' });
  }
  return out;
}

function titolo(m) {
  const parti = [m.name || 'Senza nome'];
  if (m.speaking) parti.push('sta parlando');
  if (m.streaming) parti.push('condivide lo schermo');
  for (const s of statiPersona(m)) parti.push(s.desc);
  return parti.join(' · ');
}

/** `bare`: dentro un pannello, che ha già cornice e titolo. */
export default function Presence({ members, className = '', bare = false }) {
  const list = Array.isArray(members) ? members : null;
  return (
    <section className={`${bare ? 'side-card--bare' : 'card'} side-card presence ${className}`} aria-label="Nel canale vocale">
      {!bare && (
        <div className="side-card__head">
          <h2 className="lab">Nel canale</h2>
          {list && <span className="muted">{list.length}</span>}
        </div>
      )}
      {!list ? (
        <p className="muted">Elenco non ancora disponibile.</p>
      ) : list.length === 0 ? (
        <p className="muted">Nessuno nel canale.</p>
      ) : (
        <ul className="people">
          {list.map((m) => {
            const stati = statiPersona(m);
            // Due o più stati: Video / muto / «non sente» restano solo icona (testo nel title e per i lettori di schermo).
            const compatto = (m.streaming ? 1 : 0) + stati.length > 1;
            return (
              <li key={m.id} className="person" title={titolo(m)}>
                <Avatar member={m} />
                <span className="person__name">{m.name || 'Senza nome'}</span>
                {(m.streaming || stati.length > 0) && (
                  <span className="person__states">
                    {m.streaming && (
                      <span className="live-badge" title="Condivide lo schermo">
                        LIVE<span className="sr-only"> (condivide lo schermo)</span>
                      </span>
                    )}
                    {stati.map((s) => (
                      <span key={s.key} className="person__state" title={s.desc}>
                        {s.key === 'video' ? <CamIcon /> : s.key === 'deaf' ? <DeafIcon /> : <MicOff />}
                        <span className={compatto ? 'sr-only' : 'person__state-txt'}>{s.testo}</span>
                      </span>
                    ))}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
