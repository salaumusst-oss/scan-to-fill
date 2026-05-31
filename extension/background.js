const DEFAULT_SERVER = 'https://scan-to-fill.onrender.com';

// ── Session ID: unique ID for this laptop, generated once ──────────────────────
async function getOrCreateSession() {
  return new Promise(resolve => {
    chrome.storage.local.get({ sessionId: '' }, data => {
      if (data.sessionId) return resolve(data.sessionId);
      const id = Math.random().toString(36).substr(2, 12);
      chrome.storage.local.set({ sessionId: id });
      resolve(id);
    });
  });
}

async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get({ roomCode: '', sessionId: '' }, resolve);
  });
}

// ── Badge: green dot = server reachable, red ! = not ──────────────────────────
async function checkServer() {
  try {
    await fetch(DEFAULT_SERVER + '/api/latest', { signal: AbortSignal.timeout(15000) });
    chrome.action.setBadgeText({ text: '●' });
    chrome.action.setBadgeBackgroundColor({ color: '#4ade80' });
  } catch {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f87171' });
  }
}

// ── Heartbeat: keeps this laptop's "online" status alive on the server ─────────
async function sendHeartbeat() {
  const { roomCode, sessionId } = await getSettings();
  if (!roomCode || !sessionId) return;
  try {
    await fetch(`${DEFAULT_SERVER}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: roomCode, session: sessionId, type: 'laptop' }),
      signal: AbortSignal.timeout(10000)
    });
  } catch { /* ignore — will retry on next tick */ }
}

// ── Poll for new scans → desktop notification ─────────────────────────────────
async function pollForNewScan() {
  const { roomCode } = await getSettings();
  if (!roomCode) return;

  return new Promise(resolve => {
    chrome.storage.local.get({ lastSeenTimestamp: 0 }, async ({ lastSeenTimestamp }) => {
      try {
        const res  = await fetch(`${DEFAULT_SERVER}/api/latest?room=${roomCode}`, { signal: AbortSignal.timeout(10000) });
        const scan = await res.json();

        if (scan.timestamp && scan.timestamp > lastSeenTimestamp && scan.fields) {
          // New scan arrived!
          chrome.storage.local.set({ lastSeenTimestamp: scan.timestamp });

          const f    = scan.fields;
          const name = [f['First Name'], f['Last Name']].filter(Boolean).join(' ') || 'a patient';
          const age  = f['Age'] ? `, ${f['Age']} yrs` : '';

          chrome.notifications.create({
            type:    'basic',
            iconUrl: 'icon.png',
            title:   '📄 New Scan Ready!',
            message: `${name}${age} — click Fill Page Now to auto-fill the form.`
          });
        }
      } catch { /* network error — ignore */ }
      resolve();
    });
  });
}

// ── Alarms ─────────────────────────────────────────────────────────────────────
// 'heartbeat'   — every 1 min: keep laptop "online" in the room
// 'server-check'— every 2 min: update badge colour
// 'scan-poll'   — every 1 min: check for new scans & notify

chrome.alarms.create('heartbeat',    { periodInMinutes: 1 });
chrome.alarms.create('server-check', { periodInMinutes: 2 });
chrome.alarms.create('scan-poll',    { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'heartbeat')    sendHeartbeat();
  if (alarm.name === 'server-check') checkServer();
  if (alarm.name === 'scan-poll')    pollForNewScan();
});

// ── Startup ────────────────────────────────────────────────────────────────────
getOrCreateSession();
checkServer();
sendHeartbeat();
