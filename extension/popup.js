// ── Constants ──────────────────────────────────────────────────────────────────
const DEFAULT_SERVER = 'https://scan-to-fill.onrender.com';

// 4 random uppercase letters (skip I and O to avoid confusion)
function randomRoom() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Session ID: generated once per extension install, never changes ────────────
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

// ── Connect this laptop to a room (called from setup screen + save button) ────
async function connectToRoom(roomCode, sessionId) {
  const res  = await fetch(`${DEFAULT_SERVER}/api/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: roomCode, session: sessionId, type: 'laptop', name: 'Laptop' }),
    signal: AbortSignal.timeout(15000)
  });
  return res.json();
}

// ── Screens ────────────────────────────────────────────────────────────────────
function showSetup() {
  document.getElementById('screen-setup').style.display = 'block';
  document.getElementById('screen-main').style.display  = 'none';
}

function showMain() {
  document.getElementById('screen-setup').style.display = 'none';
  document.getElementById('screen-main').style.display  = 'block';
}

// ── Update check ───────────────────────────────────────────────────────────────
async function checkForUpdate() {
  try {
    const res        = await fetch(`${DEFAULT_SERVER}/api/version`, { signal: AbortSignal.timeout(8000) });
    const { version} = await res.json();
    const mine       = chrome.runtime.getManifest().version;
    if (version !== mine) {
      document.getElementById('update-banner').style.display = 'block';
    }
  } catch { /* silent — don't block the UI */ }
}

// ── Load the main screen for a connected room ──────────────────────────────────
async function loadMain(roomCode) {
  showMain();
  checkForUpdate(); // non-blocking

  document.getElementById('room-chip').textContent    = roomCode;
  document.getElementById('input-room').value         = roomCode;
  updatePhoneUrl(DEFAULT_SERVER, roomCode);

  const dot          = document.getElementById('dot');
  const statusText   = document.getElementById('status-text');
  const fieldsSection = document.getElementById('fields-section');
  const fillBtn      = document.getElementById('fill-btn');

  try {
    const res  = await fetch(`${DEFAULT_SERVER}/api/latest?room=${roomCode}`, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();

    dot.classList.remove('pulse');
    dot.classList.add('ok');
    statusText.textContent = `Connected · Room: ${roomCode}`;

    if (data.fields && Object.values(data.fields).some(v => v)) {
      fillBtn.style.display = 'block';
      const entries = Object.entries(data.fields).filter(([, v]) => v);
      fieldsSection.innerHTML = `
        <div class="section-label">Selected for filling</div>
        <div class="field-list">
          ${entries.map(([k, v]) => `
            <div class="field-item">
              <span class="fname">${esc(k)}</span>
              <span class="fval" title="${esc(v)}">${esc(v)}</span>
            </div>
          `).join('')}
        </div>
      `;
    } else {
      fieldsSection.innerHTML = `<p class="empty">No scan selected.<br>Go to the website and click a scan to send it here.</p>`;
    }
  } catch {
    dot.classList.remove('pulse');
    statusText.textContent = 'Server not running';
    fieldsSection.innerHTML = `<p class="empty" style="color:#f87171">Could not reach server.</p>`;
  }
}

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  const sessionId = await getOrCreateSession();

  chrome.storage.local.get({ roomCode: '' }, async data => {
    if (!data.roomCode) {
      // First time — show setup screen
      showSetup();
    } else {
      await loadMain(data.roomCode);
    }
  });

  // ── Setup screen events ──────────────────────────────────────────────────────
  document.getElementById('setup-room-input').addEventListener('input', function () {
    this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  document.getElementById('setup-gen-link').addEventListener('click', () => {
    document.getElementById('setup-room-input').value = randomRoom();
    document.getElementById('setup-error').textContent = '';
  });

  document.getElementById('setup-connect-btn').addEventListener('click', async () => {
    const code  = document.getElementById('setup-room-input').value.trim().toUpperCase();
    const errEl = document.getElementById('setup-error');
    const btn   = document.getElementById('setup-connect-btn');

    if (!code) { errEl.textContent = 'Please enter a room code.'; return; }

    btn.disabled    = true;
    btn.textContent = 'Connecting…';
    errEl.textContent = '';

    try {
      const result = await connectToRoom(code, sessionId);
      if (result.ok) {
        chrome.storage.local.set({ roomCode: code });
        await loadMain(code);
      } else {
        errEl.textContent = `Room ${code} is already in use by another laptop (${result.takenBy}). Try a different code.`;
        btn.disabled    = false;
        btn.textContent = 'Connect →';
      }
    } catch {
      errEl.textContent = 'Could not reach the server. Try again.';
      btn.disabled    = false;
      btn.textContent = 'Connect →';
    }
  });

  document.getElementById('setup-room-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('setup-connect-btn').click();
  });

  // ── Settings panel ───────────────────────────────────────────────────────────
  document.getElementById('setup-btn').addEventListener('click', () => {
    const panel = document.getElementById('settings-panel');
    panel.classList.toggle('open');
    document.getElementById('setup-btn').textContent =
      panel.classList.contains('open') ? '▲ Hide Settings' : '⚙️ Settings';
  });

  document.getElementById('save-btn').addEventListener('click', async () => {
    const code = document.getElementById('input-room').value.trim().toUpperCase() || randomRoom();
    const btn  = document.getElementById('save-btn');
    const errEl = document.getElementById('setup-error'); // reuse if needed

    btn.disabled    = true;
    btn.textContent = 'Connecting…';

    try {
      const result = await connectToRoom(code, sessionId);
      if (result.ok) {
        chrome.storage.local.set({ roomCode: code });
        btn.textContent = '✓ Saved!';
        setTimeout(() => { btn.textContent = 'Save & Reconnect'; btn.disabled = false; }, 1500);
        await loadMain(code);
      } else {
        btn.textContent = 'Room Taken';
        btn.disabled    = false;
        alert(`Room ${code} is already in use by another laptop (${result.takenBy}).`);
      }
    } catch {
      btn.textContent = 'Error — retry';
      btn.disabled    = false;
    }
  });

  document.getElementById('input-room').addEventListener('input', function () {
    this.value = this.value.toUpperCase();
    updatePhoneUrl(DEFAULT_SERVER, this.value.trim());
  });

  document.getElementById('copy-link').addEventListener('click', () => {
    const url = document.getElementById('phone-url-display').textContent;
    navigator.clipboard.writeText(url).then(() => {
      document.getElementById('copy-link').textContent = '✓ Copied!';
      setTimeout(() => { document.getElementById('copy-link').textContent = 'Copy link'; }, 1500);
    });
  });

  document.getElementById('disconnect-link').addEventListener('click', () => {
    if (confirm('Disconnect from this room? You will need to enter a room code again.')) {
      chrome.storage.local.remove('roomCode');
      document.getElementById('settings-panel').classList.remove('open');
      document.getElementById('setup-btn').textContent = '⚙️ Settings';
      document.getElementById('setup-room-input').value = '';
      document.getElementById('setup-error').textContent = '';
      showSetup();
    }
  });

  // ── Debug: show all <select> elements on the page ────────────────────────────
  document.getElementById('debug-btn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        const selects = [...document.querySelectorAll('select')];
        const lines = selects.length
          ? selects.map((s, i) => {
              const opts = [...s.options].map(o => `  "${o.text}" → val="${o.value}"`).join('\n');
              return `── Select ${i+1} [name="${s.name}" id="${s.id}"]\n${opts || '  (no options yet)'}`;
            }).join('\n\n')
          : '⚠ No <select> elements found on this page.';

        document.getElementById('stf-debug')?.remove();
        const box = document.createElement('div');
        box.id = 'stf-debug';
        box.style.cssText = [
          'position:fixed','top:12px','right:12px','z-index:2147483647',
          'background:#0f0f1a','border:2px solid #7eb8f7','color:#e8e8f0',
          'padding:16px','border-radius:14px','font-size:11px','font-family:monospace',
          'white-space:pre','max-width:440px','max-height:82vh','overflow-y:auto',
          'box-shadow:0 4px 32px rgba(0,0,0,.7)'
        ].join(';');
        box.textContent = `${selects.length} <select> elements found:\n\n${lines}`;
        const btn = document.createElement('button');
        btn.textContent = '✕ Close';
        btn.style.cssText = 'display:block;margin-top:12px;background:#7eb8f7;border:none;color:#0f0f1a;padding:6px 16px;border-radius:8px;cursor:pointer;font-weight:800;font-size:12px';
        btn.onclick = () => box.remove();
        box.appendChild(btn);
        document.body.appendChild(box);
      }
    });
    window.close();
  });

  // ── Fill / Clear ─────────────────────────────────────────────────────────────
  document.getElementById('fill-btn').addEventListener('click', fillPage);
  document.getElementById('clear-btn').addEventListener('click', clearPage);
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function updatePhoneUrl(serverUrl, roomCode) {
  const url = `${serverUrl}/mobile.html?room=${roomCode}`;
  document.getElementById('phone-url-display').textContent = url;
}

// ── Fill page ──────────────────────────────────────────────────────────────────
async function fillPage() {
  const roomCode = await new Promise(r => chrome.storage.local.get({ roomCode: '' }, d => r(d.roomCode)));
  if (!roomCode) return;

  try {
    const res  = await fetch(`${DEFAULT_SERVER}/api/latest?room=${roomCode}`);
    const data = await res.json();
    if (!data.fields) { alert('No scan data. Scan a form first.'); return; }

    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async (fields) => {
        let filled = 0;

        // ── Expand single-letter abbreviations written on the paper form ────
        function expandGender(v) {
          const map = { m: 'Male', f: 'Female', male: 'Male', female: 'Female' };
          return map[(v || '').trim().toLowerCase()] || v;
        }
        function expandMarital(v) {
          const map = {
            m: 'Married', d: 'Divorced', w: 'Widowed', s: 'Single',
            married: 'Married', divorced: 'Divorced', widowed: 'Widowed', single: 'Single'
          };
          return map[(v || '').trim().toLowerCase()] || v;
        }

        // ── Set a text input (React-safe) ────────────────────────────────────
        function setInput(el, value) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, value); else el.value = value;
          ['input', 'change', 'blur'].forEach(e => el.dispatchEvent(new Event(e, { bubbles: true })));
        }

        // ── Set a <select> — tries exact, then prefix match ──────────────────
        function setSelect(select, value) {
          if (!value) return false;
          const v = value.trim().toLowerCase();
          const opt = [...select.options].find(o =>
            o.value.trim().toLowerCase() === v ||
            o.text.trim().toLowerCase()  === v ||
            o.text.trim().toLowerCase().startsWith(v) ||
            o.value.trim().toLowerCase().startsWith(v)
          );
          if (!opt) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
          if (setter) setter.call(select, opt.value); else select.value = opt.value;
          ['change', 'input', 'blur'].forEach(e => select.dispatchEvent(new Event(e, { bubbles: true })));
          return true;
        }

        // ── Find a <select> by checking if its options contain ALL given hints ─
        function findSelectByOptions(...hints) {
          const h = hints.map(v => v.toLowerCase());
          for (const select of document.querySelectorAll('select')) {
            // skip the empty placeholder option — 'kwara'.includes('') is always true
            const opts = [...select.options]
              .map(o => o.text.trim().toLowerCase())
              .filter(t => t.length > 0);
            if (opts.length === 0) continue;
            if (h.every(hint => opts.some(opt => opt.includes(hint)))) return select;
          }
          return null;
        }

        // ── Find a <select> by nearby label text (fallback) ──────────────────
        function findSelectByLabel(labelText) {
          const needle = labelText.trim().toLowerCase();
          for (const select of document.querySelectorAll('select')) {
            let node = select;
            for (let i = 0; i < 10; i++) {
              node = node.parentElement;
              if (!node) break;
              for (const el of node.querySelectorAll('label, p, span, div, h6, legend, th, td')) {
                if (el.contains(select)) continue;
                const t = el.textContent.trim().toLowerCase().replace(/[*:]/g, '');
                if (t === needle || t.startsWith(needle) || t.includes(needle)) return select;
              }
            }
          }
          return null;
        }

        // ── Text inputs ──────────────────────────────────────────────────────
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

        // ── Dropdowns — re-find each select right before setting it ────────────
        // React re-renders the form after each change, replacing DOM nodes.
        // Pre-caching references fails because they go stale after the first fill.
        // We re-query + wait 200ms between each so React has time to settle.
        const gender  = expandGender(fields['Gender (Sex)']);
        const marital = expandMarital(fields['Marital Status']);

        for (const [finder, value] of [
          [() => findSelectByOptions('male','female')     || findSelectByLabel('Gender'),         gender],
          [() => findSelectByOptions('married','single')  || findSelectByLabel('Marital Status'), marital],
          [() => findSelectByOptions('kwara')             || findSelectByLabel('State'),          'Kwara'],
          [() => findSelectByOptions('ilorin')            || findSelectByLabel('Location'),       'Ilorin'],
        ]) {
          if (!value) continue;
          await new Promise(r => setTimeout(r, 200)); // let React finish re-rendering
          const s = finder();
          if (s && setSelect(s, value)) filled++;
        }

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
              mSel.dispatchEvent(new Event('change', { bubbles: true }));
              if (ss) ss.call(ySel, String(yr)); else ySel.value = String(yr);
              ySel.dispatchEvent(new Event('change', { bubbles: true }));
              await new Promise(r => setTimeout(r, 300));
              const dayBtn = [...document.querySelectorAll('button')].find(b =>
                b.textContent.trim() === String(dy) && !b.disabled && !b.className.includes('outside')
              );
              if (dayBtn) { dayBtn.click(); filled++; }
            }
          }
        }

        document.getElementById('stf-toast')?.remove();
        const t = document.createElement('div');
        t.id = 'stf-toast';
        t.textContent = filled > 0 ? `✓ Filled ${filled} fields` : '⚠ No fields filled';
        Object.assign(t.style, {
          position:'fixed', bottom:'24px', right:'24px', zIndex:'2147483647',
          background: filled > 0 ? '#1e3a2a' : '#3a2e1a',
          border: `1.5px solid ${filled > 0 ? '#4ade80' : '#fbbf24'}`,
          color: filled > 0 ? '#4ade80' : '#fbbf24',
          padding:'12px 20px', borderRadius:'100px',
          fontSize:'14px', fontWeight:'700', fontFamily:'system-ui,sans-serif',
          boxShadow:'0 4px 24px rgba(0,0,0,.3)', pointerEvents:'none',
        });
        document.body.appendChild(t);
        setTimeout(() => { t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(() => t.remove(), 350); }, 3500);
      },
      args: [data.fields]
    });

    window.close();
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

// ── Clear page ─────────────────────────────────────────────────────────────────
async function clearPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        function setInput(el, value) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, value); else el.value = value;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur',   { bubbles: true }));
        }
        document.querySelectorAll('input[name]').forEach(el => setInput(el, ''));
        document.querySelectorAll('select').forEach(el => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
          if (setter) setter.call(el, ''); else el.value = '';
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
    });
  } catch(e) { alert('Clear error: ' + e.message); }
  window.close();
}

init();
