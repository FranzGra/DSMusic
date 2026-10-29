// Misure senza Discord (non fa login: usa solo yt-dlp, ffmpeg e la cache in RAM). Uso nel container:
//   docker compose exec bot node server/src/misura-avvio.js [link] [secondi-di-partenza] [opzioni]
// Opzioni:
//   --riproduci=60  simula la riproduzione per 60 s (un pacchetto Opus ogni 20 ms, come il player)
//   --volume=60     volume della simulazione (cursore 0-100; il volume lo applica node codificando in Opus)
//   --da=cache|rete sorgente della simulazione (predefinito: cache)
// Stampa: tempo di risoluzione, primo audio da rete / da RAM / ripiego, e per la simulazione la CPU di
// node per pacchetto e la memoria.
import { createAudioResource, StreamType } from '@discordjs/voice';
import { getStream } from './resolver.js';
import { createOpusStream, createOpusStreamAt } from './audio.js';
import { AudioCache } from './audiocache.js';

const opz = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [link = 'https://www.youtube.com/watch?v=pRpeEdMmmQ0', atArg = '0'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const at = Number(atArg);
const s = (t0) => `${((performance.now() - t0) / 1000).toFixed(2)} s`;

/** Tempo al primo audio di una sorgente. */
async function primoAudio(apri, attesaMs = 15_000) {
  const t0 = performance.now();
  const a = apri();
  a.stream.resume();
  try {
    await a.ready(attesaMs);
    return { ok: true, tempo: s(t0), modo: a.modo };
  } catch (err) {
    return { ok: false, tempo: s(t0), errore: err.message.split('\n').pop() };
  } finally {
    a.kill();
  }
}

let t0 = performance.now();
const info = await getStream(link);
console.log(`risoluzione (yt-dlp, 1 chiamata): ${s(t0)} · diretto=${info.direct} · ${info.acodec}/${info.protocol} · «${info.track.title}»`);

const rete = await primoAudio(() => createOpusStreamAt(info, at, { volume: 100 }));
console.log(`rete, primo audio da ${at} s: ${rete.tempo} (${rete.ok ? rete.modo : rete.errore})`);

const cache = new AudioCache({ budgetMb: 96, log: () => {} });
t0 = performance.now();
cache.scarica('brano', info, { durata: info.track.duration, live: info.track.live });
await cache.attesa();
const st = cache.stato();
console.log(`download in RAM: ${st.brani ? `${st.mb} MB in ${s(t0)}` : 'non in cache (link non diretto, a frammenti o troppo lungo)'}`);
const locale = await cache.sorgente('brano');
if (locale) {
  for (const da of [at, Math.min(60, Math.max(0, (info.track.duration || 61) - 5))]) {
    const r = await primoAudio(() => createOpusStreamAt(locale, da, { volume: 100 }));
    const r2 = await primoAudio(() => createOpusStreamAt(locale, da, { volume: 60 }));
    console.log(`RAM, primo audio da ${da} s: ${r.tempo} (${r.modo}) · con volume 60%: ${r2.tempo} (${r2.modo})`);
  }
}

if (opz.riproduci) {
  const secondi = Number(opz.riproduci) || 60;
  const volume = Number(opz.volume ?? 60);
  const sorgente = opz.da === 'rete' || !locale ? info : locale;
  const a = createOpusStreamAt(sorgente, 0, { volume, fonte: sorgente === locale ? 'cache' : 'rete' });
  await a.ready(15_000);
  const r = createAudioResource(a.stream, { inputType: a.tipo ?? StreamType.Opus });
  const cpu0 = process.cpuUsage();
  let n = 0;
  let prossimo = performance.now();
  const fine = prossimo + secondi * 1000;
  while (performance.now() < fine) {
    if (r.read()) n++;
    prossimo += 20;
    await new Promise((res) => setTimeout(res, Math.max(0, prossimo - performance.now())));
  }
  const c = process.cpuUsage(cpu0);
  const ms = (c.user + c.system) / 1000;
  const m = process.memoryUsage();
  console.log(`riproduzione ${secondi} s da ${sorgente === locale ? 'RAM' : 'rete'} (${a.modo}, volume ${volume}): ${n} pacchetti · node CPU ${(ms / (secondi * 10)).toFixed(2)} % (${(ms / Math.max(1, n)).toFixed(3)} ms/pacchetto) · rss ${(m.rss / 1048576).toFixed(0)} MB, heap ${(m.heapUsed / 1048576).toFixed(0)} MB, buffer ${(m.arrayBuffers / 1048576).toFixed(1)} MB`);
  a.kill();
}

t0 = performance.now();
const b = await primoAudio(() => createOpusStream(link, at, { volume: 60 }), 60_000);
console.log(`ripiego yt-dlp | ffmpeg, primo audio da ${at} s: ${b.tempo}${b.ok ? '' : ` (fallito: ${b.errore})`}`);
cache.svuota();
setTimeout(() => process.exit(0), 200);
