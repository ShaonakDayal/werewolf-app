// server/sse.js
//
// A tiny in-process pub/sub for Server-Sent Events. One Set of host
// connections and one Map of player connections per room code. Single Render
// instance, so no cross-process fan-out needed.

const roomLogic = require('./roomLogic');

const hubs = new Map(); // code -> { host: Set<res>, players: Map<playerId, Set<res>> }

function getHub(code) {
  code = code.toUpperCase();
  if (!hubs.has(code)) hubs.set(code, { host: new Set(), players: new Map() });
  return hubs.get(code);
}

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('\n');
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function addHostClient(code, res) {
  const hub = getHub(code);
  hub.host.add(res);
  res.on('close', () => hub.host.delete(res));
}

function addPlayerClient(code, playerId, res) {
  const hub = getHub(code);
  if (!hub.players.has(playerId)) hub.players.set(playerId, new Set());
  hub.players.get(playerId).add(res);
  res.on('close', () => hub.players.get(playerId)?.delete(res));
}

async function broadcast(code) {
  code = code.toUpperCase();
  const hub = hubs.get(code);
  if (!hub) return;
  let room;
  try {
    room = await roomLogic.loadRoom(code);
  } catch {
    return; // room's gone — clients will find out next time they call the API
  }
  if (hub.host.size > 0) {
    const view = roomLogic.hostView(room);
    for (const res of hub.host) send(res, 'state', view);
  }
  for (const [playerId, resSet] of hub.players) {
    if (resSet.size === 0) continue;
    const view = roomLogic.playerView(room, playerId);
    if (!view) continue;
    for (const res of resSet) send(res, 'state', view);
  }
}

// Keep-alive comment ping, every 5 minutes, for every open connection.
// Two jobs at once: (1) stops intermediary proxies/browsers from treating an
// idle SSE stream as dead, and (2) on Render's free tier, traffic on an
// existing connection resets the 15-minute spin-down clock — so a live game
// with anyone connected keeps the service awake on its own, with no external
// pinger needed. When nobody's connected, there's nothing here to ping, and
// the service is free to spin down as intended between game nights.
const pingTimer = setInterval(() => {
  for (const hub of hubs.values()) {
    for (const res of hub.host) res.write(': ping\n\n');
    for (const resSet of hub.players.values()) {
      for (const res of resSet) res.write(': ping\n\n');
    }
  }
}, 5 * 60 * 1000);
pingTimer.unref(); // don't let this timer alone keep the process alive

module.exports = { sseHeaders, addHostClient, addPlayerClient, broadcast, send };
