// Battito del WebSocket lato server: ogni intervallo manda un ping; chi non ha risposto (pong o
// qualsiasi messaggio) dall'ultimo giro viene chiuso, così le connessioni morte non restano appese.

/**
 * @param {import('ws').WebSocketServer | { clients: Set<any>, on: Function }} wss
 * @returns {() => void} ferma il battito
 */
export function startHeartbeat(wss, { intervalMs = 25_000 } = {}) {
  const vivo = function vivo() { this.isAlive = true; };
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', vivo);
    ws.on('message', vivo);
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      if (ws.readyState === 1) ws.ping();
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
