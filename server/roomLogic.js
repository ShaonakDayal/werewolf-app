// server/roomLogic.js
//
// All game rules live here. Routes just parse HTTP in/out; this file is the
// actual "engine" — room creation, role assignment, night-action / vote
// resolution, and the host-view / player-view projections.
//
// Design note on custom roles: rather than letting a role script arbitrary
// behaviour, every role (built-in or custom) declares:
//   action.type   'none' | 'solo'  | 'team'
//   action.effect 'none' | 'kill'  | 'protect' | 'inspect'
//   action.order  resolution priority, lower resolves first
// That's a small fixed vocabulary, but it covers the large majority of
// homebrew Werewolf roles (bodyguards, seers, hunters, cupids-as-inspect,
// vigilantes-as-solo-kill, etc.) without needing a scripting engine.

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const store = require('./store');

const SEED_ROLES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'roles.seed.json'), 'utf8')
);

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const ROOM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — read aloud at a party
function generateRoomCode(length = 4) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ROOM_CODE_CHARS[crypto.randomInt(ROOM_CODE_CHARS.length)];
  }
  return out;
}

function newId() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Role library (shared across all hosts)
// ---------------------------------------------------------------------------

async function getRoleLibrary() {
  let lib = await store.getJSON(store.ROLE_LIBRARY_KEY);
  if (!lib) {
    lib = SEED_ROLES;
    await store.setJSON(store.ROLE_LIBRARY_KEY, lib); // no TTL — this should persist indefinitely
  }
  return lib;
}

async function saveRoleLibrary(lib) {
  await store.setJSON(store.ROLE_LIBRARY_KEY, lib);
}

function validateRoleShape(input) {
  const name = String(input.name || '').trim();
  if (!name) throw new ApiError(400, 'invalid_role', 'Role needs a name.');
  const type = ['none', 'solo', 'team'].includes(input.action?.type) ? input.action.type : 'none';
  const effect = ['none', 'kill', 'protect', 'inspect'].includes(input.action?.effect)
    ? input.action.effect
    : 'none';
  return {
    name,
    emoji: String(input.emoji || '\ud83c\udccf').slice(0, 8),
    team: String(input.team || 'Village').trim() || 'Village',
    shortText: String(input.shortText || '').slice(0, 140),
    powerText: String(input.powerText || '').slice(0, 600),
    action: {
      type,
      effect: type === 'none' ? 'none' : effect,
      order: Number.isFinite(input.action?.order) ? input.action.order : 10,
    },
  };
}

async function addRole(input) {
  const lib = await getRoleLibrary();
  const role = { id: newId(), builtIn: false, ...validateRoleShape(input) };
  lib.push(role);
  await saveRoleLibrary(lib);
  return role;
}

async function updateRole(id, input) {
  const lib = await getRoleLibrary();
  const idx = lib.findIndex((r) => r.id === id);
  if (idx === -1) throw new ApiError(404, 'role_not_found', 'That role no longer exists.');
  const updated = { ...lib[idx], ...validateRoleShape({ ...lib[idx], ...input }) };
  lib[idx] = updated;
  await saveRoleLibrary(lib);
  return updated;
}

async function deleteRole(id) {
  const lib = await getRoleLibrary();
  const next = lib.filter((r) => r.id !== id);
  await saveRoleLibrary(next);
}

// ---------------------------------------------------------------------------
// Room persistence helpers
// ---------------------------------------------------------------------------

async function loadRoom(code) {
  const room = await store.getJSON(store.roomKey(code));
  if (!room) throw new ApiError(404, 'room_not_found', 'That room code doesn\u2019t exist or has expired.');
  return room;
}

async function saveRoom(room) {
  room.updatedAt = Date.now();
  await store.setJSON(store.roomKey(room.code), room, { ttlSeconds: store.ROOM_TTL_SECONDS });
  return room;
}

function verifyHostSecret(room, secret) {
  if (!secret || secret !== room.hostSecret) {
    throw new ApiError(403, 'bad_host_secret', 'Not authorized for this room.');
  }
}

