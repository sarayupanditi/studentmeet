import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { Hub } from "./hub.js";

const PORT = Number(process.env.PORT ?? 8787);
const HEARTBEAT_MS = 30_000;

export function startServer(port = PORT) {
  const hub = new Hub();

  const http = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...hub.stats() }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 256 * 1024 });

  // Protocol-level heartbeat: detects half-open TCP connections (e.g. a laptop
  // that went to sleep) so their seat moves into the reconnect grace window.
  const alive = new WeakMap<WebSocket, boolean>();
  wss.on("connection", (ws) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    hub.attach(ws);
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);

  http.listen(port, () => {
    console.log(`StudentMeet server listening on http://localhost:${port} (ws path /ws)`);
  });

  const close = () =>
    new Promise<void>((resolve) => {
      clearInterval(heartbeat);
      hub.dispose();
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => http.close(() => resolve()));
    });

  return { http, wss, hub, close };
}

// Run when executed directly (not when imported by tests).
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("index.ts");
if (isMain) {
  const { close } = startServer();
  const shutdown = () => close().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
