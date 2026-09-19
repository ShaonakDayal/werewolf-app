// Quick end-to-end smoke test against a running local server.
// Not a unit test suite -- just walks one full game to catch integration bugs.
const BASE = 'http://localhost:3000';

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  console.log('  ok:', msg);
}

async function main() {
  console.log('--- role library ---');
  const roles = await api('GET', '/api/host/roles');
  assert(roles.length === 4, 'seed library has 4 roles');
  const byName = Object.fromEntries(roles.map((r) => [r.name, r]));

  console.log('--- create room (2 werewolf, 1 seer, 1 doctor, 3 villager = 7) ---');
  const loadout = [
    { roleId: byName.Werewolf.id, count: 2 },
    { roleId: byName.Seer.id, count: 1 },
    { roleId: byName.Doctor.id, count: 1 },
    { roleId: byName.Villager.id, count: 3 },
  ];
  const room = await api('POST', '/api/host/rooms', { loadout, nightDurationSeconds: 30, voteDurationSeconds: 30 });
  assert(room.code && room.code.length >= 4, `room created: ${room.code}`);
  assert(room.hostSecret, 'host secret issued');
  assert(typeof room.qrDataUrl === 'string' && room.qrDataUrl.startsWith('data:image'), 'QR code generated');
  const code = room.code;
  const secret = room.hostSecret;

  console.log('--- join 7 players ---');
  const names = ['Alice', 'Bob', 'Cara', 'Dee', 'Eli', 'Fay', 'Gus'];
  const players = [];
  for (const name of names) {
    const p = await api('POST', `/api/player/rooms/${code}/join`, { name });
    players.push({ name, id: p.playerId, token: p.token });
  }
  assert(players.length === 7, 'all 7 joined');

  const lobby = await api('GET', `/api/player/rooms/${code}`);
  assert(lobby.joinedCount === 7, 'lobby shows 7 joined');

  console.log('--- start game (assign roles) ---');
  const started = await api('POST', `/api/host/rooms/${code}/start`, { hostSecret: secret });
  assert(started.phase === 'reveal', 'phase is now reveal');
  const roleByPlayer = {};
  for (const p of started.players) roleByPlayer[p.id] = p.role.name;
  const wolves = players.filter((p) => roleByPlayer[p.id] === 'Werewolf');
  const seer = players.find((p) => roleByPlayer[p.id] === 'Seer');
  const doctor = players.find((p) => roleByPlayer[p.id] === 'Doctor');
  const villagers = players.filter((p) => roleByPlayer[p.id] === 'Villager');
  assert(wolves.length === 2, `2 werewolves assigned (${wolves.map((w) => w.name)})`);
  assert(!!seer, `seer assigned (${seer.name})`);
  assert(!!doctor, `doctor assigned (${doctor.name})`);
  assert(villagers.length === 3, '3 villagers assigned');

  // spot-check a player's own view only shows their own role
  const seerView = await api('GET', `/api/player/rooms/${code}/me?playerId=${seer.id}&token=${seer.token}`);
  assert(seerView.role.name === 'Seer', "seer's own view shows Seer role");
  assert(!('players' in seerView), "player view doesn't leak the full player/role list");

  console.log('--- night 1: doctor protects a villager, wolves target that same villager (should survive), seer inspects a wolf ---');
  const target = villagers[0];
  await api('POST', `/api/host/rooms/${code}/night/begin`, { hostSecret: secret });
  await api('POST', `/api/player/rooms/${code}/night-action`, { playerId: doctor.id, token: doctor.token, targetId: target.id });
  await api('POST', `/api/player/rooms/${code}/night-action`, { playerId: wolves[0].id, token: wolves[0].token, targetId: target.id });
  await api('POST', `/api/player/rooms/${code}/night-action`, { playerId: wolves[1].id, token: wolves[1].token, targetId: target.id });
  await api('POST', `/api/player/rooms/${code}/night-action`, { playerId: seer.id, token: seer.token, targetId: wolves[0].id });

  const resolved1 = await api('POST', `/api/host/rooms/${code}/night/resolve`, { hostSecret: secret });
  assert(resolved1.needsTieBreak === false, 'night 1 resolved without a tie');
  const targetStatus = resolved1.players.find((p) => p.id === target.id);
  assert(targetStatus.alive === true, 'protected villager survived the wolves');

  const seerAfter = await api('GET', `/api/player/rooms/${code}/me?playerId=${seer.id}&token=${seer.token}`);
  assert(!!seerAfter.lastNightResult && seerAfter.lastNightResult.text.includes('Werewolf'), `seer learned the truth: "${seerAfter.lastNightResult.text}"`);

  console.log('--- day vote: force a tie between two villagers, then break it ---');
  await api('POST', `/api/host/rooms/${code}/vote/start`, { hostSecret: secret });
  const v1 = villagers[1];
  const v2 = villagers[2];
  // 2 votes each -> guaranteed tie among alive voters
  const alivePlayers = players.filter((p) => p.id !== undefined && resolved1.players.find((x) => x.id === p.id)?.alive);
  await api('POST', `/api/player/rooms/${code}/vote`, { playerId: wolves[0].id, token: wolves[0].token, targetId: v1.id });
  await api('POST', `/api/player/rooms/${code}/vote`, { playerId: wolves[1].id, token: wolves[1].token, targetId: v1.id });
  await api('POST', `/api/player/rooms/${code}/vote`, { playerId: seer.id, token: seer.token, targetId: v2.id });
  await api('POST', `/api/player/rooms/${code}/vote`, { playerId: doctor.id, token: doctor.token, targetId: v2.id });

  const voteResolveAttempt = await api('POST', `/api/host/rooms/${code}/vote/resolve`, { hostSecret: secret });
  assert(voteResolveAttempt.needsTieBreak === true, 'tie correctly detected');
  assert(voteResolveAttempt.tiedIds.length === 2, 'exactly 2 players tied');

  await api('POST', `/api/host/rooms/${code}/vote/break-tie`, { hostSecret: secret, targetId: v1.id });
  const voteResolved = await api('POST', `/api/host/rooms/${code}/vote/resolve`, { hostSecret: secret });
  assert(voteResolved.vote.result.outcome === 'eliminated', 'tie-break resolved the vote');
  assert(voteResolved.vote.result.targetId === v1.id, 'the host-chosen player was eliminated');

  console.log('--- eliminated player sees a death screen, not game info ---');
  const v1View = await api('GET', `/api/player/rooms/${code}/me?playerId=${v1.id}&token=${v1.token}`);
  assert(v1View.eliminated === true, 'eliminated flag set');
  assert(v1View.eliminatedReason === 'voted-out', 'reason recorded as voted-out');

  console.log('--- host manual override (undo a mistaken kill) ---');
  const overridden = await api('POST', `/api/host/rooms/${code}/override`, { hostSecret: secret, playerId: v1.id, alive: true });
  assert(overridden.players.find((p) => p.id === v1.id).alive === true, 'host override revived the player');

  console.log('--- end game ---');
  const ended = await api('POST', `/api/host/rooms/${code}/end`, { hostSecret: secret });
  assert(ended.phase === 'ended', 'game ended cleanly');

  console.log('\nALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