function findPlayer(room, playerId) {
  const p = room.players.find((pl) => pl.id === playerId);
  if (!p) throw new ApiError(404, 'player_not_found', 'You\u2019re not in this room (anymore).');
  return p;
}

function verifyPlayerToken(room, playerId, token) {
  const p = findPlayer(room, playerId);
  if (!token || token !== p.token) throw new ApiError(403, 'bad_player_token', 'Not authorized for this player.');
  return p;
}

// ---------------------------------------------------------------------------
// Room lifecycle
// ---------------------------------------------------------------------------

async function createRoom({ loadout, nightDurationSeconds, voteDurationSeconds }) {
  if (!Array.isArray(loadout) || loadout.length === 0) {
    throw new ApiError(400, 'invalid_loadout', 'Pick at least one role for this room.');
  }
  const library = await getRoleLibrary();
  const roleAssignments = {}; // roleId -> snapshot of the role def, frozen at room-creation time
  let expectedPlayerCount = 0;
  for (const entry of loadout) {
    const role = library.find((r) => r.id === entry.roleId);
    if (!role) throw new ApiError(400, 'unknown_role', `Unknown role: ${entry.roleId}`);
    const count = Math.max(0, Math.floor(entry.count || 0));
    if (count === 0) continue;
    roleAssignments[role.id] = role;
    expectedPlayerCount += count;
  }
  if (expectedPlayerCount === 0) {
    throw new ApiError(400, 'invalid_loadout', 'Loadout needs at least one role with count > 0.');
  }

  let code = generateRoomCode();
  // extremely unlikely collision given TTL + short lifespan, but check once anyway
  const clash = await store.getJSON(store.roomKey(code));
  if (clash) code = generateRoomCode(5);

  const room = {
    code,
    hostSecret: newId(),
    createdAt: Date.now(),
    status: 'lobby', // lobby | in-progress | ended
    phase: 'lobby', // lobby | reveal | night | day-vote | ended
    expectedPlayerCount,
    loadout: loadout.filter((e) => e.count > 0),
    roleAssignments, // roleId -> role snapshot
    nightDurationSeconds: nightDurationSeconds || 60,
    voteDurationSeconds: voteDurationSeconds || 90,
    round: 0,
    players: [],
    night: null,
    vote: null,
    log: [],
  };
  await saveRoom(room);
  return room;
}

function logEvent(room, message) {
  room.log.push({ ts: Date.now(), message });
  if (room.log.length > 200) room.log.shift();
}

async function joinRoom(code, name) {
  const room = await loadRoom(code);
  if (room.phase !== 'lobby') {
    throw new ApiError(409, 'room_not_joinable', 'This game has already started.');
  }
  const trimmed = String(name || '').trim().slice(0, 24);
  if (!trimmed) throw new ApiError(400, 'invalid_name', 'Enter a name.');

  const player = {
    id: newId(),
    token: newId(),
    name: trimmed,
    roleId: null,
    alive: true,
    eliminatedReason: null,
    eliminatedRound: null,
    lastNightResult: null,
    joinedAt: Date.now(),
  };
  room.players.push(player);
  logEvent(room, `${trimmed} joined.`);
  await saveRoom(room);
  return { room, player };
}

