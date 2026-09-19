# Werewolf — host/player party game app

A real-time web app for running Werewolf: players join by scanning a QR code
and see only their own role; the host runs the night phases and day votes
from a live dashboard. Built to run on Render's free tier at effectively
zero cost.

## Quick start (local)

```bash
npm install
npm start
```

Open two browser windows:
- **Host:** http://localhost:3000/host/
- **Player:** http://localhost:3000/player/ (or scan the QR the host screen shows)

No external services are required to try it locally — with no Redis
credentials set, the app automatically runs in an in-memory mode (you'll see
a log line confirming this on startup). Room and role data just won't
survive a server restart in that mode, which is fine for local dev.

To smoke-test the whole game flow (role assignment, night resolution with
protect/kill/inspect interaction, vote ties, tie-breaking, elimination)
without clicking through the UI by hand:

```bash
npm start &          # in one terminal
node test-flow.js    # in another, while the server is running
```

## How the pieces fit together

- **`server/store.js`** — storage abstraction. Uses Upstash Redis when
  `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` are set; otherwise an
  in-memory `Map`. Nothing else in the app talks to Redis directly.
- **`server/roomLogic.js`** — the actual game engine: role library CRUD,
  room/player lifecycle, night-action and vote resolution. This is where
  the rules live.
- **`server/sse.js`** — pushes live state to connected browsers over
  Server-Sent Events. One host view (everything) and one player view
  (that player's own role/prompts only) per room.
- **`server/routes/`** — thin HTTP layer over the engine.
- **`public/`** — no build step, no framework. Plain HTML/CSS/JS, split
  into `player/` and `host/` apps that share `css/style.css` and
  `js/common.js`.

## Deploying for real (free)

### 1. Create a free Redis database (Upstash)

1. Sign up at [upstash.com](https://upstash.com) (free, no card required).
2. Create a Redis database — any region close to you is fine.
3. On the database page, find the **REST API** section and copy the
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` values.

This is what makes the shared custom-role library persist across hosts and
devices, and it also means an accidental redeploy mid-game no longer wipes
an active room — both were reasons we picked it over the alternatives (see
the "Why Redis" note below if you want the full reasoning back).

### 2. Push this project to GitHub

Render deploys from a git repo. Create a new repo and push this folder to it.

### 3. Create a Render Web Service (free)

1. In the Render dashboard: **New → Web Service**, connect your repo.
2. **Build command:** `npm install`
3. **Start command:** `npm start`
4. **Instance type:** Free
5. Under **Environment**, add the two variables from step 1:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
6. Deploy. Render gives you a `https://your-app.onrender.com` URL.

### 4. First game night

- Open `https://your-app.onrender.com/host/` and **bookmark it** — this is
  your permanent "host home." Anyone you want acting as host can use the
  same bookmark; the role library is shared.
- A minute or two before people start scanning, open the host page yourself
  first — this wakes the service up if it's been asleep, so your players
  don't hit the ~30-60s cold start on the very first scan.
- Build your role loadout, hit **Create room**, and share the QR code /
  room code shown. Each round, come back to the host home and create a
  fresh room — that was your call in the design discussion (a new QR per
  round rather than reusing one room), and the host home bookmark is what
  makes that fast.

## Notes on free-tier behavior worth knowing

- **Cold start:** after ~15 minutes with no traffic, Render spins the free
  service down. The next request takes ~30-60 seconds to wake it back up.
  Once anyone's connected during a live game, the SSE heartbeat keeps the
  service awake on its own — see the comment in `server/sse.js`.
- **Rooms expire automatically** 24 hours after creation (or after last
  activity, in Upstash mode) — no cleanup job needed, and it's a non-issue
  for a "few rounds one evening" usage pattern.
- **No accounts.** The host dashboard URL contains a secret token
  (`?room=CODE&secret=...`) — treat that link like a password; anyone with
  it has full host control of that room. The role library itself has no
  access control, by design (you told me you wanted one shared library
  everyone can see and edit).
- **Single instance, in-process SSE.** Free tier doesn't scale
  horizontally, so there's no multi-instance state-sync problem to worry
  about — one Node process holds the live connections directly.

## Extending the role system

Every role (built-in or custom) declares a small, fixed action shape rather
than arbitrary logic — see the comment at the top of `server/roomLogic.js`:

```
action.type   'none' | 'solo' | 'team'
action.effect 'none' | 'kill' | 'protect' | 'inspect'
action.order  resolution priority, lower resolves first
```

This covers most homebrew Werewolf roles (bodyguards, seers, hunters,
vigilantes, cupid-as-inspect, etc.) without needing a scripting engine. If
you eventually want an effect this doesn't cover, `resolveNight()` in
`roomLogic.js` is the one place that would need a new branch.

## Known limitations / good next steps

- No dedicated "server is waking up" screen — right now a cold start just
  shows the existing loading spinner a bit longer. Worth a friendlier,
  on-theme message if the ~30-60s wait bothers you in practice.
- No locking around concurrent writes to the same room. Fine at party
  scale (one host clicking buttons, a dozen-ish players), but worth knowing
  if this ever needs to handle much heavier simultaneous traffic.
- Solo actions (Seer, Doctor) can target any living player, including
  self; team actions (Werewolf) exclude the actor's own team as valid
  targets. Straightforward to change in `candidatesFor()` if you want
  different rules for a custom role.
