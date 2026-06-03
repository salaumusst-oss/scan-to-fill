// content.js — ISOLATED world, runs on every page.
// On the NCNMO form: opens a persistent port to background.js
// (this keeps the service worker alive so it can poll and fill).

const NCNMO_HOST = 'ncnmoplatformemr.axocheck.com';

if (location.hostname === NCNMO_HOST) {
  chrome.storage.local.get({ roomCode: '' }, ({ roomCode }) => {
    showBadge(roomCode);
    if (roomCode) connectPort(roomCode);
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

// ── Persistent port — keeps the service worker alive while page is open ───────
function connectPort(roomCode) {
  let port;

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'stf-ncnmo' });

      // Background tells us when it triggered a fill
      port.onMessage.addListener(msg => {
        if (msg.type === 'filling')  setBadge('Filling form…', '#fbbf24');
        if (msg.type === 'filled')   setBadge(`● Scan to Fill · Room ${roomCode}`, '#4ade80');
      });

      // If port disconnects (SW restarted), reconnect after a moment
      port.onDisconnect.addListener(() => {
        setTimeout(connect, 1000);
      });

      // Ping every 20s so the SW knows the page is still open
      const ping = setInterval(() => {
        try { port.postMessage({ type: 'ping', roomCode }); }
        catch { clearInterval(ping); }
      }, 20000);

    } catch { setTimeout(connect, 2000); }
  }

  connect();
}