function buildRoleDeck(room) {
  const deck = [];
  for (const entry of room.loadout) {
    for (let i = 0; i < entry.count; i++) deck.push(entry.roleId);
  }
  return deck;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function startGame(code, { hostSecret, force }) {
  const room = await loadRoom(code);
  verifyHostSecret(room, hostSecret);
  if (room.phase !== 'lobby') throw new ApiError(409, 'already_started', 'This game already started.');
  if (room.players.length === 0) throw new ApiError(400, 'no_players', 'No one has joined yet.');
  if (room.players.length !== room.expectedPlayerCount && !force) {
    throw new ApiError(
      409,
      'player_count_mismatch',
      `Expected ${room.expectedPlayerCount} players, ${room.players.length} joined. Pass force to start anyway.`
    );
  }

  let deck = shuffle(buildRoleDeck(room));
  const players = shuffle(room.players);

  // Real-world headcount drift: fewer players than roles -> drop the extra
  // (favouring dropping non-special "none" action roles first); more
  // players than roles -> extras fall back to the plainest role available.
  if (deck.length > players.length) {
    deck.sort((a, b) => {
      const ra = room.roleAssignments[a];
      const rb = room.roleAssignments[b];
      return (ra.action.type === 'none' ? 0 : 1) - (rb.action.type === 'none' ? 0 : 1);
    });
    deck = deck.slice(0, players.length);
  }
  const fallbackRoleId =
    Object.values(room.roleAssignments).find((r) => r.action.type === 'none')?.id ||
    Object.keys(room.roleAssignments)[0];
  while (deck.length < players.length) deck.push(fallbackRoleId);

  players.forEach((p, i) => {
    p.roleId = deck[i];
  });
  room.players = players;
  room.phase = 'reveal';
  room.status = 'in-progress';
  logEvent(room, 'Roles assigned. Game started.');
  await saveRoom(room);
  return room;
}

// ---------------------------------------------------------------------------
// Night phase
// ---------------------------------------------------------------------------

function alivePlayers(room) {
  return room.players.filter((p) => p.alive);
}

async function beginNight(code, { hostSecret, durationSeconds }) {
  const room = await loadRoom(code);
  verifyHostSecret(room, hostSecret);
  if (!['reveal', 'day-vote'].includes(room.phase)) {
    throw new ApiError(409, 'bad_phase', 'Can\u2019t start night from the current phase.');
  }
  room.round += 1;
  const alive = alivePlayers(room);
  const duration = durationSeconds || room.nightDurationSeconds;
  const endsAt = Date.now() + duration * 1000;

  const soloRequirements = [];
  const teamPollsByTeam = new Map();

  for (const p of alive) {
    const role = room.roleAssignments[p.roleId];
    if (!role || role.action.type === 'none') continue;
    if (role.action.type === 'solo') {
      soloRequirements.push({
        actorId: p.id,
        roleId: role.id,
        roleName: role.name,
        effect: role.action.effect,
        order: role.action.order,
        targetId: null,
        submittedAt: null,
      });
    } else if (role.action.type === 'team') {
      const key = role.team;
      if (!teamPollsByTeam.has(key)) {
        teamPollsByTeam.set(key, {
          team: key,
          roleIds: [],
          effect: role.action.effect,
          order: role.action.order,
          eligibleVoterIds: [],
          ballots: {},
          forcedTarget: undefined, // set by break-tie; undefined = not forced
        });
      }
      const poll = teamPollsByTeam.get(key);
      if (!poll.roleIds.includes(role.id)) poll.roleIds.push(role.id);
      poll.eligibleVoterIds.push(p.id);
    }
  }

  room.night = {
    round: room.round,
    active: true,
    endsAt,
    resolved: false,
    soloRequirements,
    teamPolls: Array.from(teamPollsByTeam.values()),
    pendingTies: [],
    result: null,
  };
  room.phase = 'night';
  logEvent(room, `Night ${room.round} begins.`);
  await saveRoom(room);
  return room;
}

function candidatesFor(room, actorId, role) {
  const alive = alivePlayers(room);
  if (role.action.type === 'team') {
    return alive.filter((p) => p.id !== actorId && room.roleAssignments[p.roleId]?.team !== role.team).map((p) => p.id);
  }
  // solo: anyone alive, including self
  return alive.map((p) => p.id);
}

async function submitNightAction(code, { playerId, token, targetId }) {
  const room = await loadRoom(code);
  const player = verifyPlayerToken(room, playerId, token);
  if (!room.night?.active) throw new ApiError(409, 'no_active_night', 'There\u2019s no night action open right now.');
  if (!player.alive) throw new ApiError(403, 'player_dead', 'Eliminated players can\u2019t act.');

  const role = room.roleAssignments[player.roleId];
  if (!role || role.action.type === 'none') {
    throw new ApiError(400, 'no_action', 'Your role has no night action.');
  }

  const alive = new Set(alivePlayers(room).map((p) => p.id));
  if (!alive.has(targetId)) throw new ApiError(400, 'invalid_target', 'That target isn\u2019t valid.');

  if (role.action.type === 'solo') {
    const req = room.night.soloRequirements.find((r) => r.actorId === playerId);
    if (!req) throw new ApiError(400, 'no_action', 'No pending action found for you.');
    req.targetId = targetId;
    req.submittedAt = Date.now();
  } else {
    const poll = room.night.teamPolls.find((p) => p.team === role.team);
    if (!poll || !poll.eligibleVoterIds.includes(playerId)) {
      throw new ApiError(400, 'no_action', 'No pending team action found for you.');
    }
    const validTargets = new Set(candidatesFor(room, playerId, role));
    if (!validTargets.has(targetId)) throw new ApiError(400, 'invalid_target', 'That target isn\u2019t valid for your team.');
    poll.ballots[playerId] = targetId;
  }

  await saveRoom(room);
  return room;
}

function tallyToTop(ballots, candidateIds) {
  const counts = {};
  for (const c of candidateIds) counts[c] = 0;
  for (const target of Object.values(ballots)) {
    if (target in counts) counts[target] += 1;
    else counts[target] = (counts[target] || 0) + 1;
  }
  let max = -1;
  for (const v of Object.values(counts)) if (v > max) max = v;
  const top = Object.entries(counts)
    .filter(([, v]) => v === max && v > 0)
    .map(([id]) => id);
  return { counts, top };
}

async function resolveNight(code, { hostSecret } = {}) {
  const room = await loadRoom(code);
  verifyHostSecret(room, hostSecret);
  if (!room.night?.active) throw new ApiError(409, 'no_active_night', 'No night in progress.');

  const events = [];
  const pendingTies = [];

  for (const req of room.night.soloRequirements) {
    if (req.targetId) {
      events.push({ order: req.order, effect: req.effect, actorId: req.actorId, targetId: req.targetId, roleName: req.roleName });
    }
  }
  for (const poll of room.night.teamPolls) {
    let winner;
    if (poll.forcedTarget !== undefined) {
      winner = poll.forcedTarget; // may be null, meaning host chose "no kill"
    } else {
      const allCandidates = new Set();
      for (const voterId of poll.eligibleVoterIds) {
        const role = room.roleAssignments[room.players.find((p) => p.id === voterId).roleId];
        for (const c of candidatesFor(room, voterId, role)) allCandidates.add(c);
      }
      const { top } = tallyToTop(poll.ballots, Array.from(allCandidates));
      if (top.length > 1) {
        pendingTies.push({ pollKind: 'night', pollKey: poll.team, tiedIds: top });
        continue;
      }
      winner = top[0] || null;
    }
    if (winner) {
      events.push({ order: poll.order, effect: poll.effect, actorId: null, targetId: winner, roleName: poll.team });
    }
  }

  if (pendingTies.length > 0) {
    room.night.pendingTies = pendingTies;
    await saveRoom(room);
    return { room, needsTieBreak: true, ties: pendingTies };
  }

  events.sort((a, b) => a.order - b.order);
  const protectedIds = new Set();
  const killedIds = new Set();

  for (const ev of events) {
    if (ev.effect === 'protect') protectedIds.add(ev.targetId);
    else if (ev.effect === 'kill') {
      if (!protectedIds.has(ev.targetId)) killedIds.add(ev.targetId);
    } else if (ev.effect === 'inspect') {
      const target = room.players.find((p) => p.id === ev.targetId);
      const actor = room.players.find((p) => p.id === ev.actorId);
      if (target && actor) {
        const targetRole = room.roleAssignments[target.roleId];
        actor.lastNightResult = {
          round: room.round,
          text: `${target.name} is on the ${targetRole.team} team.`,
        };
      }
    }
  }

  for (const id of killedIds) {
    const p = room.players.find((pl) => pl.id === id);
    if (p) {
      p.alive = false;
      p.eliminatedReason = 'killed';
      p.eliminatedRound = room.round;
    }
  }

  room.night.active = false;
  room.night.resolved = true;
  room.night.pendingTies = [];
  room.night.result = { killedIds: Array.from(killedIds), protectedIds: Array.from(protectedIds) };
  room.phase = 'night';
  logEvent(
    room,
    killedIds.size > 0
      ? `Night ${room.round}: ${Array.from(killedIds).map((id) => room.players.find((p) => p.id === id)?.name).join(', ')} eliminated.`
      : `Night ${room.round}: no one was eliminated.`
  );
  await saveRoom(room);
  return { room, needsTieBreak: false };
}

// ---------------------------------------------------------------------------
// Day vote (same mechanics as a team-target night poll, reused deliberately)
// ---------------------------------------------------------------------------

async function startVote(code, { hostSecret, durationSeconds }) {
  const room = await loadRoom(code);
  verifyHostSecret(room, hostSecret);
  const alive = alivePlayers(room);
  if (alive.length < 2) throw new ApiError(409, 'not_enough_players', 'Not enough players left to vote.');

  room.vote = {
    round: room.round,
    active: true,
    endsAt: Date.now() + (durationSeconds || room.voteDurationSeconds) * 1000,
    eligibleVoterIds: alive.map((p) => p.id),
    candidateIds: alive.map((p) => p.id),
    ballots: {},
    forcedTarget: undefined,
    resolved: false,
    result: null,
  };
  room.phase = 'day-vote';
  logEvent(room, 'Day vote opened.');
  await saveRoom(room);
  return room;
}

async function submitVote(code, { playerId, token, targetId }) {
  const room = await loadRoom(code);
  const player = verifyPlayerToken(room, playerId, token);
  if (!room.vote?.active) throw new ApiError(409, 'no_active_vote', 'There\u2019s no vote open right now.');
  if (!player.alive) throw new ApiError(403, 'player_dead', 'Eliminated players can\u2019t vote.');
  if (targetId !== null && !room.vote.candidateIds.includes(targetId)) {
    throw new ApiError(400, 'invalid_target', 'That\u2019s not a valid candidate.');
  }
  if (targetId === null) delete room.vote.ballots[playerId];
  else room.vote.ballots[playerId] = targetId;
  await saveRoom(room);
  return room;
}

async function resolveVote(code, { hostSecret } = {}) {
  const room = await loadRoom(code);
  verifyHostSecret(room, hostSecret);
  if (!room.vote?.active) throw new ApiError(409, 'no_active_vote', 'No vote in progress.');

  let winner;
  if (room.vote.forcedTarget !== undefined) {
    winner = room.vote.forcedTarget;
  } else {
    const { top } = tallyToTop(room.vote.ballots, room.vote.candidateIds);
    if (top.length > 1) {
      room.vote.pendingTie = top;
      await saveRoom(room);
      return { room, needsTieBreak: true, tiedIds: top };
    }
    winner = top[0] || null;
  }

  room.vote.pendingTie = null;
  room.vote.active = false;
  room.vote.resolved = true;
  if (winner) {
    const p = room.players.find((pl) => pl.id === winner);
    if (p) {
      p.alive = false;
      p.eliminatedReason = 'voted-out';
      p.eliminatedRound = room.round;
    }
    room.vote.result = { outcome: 'eliminated', targetId: winner };
    logEvent(room, `Vote result: ${p?.name || 'unknown'} was voted out.`);
  } else {
    room.vote.result = { outcome: 'no-elimination' };
    logEvent(room, 'Vote result: no one was eliminated.');
  }
  await saveRoom(room);
  return { room, needsTieBreak: false };
}

async function breakTie(code, { hostSecret, pollKind, pollKey, targetId }) {
  const room = await loadRoom(code);
  verifyHostSecret(room, hostSecret);
  if (pollKind === 'vote') {
    if (!room.vote?.active) throw new ApiError(409, 'no_active_vote', 'No vote in progress.');
    room.vote.forcedTarget = targetId || null;
  } else if (pollKind === 'night') {
    const poll = room.night?.teamPolls.find((p) => p.team === pollKey);
    if (!poll) throw new ApiError(404, 'poll_not_found', 'That night poll no longer exists.');
    poll.forcedTarget = targetId || null;
  } else {
    throw new ApiError(400, 'bad_poll_kind', 'Unknown poll kind.');
  }
  await saveRoom(room);
  return room;
}

async function overridePlayerStatus(code, { hostSecret, playerId, alive, reason }) {
  const room = await loadRoom(code);
  verifyHostSecret(room, hostSecret);
  const p = findPlayer(room, playerId);
  p.alive = !!alive;
  p.eliminatedReason = p.alive ? null : reason || 'host adjustment';
  p.eliminatedRound = p.alive ? null : room.round;
  logEvent(room, `Host set ${p.name} to ${p.alive ? 'alive' : 'eliminated'}.`);
  await saveRoom(room);
  return room;
}

async function endGame(code, { hostSecret }) {
  const room = await loadRoom(code);
  verifyHostSecret(room, hostSecret);
  room.phase = 'ended';
  room.status = 'ended';
  if (room.night) room.night.active = false;
  if (room.vote) room.vote.active = false;
  logEvent(room, 'Game ended.');
  await saveRoom(room);
  return room;
}

async function deleteRoom(code) {
  await store.del(store.roomKey(code));
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function teamCounts(room) {
  const counts = {};
  for (const p of alivePlayers(room)) {
    const role = room.roleAssignments[p.roleId];
    const team = role?.team || 'Unknown';
    counts[team] = (counts[team] || 0) + 1;
  }
  return counts;
}

function winSuggestion(room) {
  if (room.phase === 'lobby' || room.phase === 'reveal') return null;
  const counts = teamCounts(room);
  const wolves = counts['Werewolf'] || 0;
  const others = Object.entries(counts)
    .filter(([team]) => team !== 'Werewolf')
    .reduce((sum, [, n]) => sum + n, 0);
  if (wolves === 0) return 'The village has eliminated every werewolf.';
  if (wolves >= others) return 'The werewolves equal or outnumber the village.';
  return null;
}

function hostView(room) {
  return {
    code: room.code,
    hostSecret: room.hostSecret,
    status: room.status,
    phase: room.phase,
    round: room.round,
    expectedPlayerCount: room.expectedPlayerCount,
    nightDurationSeconds: room.nightDurationSeconds,
    voteDurationSeconds: room.voteDurationSeconds,
    winSuggestion: winSuggestion(room),
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      eliminatedReason: p.eliminatedReason,
      role: p.roleId ? { id: p.roleId, name: room.roleAssignments[p.roleId]?.name, emoji: room.roleAssignments[p.roleId]?.emoji, team: room.roleAssignments[p.roleId]?.team } : null,
    })),
    night: room.night
      ? {
          round: room.night.round,
          active: room.night.active,
          endsAt: room.night.endsAt,
          resolved: room.night.resolved,
          result: room.night.result,
          pendingTies: room.night.pendingTies.map((t) => ({
            pollKey: t.pollKey,
            tiedIds: t.tiedIds,
            tied: t.tiedIds.map((id) => ({ id, name: room.players.find((p) => p.id === id)?.name })),
          })),
          solo: room.night.soloRequirements.map((r) => ({
            actorId: r.actorId,
            actorName: room.players.find((p) => p.id === r.actorId)?.name,
            roleName: r.roleName,
            submitted: !!r.targetId,
            targetName: r.targetId ? room.players.find((p) => p.id === r.targetId)?.name : null,
          })),
          teams: room.night.teamPolls.map((poll) => ({
            team: poll.team,
            submittedCount: Object.keys(poll.ballots).length,
            eligibleCount: poll.eligibleVoterIds.length,
            ballots: Object.entries(poll.ballots).map(([voterId, targetId]) => ({
              voterName: room.players.find((p) => p.id === voterId)?.name,
              targetName: room.players.find((p) => p.id === targetId)?.name,
            })),
          })),
        }
      : null,
    vote: room.vote
      ? {
          round: room.vote.round,
          active: room.vote.active,
          endsAt: room.vote.endsAt,
          resolved: room.vote.resolved,
          result: room.vote.result,
          submittedCount: Object.keys(room.vote.ballots).length,
          eligibleCount: room.vote.eligibleVoterIds.length,
          pendingTie: room.vote.pendingTie
            ? room.vote.pendingTie.map((id) => ({ id, name: room.players.find((p) => p.id === id)?.name }))
            : null,
          ballots: Object.entries(room.vote.ballots).map(([voterId, targetId]) => ({
            voterName: room.players.find((p) => p.id === voterId)?.name,
            targetName: room.players.find((p) => p.id === targetId)?.name,
          })),
        }
      : null,
    log: room.log.slice(-30),
  };
}

