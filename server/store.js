// server/store.js
//
// Thin storage abstraction. Uses Upstash Redis (over REST) when credentials
// are present in the environment; otherwise falls back to an in-process Map
// so the whole app runs locally with zero external services.
//
// Everything is stored as a JSON string under a plain key. Callers work with
// plain objects via getJSON/setJSON and never touch the client directly, so
// swapping the backend later doesn't ripple through the rest of the app.

const hasUpstash = !!(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);

let client;
let mode;

if (hasUpstash) {
  const { Redis } = require('@upstash/redis');
  client = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  mode = 'upstash';
} else {
  mode = 'memory';
  const memory = new Map(); // key -> { value: string, expiresAt: number|null }
  const isExpired = (entry) => entry.expiresAt !== null && Date.now() > entry.expiresAt;

  client = {
    async get(key) {
      const entry = memory.get(key);
      if (!entry) return null;
      if (isExpired(entry)) {
        memory.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, opts = {}) {
      const expiresAt = opts.ex ? Date.now() + opts.ex * 1000 : null;
      memory.set(key, { value, expiresAt });
      return 'OK';
    },
    async del(key) {
      memory.delete(key);
      return 1;
    },
    async expire(key, seconds) {
      const entry = memory.get(key);
      if (!entry) return 0;
      entry.expiresAt = Date.now() + seconds * 1000;
      return 1;
    },
  };
}

if (mode === 'memory') {
  // eslint-disable-next-line no-console
  console.log('[store] No UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN set — using in-memory storage.');
  console.log('[store] Great for local dev. On Render this resets on every restart/redeploy/spin-down — set the two env vars for real deploys.');
} else {
  // eslint-disable-next-line no-console
  console.log('[store] Connected to Upstash Redis.');
}

const ROOM_TTL_SECONDS = 60 * 60 * 24; // a room outlives one game night, then vanishes on its own
const ROLE_LIBRARY_KEY = 'roles:library';

async function getJSON(key) {
  const raw = await client.get(key);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  // @upstash/redis sometimes auto-deserializes JSON-looking strings for us
  return raw;
}

async function setJSON(key, value, { ttlSeconds } = {}) {
  const payload = JSON.stringify(value);
  if (ttlSeconds) {
    await client.set(key, payload, { ex: ttlSeconds });
  } else {
    await client.set(key, payload);
  }
}

async function del(key) {
  await client.del(key);
}

async function touchExpiry(key, ttlSeconds) {
  await client.expire(key, ttlSeconds);
}

module.exports = {
  mode,
  getJSON,
  setJSON,
  del,
  touchExpiry,
  ROOM_TTL_SECONDS,
  ROLE_LIBRARY_KEY,
  roomKey: (code) => `room:${String(code).toUpperCase()}`,
};
