// public/js/host.js
(function () {
  const app = document.getElementById('app');
  const state = {
    code: null,
    secret: null,
    roles: [],
    view: null,
    conn: null,
    connStatus: 'connected',
    joinUrl: null,
    qrDataUrl: null,
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function loadingSkeleton(msg) {
    return `<div class="stack center" style="justify-content:center;min-height:60vh;"><div class="spinner" style="margin:0 auto;"></div><p class="muted">${msg}</p></div>`;
  }

  function connDotHtml() {
    const ok = state.connStatus === 'connected';
    return `<span id="conn-dot" class="mono" style="color:${ok ? 'var(--village)' : 'var(--lantern)'}" title="${ok ? 'Connected' : 'Reconnecting…'}">${ok ? '●' : '○'}</span>`;
  }

  // ==================== Home: role library + room creation ====================

  async function renderHome() {
    app.innerHTML = loadingSkeleton('Loading role library…');
    let roles = [];
    try {
      roles = await WW.api('GET', '/api/host/roles');
    } catch (err) {
      WW.toast(err.message);
    }
    state.roles = roles;
    app.innerHTML = homeTemplate(roles);
    wireHome();
  }

  function homeTemplate(roles) {
    const lastRoom = WW.storage.loadHostRoom();
    return `
      <div class="stack">
        <div class="center">
          <div class="role-emoji">🏮</div>
          <h1>Werewolf — Host</h1>
          <p class="muted">Manage your role library, then start tonight's room.</p>
        </div>
        ${lastRoom ? `
        <div class="card tight row between">
          <span class="muted">Resume room <span class="mono">${escapeHtml(lastRoom.code)}</span>?</span>
          <button class="btn-ghost btn-sm" id="resume-btn">Open</button>
        </div>` : ''}

        <div class="card raised stack">
          <div class="row between"><h2>Role library</h2><button class="btn-ghost btn-sm" id="add-role-btn">+ Add role</button></div>
          <p class="muted" style="margin:0;font-size:0.85rem;">Shared across every host. Changes here apply to future rooms.</p>
          <div id="role-list" class="stack">${roles.map(roleRow).join('')}</div>
          <div id="role-form-slot"></div>
        </div>

        <div class="card raised stack">
          <h2>Start a new game</h2>
          <div id="loadout-list" class="stack">${roles.map(loadoutRow).join('')}</div>
          <div class="row between" style="margin-top:4px;">
            <span class="muted">Total players</span>
            <span class="mono" id="total-count">0</span>
          </div>
          <hr class="divider" />
          <div class="row wrap" style="gap:16px;">
            <div class="grow">
              <label for="night-secs">Night length (seconds)</label>
              <input type="number" id="night-secs" min="15" value="60" />
            </div>
            <div class="grow">
              <label for="vote-secs">Vote length (seconds)</label>
              <input type="number" id="vote-secs" min="15" value="90" />
            </div>
          </div>
          <button class="btn-primary btn-block" id="create-room-btn">Create room</button>
        </div>
      </div>`;
  }

  function roleRow(role) {
    return `
      <div class="card tight row between">
        <div class="row" style="gap:10px;">
          <span style="font-size:1.4rem;">${role.emoji}</span>
          <div>
            <div style="font-weight:600;">${escapeHtml(role.name)} <span class="muted" style="font-weight:400;font-size:0.8rem;">· ${escapeHtml(role.team)}</span></div>
            <div class="muted" style="font-size:0.8rem;">${escapeHtml(role.shortText || '')}</div>
          </div>
        </div>
        <div class="row" style="gap:6px;">
          <button class="btn-ghost btn-sm" data-edit-role="${role.id}">Edit</button>
          ${role.builtIn ? '' : `<button class="btn-danger btn-sm" data-delete-role="${role.id}">Delete</button>`}
        </div>
      </div>`;
  }

  function loadoutRow(role) {
    return `
      <div class="row between">
        <span>${role.emoji} ${escapeHtml(role.name)}</span>
        <input type="number" min="0" value="0" class="loadout-count" data-role-id="${role.id}" style="width:80px;text-align:center;" />
      </div>`;
  }

  function roleFormTemplate(existing) {
    const r = existing || { name: '', emoji: '🃏', team: 'Village', shortText: '', powerText: '', action: { type: 'none', effect: 'none' } };
    return `
      <div class="card tight stack" id="role-form" style="border-color:var(--lantern);">
        <h3>${existing ? 'Edit role' : 'New role'}</h3>
        <div class="row" style="gap:10px;">
          <div style="width:70px;">
            <label>Emoji</label>
            <input type="text" id="rf-emoji" maxlength="4" value="${escapeHtml(r.emoji)}" />
          </div>
          <div class="grow">
            <label>Name</label>
            <input type="text" id="rf-name" value="${escapeHtml(r.name)}" placeholder="e.g. Cult Leader" />
          </div>
        </div>
        <div>
          <label>Team</label>
          <input type="text" id="rf-team" value="${escapeHtml(r.team)}" placeholder="Village / Werewolf / your own" />
        </div>
        <div>
          <label>Shown to the player (one line)</label>
          <input type="text" id="rf-short" value="${escapeHtml(r.shortText)}" placeholder="Each night, do X." />
        </div>
        <div>
          <label>Full power text</label>
          <textarea id="rf-power" rows="3" placeholder="Explain exactly what they can do.">${escapeHtml(r.powerText)}</textarea>
        </div>
        <div class="row wrap" style="gap:16px;">
          <div class="grow">
            <label>Night action</label>
            <select id="rf-type">
              <option value="none" ${r.action.type === 'none' ? 'selected' : ''}>None — informational only</option>
              <option value="solo" ${r.action.type === 'solo' ? 'selected' : ''}>Solo — this player alone picks a target</option>
              <option value="team" ${r.action.type === 'team' ? 'selected' : ''}>Team — everyone on this team picks together</option>
            </select>
          </div>
          <div class="grow" id="rf-effect-wrap" style="${r.action.type === 'none' ? 'display:none;' : ''}">
            <label>Effect</label>
            <select id="rf-effect">
              <option value="kill" ${r.action.effect === 'kill' ? 'selected' : ''}>Kill</option>
              <option value="protect" ${r.action.effect === 'protect' ? 'selected' : ''}>Protect</option>
              <option value="inspect" ${r.action.effect === 'inspect' ? 'selected' : ''}>Inspect (private result)</option>
            </select>
          </div>
        </div>
        <div class="row" style="gap:10px;">
          <button class="btn-primary grow" id="rf-save">${existing ? 'Save changes' : 'Add role'}</button>
          <button class="btn-ghost" id="rf-cancel">Cancel</button>
        </div>
      </div>`;
  }

  function wireHome() {
    updateTotal();
    document.querySelectorAll('.loadout-count').forEach((inp) => inp.addEventListener('input', updateTotal));
    document.getElementById('add-role-btn').addEventListener('click', () => showRoleForm(null));
    document.querySelectorAll('[data-edit-role]').forEach((btn) => {
      btn.addEventListener('click', () => showRoleForm(state.roles.find((r) => r.id === btn.dataset.editRole)));
    });
    document.querySelectorAll('[data-delete-role]').forEach((btn) => {
      btn.addEventListener('click', () => deleteRole(btn.dataset.deleteRole));
    });
    document.getElementById('create-room-btn').addEventListener('click', createRoom);
    const resumeBtn = document.getElementById('resume-btn');
    if (resumeBtn) {
      resumeBtn.addEventListener('click', () => {
        const last = WW.storage.loadHostRoom();
        if (last) loadDashboard(last.code, last.secret);
      });
    }
  }

  function updateTotal() {
    let total = 0;
    document.querySelectorAll('.loadout-count').forEach((inp) => { total += parseInt(inp.value, 10) || 0; });
    const totalEl = document.getElementById('total-count');
    if (totalEl) totalEl.textContent = String(total);
  }

  function showRoleForm(role) {
    const slot = document.getElementById('role-form-slot');
    slot.innerHTML = roleFormTemplate(role);
    document.getElementById('rf-type').addEventListener('change', (e) => {
      document.getElementById('rf-effect-wrap').style.display = e.target.value === 'none' ? 'none' : '';
    });
    document.getElementById('rf-cancel').addEventListener('click', () => { slot.innerHTML = ''; });
    document.getElementById('rf-save').addEventListener('click', () => saveRoleForm(role));
  }

  async function saveRoleForm(existing) {
    const type = document.getElementById('rf-type').value;
    const effect = type === 'none' ? 'none' : document.getElementById('rf-effect').value;
    const orderDefaults = { protect: 5, kill: 10, inspect: 20, none: 0 };
    const payload = {
      name: document.getElementById('rf-name').value,
      emoji: document.getElementById('rf-emoji').value,
      team: document.getElementById('rf-team').value,
      shortText: document.getElementById('rf-short').value,
      powerText: document.getElementById('rf-power').value,
      action: { type, effect, order: orderDefaults[effect] },
    };
    try {
      if (existing) await WW.api('PUT', `/api/host/roles/${existing.id}`, payload);
      else await WW.api('POST', '/api/host/roles', payload);
      WW.toast('Saved.');
      renderHome();
    } catch (err) {
      WW.toast(err.message);
    }
  }

  async function deleteRole(id) {
    // eslint-disable-next-line no-alert
    if (!confirm('Delete this role from the shared library?')) return;
    try {
      await WW.api('DELETE', `/api/host/roles/${id}`);
      renderHome();
    } catch (err) {
      WW.toast(err.message);
    }
  }

  async function createRoom() {
    const loadout = state.roles
      .map((r) => {
        const inp = document.querySelector(`.loadout-count[data-role-id="${r.id}"]`);
        return { roleId: r.id, count: parseInt(inp && inp.value, 10) || 0 };
      })
      .filter((e) => e.count > 0);
    if (loadout.length === 0) { WW.toast('Pick at least one role.'); return; }
    const nightDurationSeconds = parseInt(document.getElementById('night-secs').value, 10) || 60;
    const voteDurationSeconds = parseInt(document.getElementById('vote-secs').value, 10) || 90;
    const btn = document.getElementById('create-room-btn');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const data = await WW.api('POST', '/api/host/rooms', { loadout, nightDurationSeconds, voteDurationSeconds });
      state.code = data.code;
      state.secret = data.hostSecret;
      state.joinUrl = data.joinUrl;
      state.qrDataUrl = data.qrDataUrl;
      WW.storage.saveHostRoom(data.code, data.hostSecret);
      history.replaceState(null, '', `?room=${data.code}&secret=${data.hostSecret}`);
      renderDashboard(data);
      connectHostStream();
    } catch (err) {
      WW.toast(err.message);
      btn.disabled = false;
      btn.textContent = 'Create room';
    }
  }

  // ==================== Dashboard ====================

  async function loadDashboard(code, secret) {
    app.innerHTML = loadingSkeleton('Loading room…');
    try {
      const data = await WW.api('GET', `/api/host/rooms/${code}?hostSecret=${secret}`);
      state.code = code;
      state.secret = secret;
      state.joinUrl = data.joinUrl;
      state.qrDataUrl = data.qrDataUrl;
      WW.storage.saveHostRoom(code, secret);
      renderDashboard(data);
      connectHostStream();
    } catch (err) {
      WW.toast('Could not open that room — it may have expired.');
      history.replaceState(null, '', location.pathname);
      renderHome();
    }
  }

  function connectHostStream() {
    if (state.conn) state.conn.close();
    const url = `/api/host/rooms/${state.code}/stream?hostSecret=${state.secret}`;
    state.conn = WW.connectSSE(url, {
      onMessage: (view) => {
        renderDashboard(view);
        if (view.phase === 'ended') state.conn.close();
      },
      onStatus: (status) => {
        state.connStatus = status;
        const dot = document.getElementById('conn-dot');
        if (dot) {
          const ok = status === 'connected';
          dot.style.color = ok ? 'var(--village)' : 'var(--lantern)';
          dot.textContent = ok ? '●' : '○';
        }
      },
    });
  }

  function renderDashboard(view) {
    state.view = view;
    app.innerHTML = `
      <div class="row between" style="margin-bottom:16px;">
        <div class="row" style="gap:10px;">
          <span class="eyebrow">Room</span>
          <span class="mono" style="font-size:1.3rem;">${view.code}</span>
        </div>
        <div class="row" style="gap:10px;">
          ${connDotHtml()}
          <button class="btn-ghost btn-sm" id="new-room-btn">New room</button>
        </div>
      </div>
      ${view.winSuggestion ? `<div class="card tight" style="border-color:var(--bloodmoon); margin-bottom:14px;"><p style="margin:0;color:var(--bloodmoon);">${escapeHtml(view.winSuggestion)}</p></div>` : ''}
      <div class="host-grid-layout">
        <div class="stack">
          ${qrCard()}
          ${phaseControls(view)}
        </div>
        <div class="stack">
          ${playerGridCard(view)}
          ${logCard(view)}
        </div>
      </div>`;
    wireDashboard(view);
  }

  function qrCard() {
    return `
      <div class="card raised center stack">
        <div class="eyebrow">Players join at</div>
        <div class="qr-wrap"><img src="${state.qrDataUrl}" alt="QR code to join" /></div>
        <p class="mono" style="font-size:0.82rem;word-break:break-all;">${state.joinUrl}</p>
        <button class="btn-ghost btn-sm" id="copy-link-btn">Copy link</button>
      </div>`;
  }

  function logCard(view) {
    if (!view.log || view.log.length === 0) return '';
    const items = view.log.slice().reverse().slice(0, 12)
      .map((e) => `<div class="muted" style="font-size:0.8rem;">${escapeHtml(e.message)}</div>`)
      .join('');
    return `<div class="card tight stack"><div class="eyebrow">Log</div>${items}</div>`;
  }

  function playerGridCard(view) {
    const cards = view.players
      .map((p) => `
      <div class="player-card ${p.alive ? '' : 'dead'}">
        <div class="row between">
          <span class="name">${escapeHtml(p.name)}</span>
          <button class="btn-ghost btn-sm" data-toggle="${p.id}" data-alive="${p.alive}" title="Toggle alive/dead">${p.alive ? '💀' : '💚'}</button>
        </div>
        <div class="role">${p.role ? `${p.role.emoji} ${escapeHtml(p.role.name)}` : '—'}</div>
      </div>`)
      .join('');
    return `
      <div class="card raised stack">
        <div class="row between"><h3>Players</h3><span class="mono muted">${view.players.filter((p) => p.alive).length} alive / ${view.players.length}</span></div>
        <div class="player-grid">${cards || '<p class="muted">No one has joined yet.</p>'}</div>
      </div>`;
  }

  function phaseControls(view) {
    switch (view.phase) {
      case 'lobby': {
        const mismatch = view.players.length !== view.expectedPlayerCount;
        return `
          <div class="card raised stack">
            <div class="row between"><h3>Lobby</h3><span class="mono">${view.players.length} / ${view.expectedPlayerCount}</span></div>
            ${mismatch ? '<p class="muted" style="font-size:0.85rem;">Player count doesn\u2019t match the loadout.</p>' : ''}
            <button class="btn-primary btn-block" id="start-game-btn" ${view.players.length === 0 ? 'disabled' : ''}>${mismatch ? 'Start anyway' : 'Reveal roles & start'}</button>
          </div>`;
      }
      case 'reveal':
        return `
          <div class="card raised stack">
            <h3>Roles revealed</h3>
            <p class="muted">Players are looking at their roles now.</p>
            <button class="btn-primary btn-block" id="begin-night-btn">Begin Night 1</button>
          </div>`;
      case 'night':
        return nightControls(view);
      case 'day-vote':
        return voteControls(view);
      case 'ended':
        return `<div class="card raised center stack"><h3>Game ended</h3><p class="muted">Start a new room from the home screen for another round.</p></div>`;
      default:
        return '';
    }
  }

  function nightControls(view) {
    const n = view.night;
    if (!n) return '';
    if (n.resolved && !n.active) {
      const killedNames = ((n.result && n.result.killedIds) || [])
        .map((id) => (view.players.find((p) => p.id === id) || {}).name)
        .filter(Boolean);
      return `
        <div class="card raised stack">
          <h3>Night ${n.round} result</h3>
          <p class="muted">${killedNames.length ? `${escapeHtml(killedNames.join(', '))} eliminated.` : 'No one was eliminated.'}</p>
          <button class="btn-primary btn-block" id="start-vote-btn">Start Day Vote</button>
          <button class="btn-danger btn-block" id="end-game-btn">End game</button>
        </div>`;
    }

    const soloRows = n.solo
      .map((r) => `
      <div class="row between">
        <span>${escapeHtml(r.actorName)} <span class="muted">(${escapeHtml(r.roleName)})</span></span>
        <span class="muted">${r.submitted ? `→ ${escapeHtml(r.targetName)}` : 'waiting…'}</span>
      </div>`)
      .join('');

    const teamRows = n.teams
      .map((t) => `
      <div class="stack" style="gap:4px;">
        <div class="row between"><span style="font-weight:600;">${escapeHtml(t.team)}</span><span class="mono muted">${t.submittedCount}/${t.eligibleCount}</span></div>
        ${t.ballots.map((b) => `<div class="muted" style="font-size:0.85rem;">${escapeHtml(b.voterName)} → ${escapeHtml(b.targetName)}</div>`).join('') || '<div class="muted" style="font-size:0.85rem;">No votes yet</div>'}
      </div>`)
      .join('<hr class="divider"/>');

    const tieUi = (n.pendingTies && n.pendingTies.length > 0)
      ? n.pendingTies
          .map((t) => `
      <div class="card tight stack" style="border-color:var(--lantern);">
        <div class="eyebrow" style="color:var(--lantern);">Tie — ${escapeHtml(t.pollKey)} pick</div>
        <div class="row wrap" style="gap:6px;">
          ${t.tied.map((c) => `<button class="btn-ghost btn-sm" data-break-night="${escapeHtml(t.pollKey)}" data-target="${c.id}">${escapeHtml(c.name)}</button>`).join('')}
          <button class="btn-ghost btn-sm" data-break-night="${escapeHtml(t.pollKey)}" data-target="">No kill</button>
        </div>
      </div>`)
          .join('')
      : '';

    return `
      <div class="card raised stack">
        <div class="row between"><h3>Night ${n.round}</h3><span class="countdown" id="countdown"></span></div>
        ${soloRows ? `<div class="stack" style="gap:4px;">${soloRows}</div>` : ''}
        ${n.teams.length ? `<hr class="divider"/><div class="stack">${teamRows}</div>` : ''}
        ${tieUi}
        <button class="btn-primary btn-block" id="resolve-night-btn">Resolve Night Now</button>
      </div>`;
  }

  function voteControls(view) {
    const v = view.vote;
    if (!v) return '';
    if (v.resolved && !v.active) {
      let text = 'No one was eliminated.';
      if (v.result && v.result.outcome === 'eliminated') {
        const name = (view.players.find((p) => p.id === v.result.targetId) || {}).name;
        text = `${name} was voted out.`;
      }
      return `
        <div class="card raised stack">
          <h3>Vote result</h3>
          <p class="muted">${escapeHtml(text)}</p>
          <button class="btn-primary btn-block" id="begin-night-btn">Begin Night ${view.round + 1}</button>
          <button class="btn-danger btn-block" id="end-game-btn">End game</button>
        </div>`;
    }

    const ballotRows = v.ballots.map((b) => `<div class="muted" style="font-size:0.85rem;">${escapeHtml(b.voterName)} → ${escapeHtml(b.targetName)}</div>`).join('')
      || '<div class="muted" style="font-size:0.85rem;">No votes yet</div>';

    const tieUi = v.pendingTie
      ? `
      <div class="card tight stack" style="border-color:var(--lantern);">
        <div class="eyebrow" style="color:var(--lantern);">Tie vote</div>
        <div class="row wrap" style="gap:6px;">
          ${v.pendingTie.map((c) => `<button class="btn-ghost btn-sm" data-break-vote="${c.id}">${escapeHtml(c.name)}</button>`).join('')}
          <button class="btn-ghost btn-sm" data-break-vote="">No elimination</button>
        </div>
      </div>`
      : '';

    return `
      <div class="card raised stack">
        <div class="row between"><h3>Day Vote</h3><span class="countdown" id="countdown"></span></div>
        <div class="row between"><span class="muted">Votes</span><span class="mono">${v.submittedCount}/${v.eligibleCount}</span></div>
        <div class="stack" style="gap:4px;">${ballotRows}</div>
        ${tieUi}
        <button class="btn-primary btn-block" id="resolve-vote-btn">Resolve Vote Now</button>
      </div>`;
  }

  function wireDashboard(view) {
    const countdownEl = document.getElementById('countdown');
    if (countdownEl) {
      const endsAt = view.phase === 'night' ? view.night && view.night.endsAt : view.phase === 'day-vote' ? view.vote && view.vote.endsAt : null;
      if (endsAt) WW.bindCountdown(countdownEl, endsAt, () => {});
    }

    const copyBtn = document.getElementById('copy-link-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        if (navigator.clipboard) navigator.clipboard.writeText(state.joinUrl).then(() => WW.toast('Link copied.'));
      });
    }

    const newRoomBtn = document.getElementById('new-room-btn');
    if (newRoomBtn) {
      newRoomBtn.addEventListener('click', () => {
        // eslint-disable-next-line no-alert
        if (!confirm('Leave this room and start a new one?')) return;
        if (state.conn) state.conn.close();
        history.replaceState(null, '', location.pathname);
        renderHome();
      });
    }

    const startBtn = document.getElementById('start-game-btn');
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        const mismatch = view.players.length !== view.expectedPlayerCount;
        hostAction('/start', { force: mismatch }).catch((e) => WW.toast(e.message));
      });
    }

    const beginNightBtn = document.getElementById('begin-night-btn');
    if (beginNightBtn) beginNightBtn.addEventListener('click', () => hostAction('/night/begin', {}).catch((e) => WW.toast(e.message)));

    const resolveNightBtn = document.getElementById('resolve-night-btn');
    if (resolveNightBtn) resolveNightBtn.addEventListener('click', () => hostAction('/night/resolve', {}).catch((e) => WW.toast(e.message)));

    const startVoteBtn = document.getElementById('start-vote-btn');
    if (startVoteBtn) startVoteBtn.addEventListener('click', () => hostAction('/vote/start', {}).catch((e) => WW.toast(e.message)));

    const resolveVoteBtn = document.getElementById('resolve-vote-btn');
    if (resolveVoteBtn) resolveVoteBtn.addEventListener('click', () => hostAction('/vote/resolve', {}).catch((e) => WW.toast(e.message)));

    const endGameBtn = document.getElementById('end-game-btn');
    if (endGameBtn) {
      endGameBtn.addEventListener('click', () => {
        // eslint-disable-next-line no-alert
        if (!confirm('End the game for everyone?')) return;
        hostAction('/end', {}).catch((e) => WW.toast(e.message));
      });
    }

    document.querySelectorAll('[data-break-night]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await hostAction('/night/break-tie', { pollKey: btn.dataset.breakNight, targetId: btn.dataset.target || null });
          await hostAction('/night/resolve', {});
        } catch (err) {
          WW.toast(err.message);
        }
      });
    });

    document.querySelectorAll('[data-break-vote]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await hostAction('/vote/break-tie', { targetId: btn.dataset.breakVote || null });
          await hostAction('/vote/resolve', {});
        } catch (err) {
          WW.toast(err.message);
        }
      });
    });

    document.querySelectorAll('[data-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const alive = btn.dataset.alive === 'true';
        hostAction('/override', { playerId: btn.dataset.toggle, alive: !alive, reason: 'host adjustment' }).catch((e) => WW.toast(e.message));
      });
    });
  }

  async function hostAction(suffix, body) {
    const data = await WW.api('POST', `/api/host/rooms/${state.code}${suffix}`, { hostSecret: state.secret, ...body });
    renderDashboard(data);
    return data;
  }

  // ==================== Boot ====================

  function init() {
    const code = (WW.qs('room') || '').toUpperCase();
    const secret = WW.qs('secret') || '';
    if (code && secret) loadDashboard(code, secret);
    else renderHome();
  }

  init();
})();
