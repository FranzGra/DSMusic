// «Svuota la coda»: toglie i brani successivi, quello in corso continua. Niente Discord né yt-dlp.
// Avvio: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GuildMusic } from '../src/music.js';

const creati = [];
afterEach(() => { for (const g of creati.splice(0)) g.stop(); });

let n = 0;
const track = (title) => ({
  id: `${title}-${++n}`, title, author: 'Test', url: `https://soundcloud.com/x/${title}`,
  duration: 200, thumbnail: null, requestedBy: 'Test', query: null,
});

function setup() {
  const stati = [];
  const salvati = [];
  const protezioni = [];
  const g = new GuildMusic('g', {
    bot: null, onChange: (_g, s) => stati.push(s), onPersist: (_g, d) => salvati.push(d),
    onNotice() {}, idleMinutes: 0, emptySeconds: 0,
  });
  g.cache = { proteggi: (_o, chiavi) => protezioni.push(chiavi), ha: () => false };
  creati.push(g);
  g.lib = { ...g.lib, resolveInput: async (q) => ({ tracks: [track(q)], playlistTitle: null }) };
  return { g, stati, salvati, protezioni };
}

test('clear con brano in corso: la coda si svuota, il brano continua, stato e salvataggio aggiornati', async () => {
  const { g, stati, salvati } = setup();
  await g.add('A');
  await g.add('B');
  await g.add('C');
  assert.equal(g.current.title, 'A');
  const prima = stati.length;
  assert.equal(g.clear(), 2);
  assert.equal(g.current.title, 'A');
  assert.equal(g.queue.length, 0);
  assert.equal(g.prossimi.size, 0);
  assert.ok(stati.length > prima, 'stato mandato a tutti');
  assert.deepEqual(stati.at(-1).queue, []);
  assert.equal(stati.at(-1).current.title, 'A');
  assert.ok(salvati.length > 0);
  assert.equal(JSON.stringify(salvati.at(-1)).includes('"B"'), false, 'la coda salvata non ha più i brani');
});

test('clear a coda vuota: nessun effetto e nessun errore', async () => {
  const { g, stati } = setup();
  assert.equal(g.clear(), 0);
  await g.add('A');
  const prima = stati.length;
  assert.equal(g.clear(), 0);
  assert.equal(stati.length, prima, 'niente stato inutile');
  assert.equal(g.current.title, 'A');
});

test('clear toglie anche la protezione del brano preparato in anticipo e azzera i «prossimi»', async () => {
  const { g, protezioni } = setup();
  await g.add('A');
  await g.add('B');
  await g.add('X', { posizione: 'prossimo' });
  assert.equal(g.prossimi.size, 1);
  g.clear();
  assert.equal(g.prossimi.size, 0);
  assert.deepEqual(protezioni.at(-1).filter(Boolean), [g.current.url], 'resta protetto solo il brano in corso');
  assert.equal(g.prossimoBrano(), null);
});

test('prefetch già partito: se la coda viene svuotata, non prepara il brano tolto', async () => {
  const { g } = setup();
  await g.add('A');
  await g.add('B');
  g.bot = { ready: true, isConnected: () => false, channelOf: () => null };
  let preparati = 0;
  g.inVoice = () => true;
  g.inCache = () => { preparati++; };
  g.streamInfo = async () => ({ direct: 'x' });
  const p = g.prefetch();
  g.clear();
  await p;
  assert.equal(preparati, 0);
  g.bot = null;
});
