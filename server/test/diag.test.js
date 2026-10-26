// Diagnostica dell'aggancio a Discord: sonda dei messaggi, riparazione del READY (issue #386 dell'SDK),
// rapporto senza dati sensibili, riga di log e limite di frequenza del server. Avvio: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReport, createMessageProbe, createReportGate, describeMessage, isDiscordOrigin, rescueReady, sanitizeReady,
  summarizeHello,
} from '../../client/src/diag.js';
import { createDiagLimiter, diagLine } from '../src/diag.js';
// Schema vero dell'SDK installato (non esportato dal pacchetto: percorso diretto).
import { parseIncomingPayload } from '../../node_modules/@discord/embedded-app-sdk/output/schema/index.mjs';

const readyFrame = (avatar) => [1, {
  cmd: 'DISPATCH',
  evt: 'READY',
  nonce: null,
  data: {
    v: 1,
    config: { cdn_host: 'cdn.discordapp.com', api_endpoint: '//discord.com/api', environment: 'production' },
    user: { id: '1', username: 'prova', discriminator: '0', avatar },
  },
}];

test('READY con avatar null: l\'SDK lo scarta, dopo sanitizeReady lo accetta', () => {
  const frame = readyFrame(null);
  assert.throws(() => parseIncomingPayload(frame[1]));
  assert.deepEqual(sanitizeReady(frame), ['user.avatar']);
  assert.equal(parseIncomingPayload(frame[1]).evt, 'READY');
  // con l'avatar non tocca niente
  const ok = readyFrame('abc');
  assert.deepEqual(sanitizeReady(ok), []);
  assert.equal(ok[1].data.user.avatar, 'abc');
});

test('describeMessage: solo opcode e cmd/evt, mai il contenuto', () => {
  assert.equal(describeMessage(readyFrame('x')), '1:DISPATCH:READY');
  assert.equal(describeMessage([1, { cmd: 'AUTHORIZE', data: { code: 'segreto' } }]), '1:AUTHORIZE');
  assert.equal(describeMessage([3, {}]), '3');
  assert.equal(describeMessage('ciao'), 'altro');
  assert.equal(describeMessage([9, {}]), 'altro');
});

test('isDiscordOrigin: solo https e domini di Discord', () => {
  assert.ok(isDiscordOrigin('https://discord.com'));
  assert.ok(isDiscordOrigin('https://ptb.discord.com'));
  assert.ok(!isDiscordOrigin('http://discord.com'));
  assert.ok(!isDiscordOrigin('https://discord.com.evil.it'));
  assert.ok(!isDiscordOrigin('https://123.discordsays.com'));
  assert.ok(!isDiscordOrigin('null'));
});

test('sonda: conta i messaggi, ripara il READY solo se viene dal genitore Discord', () => {
  const seen = [];
  const probe = createMessageProbe({ isParent: (ev) => ev.fromParent, onReady: (d) => seen.push(d) });
  probe.handle({ origin: 'https://discord.com', data: [3, {}], fromParent: true });
  const finto = readyFrame(null);
  probe.handle({ origin: 'https://123.discordsays.com', data: finto, fromParent: false });
  assert.equal(finto[1].data.user.avatar, null, 'da altre origini non si tocca');
  assert.equal(probe.state.ready, null);
  const vero = readyFrame(null);
  probe.handle({ origin: 'https://discord.com', data: vero, fromParent: true }, 1234);
  assert.equal('avatar' in vero[1].data.user, false);
  assert.deepEqual(probe.state.ready, { at: 1234, fixed: ['user.avatar'] });
  assert.equal(seen.length, 1);
  assert.equal(probe.state.count, 3);
  assert.deepEqual(probe.state.origins, ['https://discord.com', 'https://123.discordsays.com']);
  assert.deepEqual(probe.state.kinds, ['3', '1:DISPATCH:READY', '1:DISPATCH:READY']);
});

test('rescueReady: consegna il READY all\'SDK solo se non è già pronto', () => {
  const emitted = [];
  const sdk = { isReady: false, eventBus: { emit: (e, d) => { emitted.push([e, d]); sdk.isReady = true; } } };
  assert.equal(rescueReady(sdk, { v: 1 }), true);
  assert.deepEqual(emitted, [['READY', { v: 1 }]]);
  assert.equal(rescueReady(sdk, { v: 1 }), false, 'già pronto');
  assert.equal(rescueReady(null, { v: 1 }), false);
  assert.equal(rescueReady({ isReady: false }, { v: 1 }), false, 'SDK senza eventBus');
});

