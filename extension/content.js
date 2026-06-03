// content.js — runs on every page in ISOLATED world.
// Polls for pending auto-fill and signals background.js via TWO paths:
//   Path A: sendMessage   (fast when SW is awake)
//   Path B: chrome.storage.local (always wakes the SW — reliable fallback)

const STF_SERVER = 'https://scan-to-fill.onrender.com';
const NCNMO_HOST = 'ncnmoplatformemr.axocheck.com';

if (location.hostname === NCNMO_HOST) {
  chrome.storage.local.get({ roomCode: '' }, ({ roomCode }) => {
    showBadge(roomCode);
    if (roomCode) startPoll(roomCode);
  });
}

// ── Status badge ──────────────────────────────────────────────────────────────
function showBadge(roomCode) {
  const attach = () => {
    if (!document.body) { setTimeout(attach, 200); return; }
    document.getElementById('stf-badge')?.remove();
    const b = document.createElement('div');
    b.id = 'stf-badge';
    b.textContent = roomCode
      ? `● Scan to Fill · Room ${roomCode}`
      : '⚠ Scan to Fill · No room code';
    Object.assign(b.style, {
      position: 'fixed', bottom: '16px', left: '16px', zIndex: '2147483647',
      background: roomCode ? '#0d1f14' : '#2a1010',
      border: `1px solid ${roomCode ? '#4ade80' : '#f87171'}`,
      color:  roomCode ? '#4ade80' : '#f87171',
      padding: '7px 14px', borderRadius: '100px',
      fontSize: '12px', fontWeight: '700', fontFamily: 'system-ui,sans-serif',
      pointerEvents: 'none', userSelect: 'none',
    });
    document.body.appendChild(b);
  };
  attach();
}

function setBadge(text, color) {
  const b = document.getElementById('stf-badge');
  if (!b) return;
  b.textContent = text;
  b.style.color       = color;
  b.style.borderColor = color;
  b.style.background  = color === '#4ade80' ? '#0d1f14'
                      : color === '#fbbf24' ? '#1f1800' : '#1a0d0d';
}

// ── Poll ──────────────────────────────────────────────────────────────────────
function startPoll(roomCode) {
  setInterval(async () => {
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 8000);
      const res  = await fetch(`${STF_SERVER}/api/pending-fill?room=${roomCode}`, { signal: ctrl.signal });
      clearTimeout(tid);
      const data = await res.json();
      if (!data.fields) return;

      const ts = data.timestamp || Date.now();
      setBadge('Filling form…', '#fbbf24');

      // Path A: sendMessage (fast path)
      chrome.runtime.sendMessage({ type: 'auto-fill', fields: data.fields, ts });

      // Path B: storage (reliable fallback — wakes SW even if sleeping)
      chrome.storage.local.set({ stfFill: { fields: data.fields, ts } });

      setTimeout(() => setBadge(`● Scan to Fill · Room ${roomCode}`, '#4ade80'), 4000);
    } catch (e) {
      if (e.name !== 'AbortError') console.debug('[STF] poll error:', e.message);
    }
  }, 1500);
}
