// public/js/common.js
// Shared helpers for both the host and player apps. Loaded as a plain
// script (no build step) so this has to stay dependency-free.

const WW = (() => {
  function qs(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* empty body, e.g. 204 */
    }
    if (!res.ok) {
      const err = new Error((data && data.message) || `Request failed (${res.status})`);
      err.code = data && data.error;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  let toastTimer = null;
  function toast(message) {
    let el = document.getElementById('ww-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ww-toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.style.display = 'none';
    }, 3200);
  }

  // Native EventSource already retries on drop; we add a status callback so
  // the UI can show "reconnecting" instead of silently going stale — handy
  // when a phone locks mid-game and the connection is re-established.
  function connectSSE(url, { onMessage, onStatus }) {
    let es = null;
    let closedByUs = false;

    function open() {
      es = new EventSource(url);
      es.addEventListener('open', () => onStatus && onStatus('connected'));
      es.addEventListener('error', () => {
        if (!closedByUs) onStatus && onStatus('reconnecting');
      });
      es.addEventListener('state', (evt) => {
        try {
          onMessage(JSON.parse(evt.data));
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('bad SSE payload', e);
        }
      });
    }
    open();

    // Extra safety net: if the tab was backgrounded/locked long enough that
    // the browser fully suspended the connection, force a fresh one when it
    // becomes visible again rather than trusting EventSource to notice.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && es && es.readyState === EventSource.CLOSED) {
        open();
      }
    });

    return {
      close() {
        closedByUs = true;
        if (es) es.close();
      },
    };
  }

  function fmtClock(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // Renders a live countdown into `el` until `endsAt` (epoch ms), calling
  // onExpire once. Returns a stop() function. Safe to call repeatedly with a
  // new endsAt — it clears its own previous interval first.
  function bindCountdown(el, endsAt, onExpire) {
    if (el._wwCountdownStop) el._wwCountdownStop();
    let firedExpire = false;
    function tick() {
      const remaining = endsAt - Date.now();
      el.textContent = fmtClock(remaining);
      el.classList.toggle('urgent', remaining < 15000);
      if (remaining <= 0 && !firedExpire) {
        firedExpire = true;
        if (onExpire) onExpire();
      }
    }
    tick();
    const id = setInterval(tick, 250);
    el._wwCountdownStop = () => clearInterval(id);
    return el._wwCountdownStop;
  }

  const storage = {
    savePlayer(code, data) {
      localStorage.setItem(`ww:player:${code.toUpperCase()}`, JSON.stringify(data));
    },
    loadPlayer(code) {
      try {
        return JSON.parse(localStorage.getItem(`ww:player:${code.toUpperCase()}`));
      } catch {
        return null;
      }
    },
    saveHostRoom(code, secret) {
      localStorage.setItem('ww:lastHostRoom', JSON.stringify({ code, secret, at: Date.now() }));
    },
    loadHostRoom() {
      try {
        return JSON.parse(localStorage.getItem('ww:lastHostRoom'));
      } catch {
        return null;
      }
    },
  };

  return { qs, api, toast, connectSSE, fmtClock, bindCountdown, storage };
})();
