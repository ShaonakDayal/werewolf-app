// public/js/player.js
(function () {
  const app = document.getElementById('app');
  const state = { code: null, playerId: null, token: null, conn: null, connStatus: 'connected' };

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function connDot() {
    const ok = state.connStatus === 'connected';
    return `<span id="conn-dot" class="mono" style="color:${ok ? 'var(--village)' : 'var(--lantern)'}" title="${ok ? 'Connected' : 'Reconnecting…'}">${ok ? '●' : '○'}</span>`;
  }

  function header(view) {
    const badge = view.you.alive
      ? '<span class="badge alive">Alive</span>'
      : '<span class="badge dead">Eliminated</span>';
    return `
      <div class="row between" style="margin-bottom:16px;">
        <span class="mono muted">${view.code}</span>
        <div class="row" style="gap:8px;">${badge}${connDot()}</div>
      </div>`;
  }

  function intelCard(view) {
    if (!view.lastNightResult) return '';
    return `
      <div class="card tight" style="border-color:var(--lantern); margin-bottom:14px;">
        <div class="eyebrow" style="color:var(--lantern);">Your intel</div>
        <p style="margin:4px 0 0;">${escapeHtml(view.lastNightResult.text)}</p>
      </div>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------- Join flow ----------------

  function renderJoin(prefilledCode, errorMsg) {
    app.innerHTML = `
      <div class="stack" style="justify-content:center; min-height:80vh;">
        <div class="center" style="margin-bottom:8px;">
          <div class="role-emoji">🌙</div>
          <h1>Werewolf</h1>
          <p class="muted">Enter the room code from your host and your name to join.</p>
        </div>
        <div class="card raised stack">
          ${errorMsg ? `<p style="color:var(--bloodmoon); margin:0;">${escapeHtml(errorMsg)}</p>` : ''}
          <div>
            <label for="code">Room code</label>
            <input id="code" type="text" maxlength="6" autocapitalize="characters" autocomplete="off" placeholder="FOX2" value="${prefilledCode || ''}" />
          </div>
          <div>
            <label for="name">Your name</label>
            <input id="name" type="text" maxlength="24" autocomplete="off" placeholder="e.g. Jamie" />
          </div>
          <button class="btn-primary btn-block" id="join-btn">Join game</button>
        </div>
      </div>`;
    const codeInput = document.getElementById('code');
    const nameInput = document.getElementById('name');
    if (prefilledCode) nameInput.focus();
    else codeInput.focus();
    document.getElementById('join-btn').addEventListener('click', () => doJoin(codeInput.value, nameInput.value));
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(codeInput.value, nameInput.value); });
  }

  async function doJoin(code, name) {
    code = (code || '').trim().toUpperCase();
    name = (name || '').trim();
    if (!code || !name) { WW.toast('Enter your name and the room code.'); return; }
    const btn = document.getElementById('join-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Joining…'; }
    try {
      const res = await WW.api('POST', `/api/player/rooms/${code}/join`, { name });
      state.code = code;
      state.playerId = res.playerId;
      state.token = res.token;
      WW.storage.savePlayer(code, { playerId: res.playerId, token: res.token });
      history.replaceState(null, '', `?room=${code}`);
      render(res);
      connectStream();
    } catch (err) {
      renderJoin(code, err.message);
    }
  }

  // ---------------- Stream ----------------

  function connectStream() {
    if (state.conn) state.conn.close();
    const url = `/api/player/rooms/${state.code}/stream?playerId=${state.playerId}&token=${state.token}`;
    state.conn = WW.connectSSE(url, {
      onMessage: (view) => {
        render(view);
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

  async function resumeSession(code, saved) {
    try {
      const view = await WW.api('GET', `/api/player/rooms/${code}/me?playerId=${saved.playerId}&token=${saved.token}`);
      state.code = code;
      state.playerId = saved.playerId;
      state.token = saved.token;
      render(view);
      connectStream();
    } catch {
      renderJoin(code, 'That session ended — join again.');
    }
  }

  // ---------------- Screens ----------------

  function render(view) {
    if (view.eliminated) return renderDead(view);
    switch (view.phase) {
      case 'lobby': return renderLobby(view);
      case 'reveal': return renderReveal(view);
      case 'night': return renderNight(view);
      case 'day-vote': return renderVote(view);
      case 'ended': return renderEnded(view);
      default: return renderGeneric(view, 'Hold tight…', 'The host is setting things up.');
    }
  }

  function renderGeneric(view, title, sub) {
    app.innerHTML = `
      <div>${header(view)}</div>
      <div class="stack" style="justify-content:center; flex:1;">
        ${intelCard(view)}
        <div class="card raised center stack">
          <div class="spinner" style="margin:0 auto;"></div>
          <h2>${title}</h2>
          <p class="muted">${sub}</p>
        </div>
      </div>`;
  }

  function renderLobby(view) {
    const lobby = view.lobby || { joinedCount: view.playersTotal, expectedPlayerCount: view.playersTotal, names: [] };
    app.innerHTML = `
      <div>${header(view)}</div>
      <div class="stack" style="justify-content:center; flex:1;">
        <div class="card raised center stack">
          <div class="spinner" style="margin:0 auto;"></div>
          <h2>You're in, ${escapeHtml(view.you.name)}</h2>
          <p class="muted">Waiting for the host to start the game…</p>
          <p class="mono" style="font-size:1.1rem;">${lobby.joinedCount} / ${lobby.expectedPlayerCount} joined</p>
        </div>
        <div class="card tight">
          <div class="eyebrow" style="margin-bottom:8px;">In this room</div>
          <p class="muted" style="margin:0;">${lobby.names.map(escapeHtml).join(' · ') || '…'}</p>
        </div>
      </div>`;
  }

  function renderReveal(view) {
    const r = view.role;
    app.innerHTML = `
      <div>${header(view)}</div>
      <div class="stack" style="justify-content:center; flex:1;">
        ${intelCard(view)}
        <div class="lantern-reveal" id="reveal-box">
          <div class="glow"></div>
          <div class="hint stack center">
            <div class="lantern-icon">🏮</div>
            <p class="muted" style="margin:0;">Tap to reveal your role</p>
          </div>
          <div class="content stack center">
            <div class="role-emoji">${r.emoji}</div>
            <div class="role-name">${escapeHtml(r.name)}</div>
            <div class="role-team">${escapeHtml(r.team)}</div>
          </div>
        </div>
        <div class="card tight" id="power-card" style="display:none;">
          <p style="margin:0;">${escapeHtml(r.powerText)}</p>
        </div>
        <p class="muted center" style="font-size:0.85rem;">Keep this screen to yourself. Waiting for the host to begin the first night…</p>
      </div>`;
    const box = document.getElementById('reveal-box');
    box.addEventListener('click', () => {
      const revealed = box.classList.toggle('revealed');
      document.getElementById('power-card').style.display = revealed ? 'block' : 'none';
    });
  }

  function nightRoleReminderText(view) {
    return view.role ? `You are the ${view.role.name}.` : '';
  }

  function renderNight(view) {
    const prompt = view.nightPrompt;
    if (!prompt) {
      app.innerHTML = `
        <div>${header(view)}</div>
        <div class="stack" style="justify-content:center; flex:1;">
          ${intelCard(view)}
          <div class="card raised center stack">
            <div class="signature" style="font-size:1.3rem;">Night ${view.round}</div>
            ${view.phaseEndsAt ? '<span class="countdown" id="countdown"></span>' : ''}
            <p class="muted">The village sleeps. ${escapeHtml(nightRoleReminderText(view))}</p>
            <p class="muted" style="font-size:0.85rem;">Sit tight — nothing for you to do this round.</p>
          </div>
        </div>`;
      if (view.phaseEndsAt) WW.bindCountdown(document.getElementById('countdown'), view.phaseEndsAt, () => {});
      return;
    }

    const actionLabel = { protect: 'Choose someone to protect', inspect: 'Choose someone to inspect', kill: 'Choose your target' }[
      prompt.effect || 'kill'
    ] || 'Choose your target';

    const rows = prompt.candidates
      .map((c) => {
        const selected = c.id === prompt.yourTarget;
        const tally = prompt.kind === 'team' ? (prompt.liveTally || []).find((t) => t.id === c.id) : null;
        return `
        <button class="target-btn ${selected ? 'selected' : ''}" data-id="${c.id}">
          <span>${escapeHtml(c.name)}</span>
          <span class="row" style="gap:8px;">
            ${tally ? `<span class="mono muted">${tally.votes}</span>` : ''}
            <span class="check">✓</span>
          </span>
        </button>`;
      })
      .join('');

    app.innerHTML = `
      <div>${header(view)}</div>
      <div class="stack">
        ${intelCard(view)}
        <div class="card raised stack">
          <div class="row between">
            <span class="signature" style="font-size:1.2rem;">Night ${view.round}</span>
            <span class="countdown" id="countdown"></span>
          </div>
          <p class="muted" style="margin:0 0 4px;">${actionLabel}${prompt.kind === 'team' ? ' — decide together with your pack' : ''}</p>
          ${prompt.kind === 'team' && prompt.teammates?.length ? `<p class="muted" style="font-size:0.8rem; margin:0 0 6px;">With: ${prompt.teammates.map(escapeHtml).join(', ')}</p>` : ''}
          ${prompt.kind === 'team' && prompt.teammateVotes?.length ? `
            <div class="team-votes stack" style="gap:4px; margin:0 0 6px;">
              <div class="eyebrow">Pack votes</div>
              ${prompt.teammateVotes.map((vote) => `<div class="muted" style="font-size:0.8rem;">${escapeHtml(vote.voterName)} → ${escapeHtml(vote.targetName)}</div>`).join('')}
            </div>` : ''}
          <div class="target-list">${rows}</div>
          <p class="muted center" style="font-size:0.8rem;">Tap a name to choose. You can change your mind until the timer ends.</p>
        </div>
      </div>`;

    WW.bindCountdown(document.getElementById('countdown'), prompt.endsAt, () => {});
    document.querySelectorAll('.target-btn').forEach((btn) => {
      btn.addEventListener('click', () => submitNightAction(btn.dataset.id));
    });
  }

  async function submitNightAction(targetId) {
    try {
      const view = await WW.api('POST', `/api/player/rooms/${state.code}/night-action`, {
        playerId: state.playerId,
        token: state.token,
        targetId,
      });
      render(view);
    } catch (err) {
      WW.toast(err.message);
    }
  }

  function renderVote(view) {
    const prompt = view.votePrompt;
    if (!prompt) return renderGeneric(view, 'Voting is open', 'Waiting on the vote…');
    const rows = prompt.candidates
      .map((c) => {
        const selected = c.id === prompt.yourVote;
        return `
        <button class="target-btn ${selected ? 'selected' : ''}" data-id="${c.id}">
          <span>${escapeHtml(c.name)}</span>
          <span class="check">✓</span>
        </button>`;
      })
      .join('');
    app.innerHTML = `
      <div>${header(view)}</div>
      <div class="stack">
        ${intelCard(view)}
        <div class="card raised stack">
          <div class="row between">
            <span class="signature" style="font-size:1.2rem;">Day Vote</span>
            <span class="countdown" id="countdown"></span>
          </div>
          <p class="muted" style="margin:0 0 4px;">Who should the village vote out?</p>
          <div class="target-list">${rows}</div>
          <p class="muted center" style="font-size:0.8rem;">Tap a name to vote. You can change your vote until the timer ends.</p>
        </div>
      </div>`;
    WW.bindCountdown(document.getElementById('countdown'), prompt.endsAt, () => {});
    document.querySelectorAll('.target-btn').forEach((btn) => {
      btn.addEventListener('click', () => castVote(btn.dataset.id));
    });
  }

  async function castVote(targetId) {
    try {
      const view = await WW.api('POST', `/api/player/rooms/${state.code}/vote`, {
        playerId: state.playerId,
        token: state.token,
        targetId,
      });
      render(view);
    } catch (err) {
      WW.toast(err.message);
    }
  }

  function renderDead(view) {
    const reasonText = {
      killed: 'The wolves got you in the night.',
      'voted-out': 'The village voted you out.',
    }[view.eliminatedReason] || "You've been eliminated.";
    app.innerHTML = `
      <div>${header(view)}</div>
      <div class="stack center" style="justify-content:center; flex:1;">
        <div class="role-emoji" style="filter:grayscale(1); opacity:0.7;">🪦</div>
        <div class="signature" style="font-size:2rem; color:var(--bloodmoon);">Eliminated</div>
        <p class="muted">${escapeHtml(reasonText)}</p>
        <p class="muted" style="font-size:0.85rem;">You can keep watching quietly. Don't reveal anything out loud.</p>
      </div>`;
  }

  function renderEnded(view) {
    app.innerHTML = `
      <div>${header(view)}</div>
      <div class="stack center" style="justify-content:center; flex:1;">
        <div class="role-emoji">🌅</div>
        <div class="signature" style="font-size:1.8rem;">Game Over</div>
        ${view.role ? `<p class="muted">You were the ${escapeHtml(view.role.name)}.</p>` : ''}
        <p class="muted" style="font-size:0.85rem;">Thanks for playing. Ask your host about the next round.</p>
      </div>`;
  }

  // ---------------- Boot ----------------

  function init() {
    const codeFromUrl = (WW.qs('room') || '').toUpperCase();
    const saved = codeFromUrl ? WW.storage.loadPlayer(codeFromUrl) : null;
    if (codeFromUrl && saved && saved.playerId && saved.token) {
      resumeSession(codeFromUrl, saved);
    } else {
      renderJoin(codeFromUrl);
    }
  }

  init();
})();