function playerView(room, playerId) {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return null;
  const role = player.roleId ? room.roleAssignments[player.roleId] : null;

  let nightPrompt = null;
  if (player.alive && room.night?.active && role && role.action.type !== 'none') {
    const alive = alivePlayers(room).filter((p) => p.id !== player.id || role.action.type === 'solo');
    const candidateIds = candidatesFor(room, player.id, role);
    const candidates = candidateIds.map((id) => ({ id, name: room.players.find((p) => p.id === id)?.name }));
    let yourTarget = null;
    if (role.action.type === 'solo') {
      const req = room.night.soloRequirements.find((r) => r.actorId === player.id);
      yourTarget = req?.targetId || null;
    } else {
      const poll = room.night.teamPolls.find((p) => p.team === role.team);
      yourTarget = poll?.ballots[player.id] || null;
      nightPrompt = {
        kind: 'team',
        endsAt: room.night.endsAt,
        candidates,
        yourTarget,
        teammates: (poll?.eligibleVoterIds || [])
          .filter((id) => id !== player.id)
          .map((id) => room.players.find((p) => p.id === id)?.name),
        liveTally: poll
          ? candidateIds.map((id) => ({
              id,
              name: room.players.find((p) => p.id === id)?.name,
              votes: Object.values(poll.ballots).filter((t) => t === id).length,
            }))
          : [],
      };
    }
    if (!nightPrompt) {
      nightPrompt = { kind: 'solo', endsAt: room.night.endsAt, candidates, yourTarget, effect: role.action.effect };
    }
  }

  let votePrompt = null;
  if (player.alive && room.vote?.active) {
    votePrompt = {
      endsAt: room.vote.endsAt,
      candidates: room.vote.candidateIds
        .filter((id) => id !== player.id)
        .map((id) => ({ id, name: room.players.find((p) => p.id === id)?.name })),
      yourVote: room.vote.ballots[player.id] || null,
    };
  }

  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    you: { id: player.id, name: player.name, alive: player.alive },
    eliminated: !player.alive,
    eliminatedReason: player.eliminatedReason,
    role: role
      ? { name: role.name, emoji: role.emoji, team: role.team, shortText: role.shortText, powerText: role.powerText }
      : null,
    nightPrompt,
    votePrompt,
    phaseEndsAt:
      room.phase === 'night' && room.night?.active
        ? room.night.endsAt
        : room.phase === 'day-vote' && room.vote?.active
          ? room.vote.endsAt
          : null,
    lastNightResult: player.lastNightResult,
    playersAlive: room.players.filter((p) => p.alive).length,
    playersTotal: room.players.length,
    lobby:
      room.phase === 'lobby'
        ? {
            joinedCount: room.players.length,
            expectedPlayerCount: room.expectedPlayerCount,
            names: room.players.map((p) => p.name),
          }
        : null,
  };
}

function lobbyView(room) {
  return {
    code: room.code,
    phase: room.phase,
    expectedPlayerCount: room.expectedPlayerCount,
    joinedCount: room.players.length,
    players: room.players.map((p) => p.name),
  };
}

module.exports = {
  ApiError,
  getRoleLibrary,
  addRole,
  updateRole,
  deleteRole,
  createRoom,
  loadRoom,
  joinRoom,
  startGame,
  beginNight,
  submitNightAction,
  resolveNight,
  startVote,
  submitVote,
  resolveVote,
  breakTie,
  overridePlayerStatus,
  endGame,
  deleteRoom,
  hostView,
  playerView,
  lobbyView,
  verifyHostSecret,
  verifyPlayerToken,
};
