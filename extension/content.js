// content.js — runs on every page in ISOLATED world.
// On the NCNMO patient form, polls for a pending auto-fill and asks
// background.js to execute it in MAIN world (where React lives).

const STF_SERVER = 'https://scan-to-fill.onrender.com';
const NCNMO_HOST = 'ncnmoplatformemr.axocheck.com';

if (location.hostname === NCNMO_HOST) {
  chrome.storage.local.get({ roomCode: '' }, ({ roomCode }) => {
    showBadge(roomCode);
    if (roomCode) startPoll(roomCode);
  });
}

// ── Status badge — visible on the NCNMO page so you know it's active ──────────
function showBadge(roomCode) {
  // Wait for body to be ready
  const attach = () => {
    if (!document.body) { setTimeout(attach, 200); return; }
    document.getElementById('stf-badge')?.remove();
    const b = document.createElement('div');
    b.id = 'stf-badge';
    b.textContent = roomCode
      ? `● Scan to Fill · Room ${roomCode}`
      : '⚠ Scan to Fill · No room code set';
    Object.assign(b.style, {
      position: 'fixed', bottom: '16px', left: '16px', zIndex: '2147483647',
      background: roomCode ? '#0d1f14' : '#2a1010',
      border: `1px solid ${roomCode ? '#4ade80' : '#f87171'}`,
      color:  roomCode ? '#4ade80' : '#f87171',
      padding: '7px 14px', borderRadius: '100px',
      fontSize: '12px', fontWeight: '700', fontFamily: 'system-ui, sans-serif',
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
                      : color === '#fbbf24' ? '#1f1800'
                      : '#1a0d0d';
}

// ── Poll server for pending fill ───────────────────────────────────────────────
function startPoll(roomCode) {
  setInterval(async () => {
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 8000); // 8s timeout per poll
      const res  = await fetch(
        `${STF_SERVER}/api/pending-fill?room=${roomCode}`,
        { signal: ctrl.signal }
      );
      clearTimeout(tid);
      const data = await res.json();
      if (!data.fields) return;

      // Fields arrived — signal the badge and ask background to fill
      setBadge('Filling form…', '#fbbf24');
      chrome.runtime.sendMessage(
        { type: 'auto-fill', fields: data.fields },
        () => {
          // Brief "done" flash then back to ready
          setTimeout(() => setBadge(`● Scan to Fill · Room ${roomCode}`, '#4ade80'), 3000);
        }
      );
    } catch (e) {
      // AbortError = timeout (server slow) — ignore and retry next tick
      // Other errors logged for debugging
      if (e.name !== 'AbortError') console.debug('[STF] poll error:', e.message);
    }
  }, 1500);
}
