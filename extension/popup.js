// ── Defaults ──────────────────────────────────────────────────────────────────
const DEFAULT_SERVER = 'https://scan-to-fill.onrender.com';

function randomRoom() {
  return Math.random().toString(36).substr(2, 4).toUpperCase();
}

// ── Load saved settings (server URL + room code) ──────────────────────────────
async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get({ roomCode: '' }, data => {
      if (!data.roomCode) {
        const code = randomRoom();
        chrome.storage.local.set({ roomCode: code });
        data.roomCode = code;
      }
      // Server URL is always the cloud — never read from storage
      resolve({ serverUrl: DEFAULT_SERVER, roomCode: data.roomCode });
    });
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const { serverUrl, roomCode } = await getSettings();

  const dot         = document.getElementById('dot');
  const statusText  = document.getElementById('status-text');
  const fieldsSection = document.getElementById('fields-section');
  const fillBtn     = document.getElementById('fill-btn');

  // Populate settings panel
  document.getElementById('input-room').value = roomCode;
  updatePhoneUrl(serverUrl, roomCode);

  try {
    const res  = await fetch(`${serverUrl}/api/latest?room=${roomCode}`, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();

    dot.classList.remove('pulse');
    dot.classList.add('ok');
    statusText.textContent = `Connected · Room: ${roomCode}`;

    if (data.fields && Object.values(data.fields).some(v => v)) {
      fillBtn.style.display = 'block';
      const entries = Object.entries(data.fields).filter(([, v]) => v);
      fieldsSection.innerHTML = `
        <div class="section-label">Last scan</div>
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
      fieldsSection.innerHTML = `<p class="empty">No scan yet.<br>Scan a patient form on your phone.</p>`;
    }
  } catch {
    dot.classList.remove('pulse');
    statusText.textContent = 'Server not running';
    fieldsSection.innerHTML = `<p class="empty" style="color:#f87171">Start the server, or check Settings.</p>`;
  }
}

// ── Fill page ─────────────────────────────────────────────────────────────────
async function fillPage() {
  const { serverUrl, roomCode } = await getSettings();
  try {
    const res  = await fetch(`${serverUrl}/api/latest?room=${roomCode}`);
    const data = await res.json();
    if (!data.fields) { alert('No scan data. Scan a form first.'); return; }

    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async (fields) => {
        let filled = 0;

        function setInput(el, value) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, value); else el.value = value;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur',   { bubbles: true }));
        }
        function setSelect(select, value) {
          const opt = [...select.options].find(o =>
            o.value.toLowerCase() === value.toLowerCase() || o.text.toLowerCase() === value.toLowerCase()
          );
          if (!opt) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
          if (setter) setter.call(select, opt.value); else select.value = opt.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        function findSelectByLabel(labelText) {
          for (const select of document.querySelectorAll('select')) {
            let node = select;
            for (let i = 0; i < 8; i++) {
              node = node.parentElement;
              if (!node) break;
              for (const el of node.querySelectorAll('label, p, span')) {
                if (!el.children.length && el.textContent.trim().toLowerCase() === labelText.toLowerCase()) return select;
              }
            }
          }
          return null;
        }

        // Text inputs
        for (const [name, value] of [
          ['first_name', fields['First Name']], ['last_name', fields['Last Name']],
          ['phone_number', fields['Patient Phone No.']], ['address', fields['Address']],
          ['occupation', fields['Occupation']], ['religion', fields['Religion']],
          ['next_of_kin_phone', fields['Next of Kin Phone']],
        ]) {
          if (!value) continue;
          const el = document.querySelector(`input[name="${name}"]`);
          if (el) { setInput(el, value); filled++; }
        }

        // Dropdowns
        for (const [label, value] of [['Gender', fields['Gender (Sex)']], ['Marital Status', fields['Marital Status']]]) {
          if (!value) continue;
          const s = findSelectByLabel(label);
          if (s && setSelect(s, value)) filled++;
        }

        // Hardcoded: State = Kwara, Location = Ilorin
        const stateS = findSelectByLabel('State');
        if (stateS && setSelect(stateS, 'Kwara')) filled++;
        const locS = findSelectByLabel('Location');
        if (locS && setSelect(locS, 'Ilorin')) filled++;

        // Date of Birth
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

        // Toast
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

// ── Clear form ────────────────────────────────────────────────────────────────
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

// ── Settings panel ────────────────────────────────────────────────────────────
function updatePhoneUrl(serverUrl, roomCode) {
  const url = `${serverUrl}/mobile.html?room=${roomCode}`;
  document.getElementById('phone-url-display').textContent = url;
}

document.getElementById('setup-btn').addEventListener('click', () => {
  const panel = document.getElementById('settings-panel');
  panel.classList.toggle('open');
  document.getElementById('setup-btn').textContent =
    panel.classList.contains('open') ? '▲ Hide Settings' : '⚙️ Settings';
});

document.getElementById('save-btn').addEventListener('click', () => {
  const roomCode = document.getElementById('input-room').value.trim().toUpperCase() || randomRoom();
  chrome.storage.local.set({ roomCode }, () => {
    document.getElementById('input-room').value = roomCode;
    updatePhoneUrl(DEFAULT_SERVER, roomCode);
    document.getElementById('save-btn').textContent = '✓ Saved!';
    setTimeout(() => { document.getElementById('save-btn').textContent = 'Save'; }, 1500);
    init();
  });
});

document.getElementById('input-room').addEventListener('input', () => {
  const r = document.getElementById('input-room').value.trim().toUpperCase();
  updatePhoneUrl(DEFAULT_SERVER, r);
});

document.getElementById('copy-link').addEventListener('click', () => {
  const url = document.getElementById('phone-url-display').textContent;
  navigator.clipboard.writeText(url).then(() => {
    document.getElementById('copy-link').textContent = '✓ Copied!';
    setTimeout(() => { document.getElementById('copy-link').textContent = 'Copy link'; }, 1500);
  });
});

// ── Wire up buttons ───────────────────────────────────────────────────────────
document.getElementById('fill-btn').addEventListener('click', fillPage);
document.getElementById('clear-btn').addEventListener('click', clearPage);

function openSetup() {}   // kept for any leftover references
function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

init();
