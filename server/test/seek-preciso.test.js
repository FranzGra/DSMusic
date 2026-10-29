// Cambio di volume e spostamento con la copia Opus (volume 100%, sorgente WebM/Opus): l'audio deve
// partire esattamente dal secondo chiesto, non dal punto di indice (Cues) precedente.
// Usa il vero ffmpeg su un file generato al momento; se ffmpeg non c'è, il test si salta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { createOpusStreamAt } from '../src/audio.js';

const haFfmpeg = spawnSync(config.ffmpeg, ['-version'], { windowsHide: true }).status === 0;

/** Conta i pacchetti audio di un flusso Ogg (senza i 2 di intestazione Opus). */
function pacchettiOgg(buf) {
  let o = 0;
  let n = 0;
  while (o + 27 <= buf.length) {
    const segmenti = buf[o + 26];
    let size = 0;
    for (let i = 0; i < segmenti; i++) {
      const l = buf[o + 27 + i];
      size += l;
      if (l < 255) n++;
    }
    o += 27 + segmenti + size;
  }
  return n - 2;
}

test('copia Opus da metà brano: parte dal secondo chiesto (niente salto indietro al punto di indice)', { skip: !haFfmpeg && 'ffmpeg non installato' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seek-'));
  const file = path.join(dir, 'src.webm');
  let after = async () => {};
  try {
    const r = spawnSync(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60', '-c:a', 'libopus', '-b:a', '96k', file], { windowsHide: true });
    assert.equal(r.status, 0, String(r.stderr));
    // Servito in HTTP con le richieste Range, come la copia in RAM della cache (audiocache.js)
    const dati = fs.readFileSync(file);
    const server = http.createServer((req, res) => {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      const inizio = m ? Number(m[1]) : 0;
      const fine = m && m[2] ? Number(m[2]) : dati.length - 1;
      res.writeHead(m ? 206 : 200, {
        'Content-Type': 'audio/webm', 'Accept-Ranges': 'bytes', 'Content-Length': fine - inizio + 1,
        ...(m ? { 'Content-Range': `bytes ${inizio}-${fine}/${dati.length}` } : {}),
      });
      res.end(dati.subarray(inizio, fine + 1));
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    after = () => new Promise((ok) => server.close(ok));
    const da = 33.7;
    const url = `http://127.0.0.1:${server.address().port}/c/x`;
    const audio = createOpusStreamAt({ url, acodec: 'opus' }, da, { volume: 100, fonte: 'cache', base: 1 }); // base 1: copia possibile
    assert.equal(audio.modo, 'copia');
    const parti = [];
    for await (const c of audio.stream) parti.push(c);
    const secondi = pacchettiOgg(Buffer.concat(parti)) * 0.02; // pacchetti da 20 ms
    // Prima della correzione: ~30 s (riparte dal punto di indice a 30 s, 3,7 s prima)
    assert.ok(Math.abs(secondi - (60 - da)) < 0.1, `audio da ${(60 - secondi).toFixed(2)} s invece che da ${da} s`);
  } finally {
    await after();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
