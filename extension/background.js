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

// ── Heartbeat: registers + keeps this laptop "online" on the server ────────────
// We call /api/connect (not /api/heartbeat) so the laptop is re-registered
// automatically after a server restart, and the website always shows it.
async function sendHeartbeat() {
  const { roomCode, sessionId } = await getSettings();
  if (!roomCode || !sessionId) return;
  try {
    await fetch(`${DEFAULT_SERVER}/api/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: roomCode, session: sessionId, type: 'laptop', name: 'Laptop' }),
      signal: AbortSignal.timeout(10000)
    });
  } catch { /* ignore — will retry on next tick */ }
}

// ── Poll for new scans → desktop notification ─────────────────────────────────
// Watches the unopened queue — fires when a new scan arrives on the website.
async function pollForNewScan() {
  const { roomCode } = await getSettings();
  if (!roomCode) return;

  return new Promise(resolve => {
    chrome.storage.local.get({ lastSeenTimestamp: 0 }, async ({ lastSeenTimestamp }) => {
      try {
        const res  = await fetch(`${DEFAULT_SERVER}/api/scans?room=${roomCode}`, { signal: AbortSignal.timeout(10000) });
        const data = await res.json();

        // Check the most recent unread scan
        const newest = data.unopened?.[0];
        if (newest && newest.timestamp > lastSeenTimestamp) {
          chrome.storage.local.set({ lastSeenTimestamp: newest.timestamp });

          const f    = newest.fields || {};
          const name = [f['First Name'], f['Last Name']].filter(Boolean).join(' ') || 'a patient';
          const age  = f['Age'] ? `, ${f['Age']} yrs` : '';

          chrome.notifications.create({
            type:    'basic',
            iconUrl: 'icon.png',
            title:   '📄 New Scan Arrived!',
            message: `${name}${age} — go to the website and click the scan to fill the form.`
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

// ── Auto-fill via persistent port ─────────────────────────────────────────────
// content.js on the NCNMO page opens a chrome.runtime.connect() port.
// While that port is open the service worker stays ALIVE and can poll
// /api/pending-fill every 2 seconds without being put to sleep by Chrome.
// This is the most reliable approach for Manifest V3.

const activePorts = new Map(); // tabId → port

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'stf-ncnmo') return;

  const tabId = port.sender?.tab?.id;
  if (!tabId) return;

  activePorts.set(tabId, port);

  let pollInterval = null;
  let lastFillTs   = 0;

  async function poll() {
    const { roomCode } = await getSettings();
    if (!roomCode) return;

    try {
      const res  = await fetch(`${DEFAULT_SERVER}/api/pending-fill?room=${roomCode}`,
                               { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      if (!data.fields) return;

      const ts = data.timestamp || Date.now();
      if (ts <= lastFillTs) return;  // already handled
      lastFillTs = ts;

      // Tell content.js to update its badge
      try { port.postMessage({ type: 'filling' }); } catch {}

      // Find the NCNMO tab and fill it
      const tabs = await chrome.tabs.query({ url: '*://ncnmoplatformemr.axocheck.com/*' });
      const tab  = tabs.find(t => t.url?.includes('/patient')) || tabs[0] || { id: tabId };

      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: autoFillFunc, args: [data.fields]
      }).catch(console.error);

      try { port.postMessage({ type: 'filled' }); } catch {}

    } catch { /* network error or abort — retry next tick */ }
  }

  // Start polling every 2 seconds while the page is open
  pollInterval = setInterval(poll, 2000);
  poll(); // immediate first check

  port.onMessage.addListener(msg => {
    // 'ping' from content.js keeps the connection alive
    if (msg.type === 'ping' && msg.roomCode) {
      // Refresh room code if it changed
    }
  });

  port.onDisconnect.addListener(() => {
    clearInterval(pollInterval);
    activePorts.delete(tabId);
  });
});

// ── Standalone fill function — runs in the page's MAIN world ───────────────────
// Must be fully self-contained (no closures over outer variables).
async function autoFillFunc(fields) {
  let filled = 0;

  function expandGender(v) {
    const m = { m:'Male', f:'Female', male:'Male', female:'Female' };
    return m[(v||'').trim().toLowerCase()] || v;
  }
  function expandMarital(v) {
    const m = { m:'Married', d:'Divorced', w:'Widowed', s:'Single',
                married:'Married', divorced:'Divorced', widowed:'Widowed', single:'Single' };
    return m[(v||'').trim().toLowerCase()] || v;
  }
  function setInput(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    ['input','change','blur'].forEach(e => el.dispatchEvent(new Event(e, { bubbles:true })));
  }
  function setSelect(select, value) {
    if (!value) return false;
    const v   = value.trim().toLowerCase();
    const opt = [...select.options].find(o =>
      o.value.trim().toLowerCase() === v || o.text.trim().toLowerCase() === v ||
      o.text.trim().toLowerCase().startsWith(v) || o.value.trim().toLowerCase().startsWith(v) ||
      o.text.trim().toLowerCase().includes(v)   || o.value.trim().toLowerCase().includes(v)
    );
    if (!opt) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
    if (setter) setter.call(select, opt.value); else select.value = opt.value;
    ['change','input','blur'].forEach(e => select.dispatchEvent(new Event(e, { bubbles:true })));
    return true;
  }
  function findSelectByOptions(...hints) {
    const h = hints.map(v => v.toLowerCase());
    for (const sel of document.querySelectorAll('select')) {
      const opts = [...sel.options].map(o => o.text.trim().toLowerCase()).filter(t => t.length > 0);
      if (opts.length && h.every(hint => opts.some(opt => opt.includes(hint)))) return sel;
    }
    return null;
  }
  function findSelectByLabel(labelText) {
    const needle = labelText.trim().toLowerCase();
    for (const sel of document.querySelectorAll('select')) {
      let node = sel;
      for (let i = 0; i < 10; i++) {
        node = node.parentElement;
        if (!node) break;
        for (const el of node.querySelectorAll('label,p,span,div,h6,legend,th,td')) {
          if (el.contains(sel)) continue;
          const t = el.textContent.trim().toLowerCase().replace(/[*:]/g,'');
          if (t === needle || t.startsWith(needle) || t.includes(needle)) return sel;
        }
      }
    }
    return null;
  }

  // Text inputs
  for (const [name, value] of [
    ['first_name',        fields['First Name']],
    ['last_name',         fields['Last Name']],
    ['phone_number',      fields['Patient Phone No.']],
    ['address',           fields['Address']],
    ['occupation',        fields['Occupation']],
    ['religion',          fields['Religion']],
    ['next_of_kin_phone', fields['Next of Kin Phone']],
  ]) {
    if (!value) continue;
    const el = document.querySelector(`input[name="${name}"]`);
    if (el) { setInput(el, value); filled++; }
  }

  // Dropdowns — re-find after each React re-render
  const gender  = expandGender(fields['Gender (Sex)']);
  const marital = expandMarital(fields['Marital Status']);

  for (const [finder, value] of [
    [() => findSelectByOptions('male','female')    || findSelectByLabel('Gender'),         gender],
    [() => findSelectByOptions('married','single') || findSelectByLabel('Marital Status'), marital],
    [() => findSelectByOptions('kwara')            || findSelectByLabel('State'),          'Kwara'],
    [() => findSelectByOptions('ajase')           || findSelectByLabel('Location'),       'Ajase'],
  ]) {
    if (!value) continue;
    await new Promise(r => setTimeout(r, 200));
    const s = finder();
    if (s && setSelect(s, value)) filled++;
  }

  // Date of Birth picker
  let yr = null, mo = 0, dy = 1;
  if (fields['Date of Birth']) {
    const d = new Date(fields['Date of Birth']);
    if (!isNaN(d)) { yr = d.getFullYear(); mo = d.getMonth(); dy = d.getDate(); }
  } else if (parseInt(fields['Age']) > 0) {
    yr = new Date().getFullYear() - parseInt(fields['Age']);
  }
  if (yr) {
    const dateBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Pick a date');
    if (dateBtn) {
      dateBtn.click();
      await new Promise(r => setTimeout(r, 400));
      const allSel = [...document.querySelectorAll('select')];
      const mSel = allSel.find(s => s.options[0]?.value === '0' && s.options.length === 12);
      const ySel = allSel.find(s => s.options.length > 50 && !isNaN(s.options[0]?.value));
      if (mSel && ySel) {
        const ss = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
        if (ss) ss.call(mSel, String(mo)); else mSel.value = String(mo);
        mSel.dispatchEvent(new Event('change', { bubbles:true }));
        if (ss) ss.call(ySel, String(yr)); else ySel.value = String(yr);
        ySel.dispatchEvent(new Event('change', { bubbles:true }));
        await new Promise(r => setTimeout(r, 300));
        const dayBtn = [...document.querySelectorAll('button')].find(b =>
          b.textContent.trim() === String(dy) && !b.disabled && !b.className.includes('outside')
        );
        if (dayBtn) { dayBtn.click(); filled++; }
      }
    }
  }

  // Toast
  document.getElementById('stf-toast')?.remove();
  const t = document.createElement('div');
  t.id = 'stf-toast';
  t.textContent = filled > 0
    ? `✓ Filled ${filled} fields — review and click Submit`
    : '⚠ No fields filled — check the form';
  Object.assign(t.style, {
    position:'fixed', bottom:'24px', right:'24px', zIndex:'2147483647',
    background:'#1e3a2a', border:'1.5px solid #4ade80', color:'#4ade80',
    padding:'12px 20px', borderRadius:'100px',
    fontSize:'14px', fontWeight:'700', fontFamily:'system-ui,sans-serif',
    boxShadow:'0 4px 24px rgba(0,0,0,.3)', pointerEvents:'none',
  });
  document.body.appendChild(t);
}

// ── Startup ────────────────────────────────────────────────────────────────────
getOrCreateSession();
checkServer();
sendHeartbeat();
