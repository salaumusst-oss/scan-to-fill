// content.js — ISOLATED world, runs on every page.
// On the NCNMO form: opens a persistent port to background.js
// (keeps SW alive for polling) + watches URL for auto-next-patient.

const STF_SERVER = 'https://scan-to-fill.onrender.com';
const NCNMO_HOST = 'ncnmoplatformemr.axocheck.com';

if (location.hostname === NCNMO_HOST) {
  chrome.storage.local.get({ roomCode: '', autoNext: true }, ({ roomCode, autoNext }) => {
    showBadge(roomCode);
    if (roomCode) connectPort(roomCode);
    watchForAutoNext();
  });
}

// ── Status badge ──────────────────────────────────────────────────────────────
function showBadge(roomCode) {
  const go = () => {
    if (!document.body) { setTimeout(go, 200); return; }
    document.getElementById('stf-badge')?.remove();
    const b = document.createElement('div');
    b.id = 'stf-badge';
    b.textContent = roomCode ? `● Scan to Fill · Room ${roomCode}` : '⚠ Scan to Fill · No room';
    Object.assign(b.style, {
      position:'fixed', bottom:'16px', left:'16px', zIndex:'2147483647',
      background: roomCode ? '#0d1f14' : '#2a1010',
      border:`1px solid ${roomCode ? '#4ade80' : '#f87171'}`,
      color: roomCode ? '#4ade80' : '#f87171',
      padding:'7px 14px', borderRadius:'100px',
      fontSize:'12px', fontWeight:'700', fontFamily:'system-ui,sans-serif',
      pointerEvents:'none',
    });
    document.body.appendChild(b);
  };
  go();
}

function setBadge(text, color) {
  const b = document.getElementById('stf-badge');
  if (!b) return;
  b.textContent = text;
  b.style.color = color;
  b.style.borderColor = color;
  b.style.background = color === '#4ade80' ? '#0d1f14' : color === '#fbbf24' ? '#1f1800' : '#1a0d0d';
}

// ── Auto-next patient ─────────────────────────────────────────────────────────
// Polls location.href every 500ms. If we WERE on /patient/create/ and the URL
// changed away from it (React submitted the form and navigated), redirect back
// to a fresh /patient/create/. This works in ISOLATED world — no history hacks.
function watchForAutoNext() {
  let lastPath = location.pathname;

  setInterval(() => {
    const now = location.pathname;
    if (now === lastPath) return;

    const wasOnCreate = lastPath.includes('/patient/create');
    const leftCreate  = !now.includes('/patient/create');
    lastPath = now;

    if (wasOnCreate && leftCreate) {
      chrome.storage.local.get({ autoNext: true }, ({ autoNext }) => {
        if (autoNext) {
          setBadge('Loading next patient…', '#fbbf24');
          setTimeout(() => {
            location.href = 'https://ncnmoplatformemr.axocheck.com/patient/create/';
          }, 800);
        }
      });
    }
  }, 500);
}

// ── Persistent port — keeps the service worker alive while page is open ───────
function connectPort(roomCode) {
  let port;

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'stf-ncnmo' });

      port.onMessage.addListener(msg => {
        if (msg.type === 'filling')  setBadge('Filling form…', '#fbbf24');
        if (msg.type === 'filled')   setBadge(`● Scan to Fill · Room ${roomCode}`, '#4ade80');
      });

      port.onDisconnect.addListener(() => {
        setTimeout(connect, 1000);
      });

      const ping = setInterval(() => {
        try { port.postMessage({ type: 'ping', roomCode }); }
        catch { clearInterval(ping); }
      }, 20000);

    } catch { setTimeout(connect, 2000); }
  }

  connect();
}