test('rapporto: niente token, code o id; referrer ridotto all\'origine', () => {
  const probe = createMessageProbe();
  probe.handle({ origin: 'https://discord.com', data: [1, { cmd: 'AUTHORIZE', data: { code: 'CODICE-SEGRETO' } }] });
  const r = buildReport({
    env: {
      search: '?frame_id=F1&instance_id=I1&platform=desktop&guild_id=G123&channel_id=C1&discord_shim=1',
      referrer: 'https://discord.com/channels/123/456',
      inIframe: true,
      hasOpener: false,
      build: 'index-Ba8Xgqwr.js',
      navType: 'reload',
      sinceLoadMs: 15000,
      ua: 'Mozilla/5.0 discord/1.0.9999',
    },
    probe,
    sdk: { isReady: false, accessToken: 'TOKEN-SEGRETO' },
    outcome: 'errore',
    step: 'ready',
    kind: 'timeout',
    error: 'Discord non risponde all\'Activity',
    attempt: 2,
    handshakes: 2,
    stepMs: 10000,
  });
  const s = JSON.stringify(r);
  for (const bad of ['CODICE-SEGRETO', 'TOKEN-SEGRETO', 'F1', 'I1', 'G123', '/channels/']) assert.ok(!s.includes(bad), bad);
  assert.equal(r.referrer, 'https://discord.com');
  assert.deepEqual(r.query, { frame_id: true, instance_id: true, platform: 'desktop', guild_id: true, channel_id: true, discord_shim: true });
  assert.equal(r.navigazione, 'reload');
  assert.deepEqual(r.messaggi.tipi, ['1:AUTHORIZE']);
  assert.equal(r.sdk.pronto, false);
  assert.equal(r.sdk.strette, 2);

  // riga del server: campi noti, corta, niente token
  const line = diagLine({ ...r, extra: 'x'.repeat(5000), errore: `abc ${'A'.repeat(40)}` }, { addr: '1.2.3.4' });
  assert.ok(line.startsWith('[diag] errore passo=ready tipo=timeout'));
  assert.ok(line.includes('referrer=https://discord.com'));
  assert.ok(line.includes('nav=reload'));
  assert.ok(line.includes('ready=n'));
  assert.ok(!line.includes('A'.repeat(32)), 'stringhe tipo token nascoste');
  assert.ok(!line.includes('xxxx'));
  assert.ok(line.length <= 901);
  assert.ok(!/\n/.test(diagLine({ errore: 'a\nb', ua: 'x\ry' })));
  // corpo strano: nessuna eccezione
  assert.ok(diagLine(null).startsWith('[diag] ?'));
  assert.ok(diagLine({ messaggi: { origini: 'non lista', tipi: [1, 2] } }).includes('tipi=[1,2]'));
});

test('limiti: al più un rapporto per chiave, al più max per pagina; server 10/min per indirizzo', () => {
  const gate = createReportGate({ max: 2 });
  assert.equal(gate('errore:ready'), true);
  assert.equal(gate('errore:ready'), false);
  assert.equal(gate('ok'), true);
  assert.equal(gate('errore:token'), false, 'oltre il massimo');

  let t = 0;
  const allow = createDiagLimiter({ perAddr: 2, total: 3, now: () => t });
  assert.deepEqual([allow('a'), allow('a'), allow('a')], [true, true, false]);
  assert.equal(allow('b'), true);
  assert.equal(allow('c'), false, 'limite totale');
  t = 60_000;
  assert.equal(allow('a'), true, 'nuovo minuto');
});

test('HELLO e tempi: riassunto senza id né testi lunghi, tempi di arrivo e strette di mano', () => {
  assert.equal(summarizeHello({ v: 1, encoding: 'json', frame_id: '123456789012345678', nome: 'una frase lunga con spazi', ok: true, x: null, o: {} }),
    'v=1,encoding=json,frame_id=id,nome=str25,ok=true,x=null,o=object');
  assert.equal(summarizeHello(undefined), 'undefined');
  const probe = createMessageProbe();
  probe.noteHandshake(240.4);
  probe.handle({ origin: 'https://discord.com', data: [3, { v: 1 }] }, 260);
  assert.deepEqual(probe.state.timeline, ['>0@240', '<3@260']);
  assert.equal(probe.state.hello, 'v=1');
  const line = diagLine({
    esito: 'errore', ripresa: true, visibilita: 'visible', stessoFrame: true, msDaPagPrec: 5000,
    messaggi: { tempi: probe.state.timeline, hello: probe.state.hello },
  });
  assert.match(line, /ripresa=s tempi=\[>0@240,<3@260\] hello="v=1" vis=visible stessoFrame=s msDaPagPrec=5000/);
});
