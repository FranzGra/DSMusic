// Avvia un quick tunnel di Cloudflare verso il server locale.
// L'indirizzo *.trycloudflare.com cambia a ogni avvio: va copiato nell'URL mapping del Developer Portal.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let port = process.env.PORT;
const envFile = path.join(root, '.env');
if (!port && fs.existsSync(envFile)) {
  port = fs.readFileSync(envFile, 'utf8').match(/^\s*PORT\s*=\s*(\d+)/m)?.[1];
}
port ||= '3001';

const candidates = [
  process.env.CLOUDFLARED_PATH,
  'cloudflared',
  'C:/Program Files (x86)/cloudflared/cloudflared.exe',
  'C:/Program Files/cloudflared/cloudflared.exe',
].filter(Boolean);
const bin = candidates.find((c) => spawnSync(c, ['--version'], { windowsHide: true }).status === 0);
if (!bin) {
  console.error('cloudflared non trovato. Installa con: winget install --id Cloudflare.cloudflared -e');
  process.exit(1);
}

console.log(`Avvio tunnel verso http://localhost:${port} …`);
const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
  stdio: ['ignore', 'inherit', 'pipe'],
  windowsHide: true,
});
let shown = false;
proc.stderr.on('data', (d) => {
  const s = String(d);
  process.stderr.write(s);
  const host = s.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/)?.[1];
  if (host && !shown) {
    shown = true;
    console.log(`\n  ➜ Indirizzo del tunnel: ${host}`);
    console.log('  ➜ Developer Portal → Activities → URL Mappings → PREFIX "/"  TARGET', host, '\n');
  }
});
proc.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => proc.kill());
