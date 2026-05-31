(function () {
  const SERVER = 'https://scan-to-fill.onrender.com';

  // Remove any previous instance
  document.getElementById('stf-host')?.remove();
  document.getElementById('stf-floating-widget')?.remove();

  // Host element — use setProperty with 'important' so page CSS can't override
  const host = document.createElement('div');
  host.id = 'stf-host';
  host.style.setProperty('position',   'fixed',       'important');
  host.style.setProperty('top',        '80px',        'important');
  host.style.setProperty('right',      '20px',        'important');
  host.style.setProperty('z-index',    '2147483647',  'important');
  host.style.setProperty('width',      'auto',        'important');
  host.style.setProperty('height',     'auto',        'important');
  host.style.setProperty('margin',     '0',           'important');
  host.style.setProperty('padding',    '0',           'important');
  host.style.setProperty('border',     'none',        'important');
  host.style.setProperty('background', 'transparent', 'important');
  host.style.setProperty('display',    'block',       'important');

  // Shadow DOM isolates the widget from the page's CSS completely
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      *, *::before, *::after {
        box-sizing: border-box; margin: 0; padding: 0;
        font-family: system-ui, -apple-system, sans-serif;
      }
      #widget {
        background: #1a1a2e;
        border: 1px solid #2a2a45;
        border-radius: 14px;
        padding: 14px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        min-width: 180px;
        user-select: none;
      }
      #handle {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
        cursor: move;
      }
      #title { color: #7eb8f7; font-size: 12px; font-weight: 800; letter-spacing: 0.5px; }
      #close-btn {
        all: unset;
        color: #666;
        font-size: 18px;
        cursor: pointer;
        padding: 0 0 0 10px;
        line-height: 1;
      }
      #close-btn:hover { color: #aaa; }
      .action-btn {
        all: unset;
        display: block;
        width: 100%;
        padding: 10px;
        border-radius: 9px;
        font-size: 13px;
        font-weight: 800;
        cursor: pointer;
        margin-bottom: 7px;
        text-align: center;
      }
      #fill-btn  { background: #4ade80; color: #0f0f1a; }
      #fill-btn:hover  { background: #22c55e; }
      #clear-btn { background: #2a2a45; color: #888; outline: 1px solid #3a3a55; margin-bottom: 0; }
      #clear-btn:hover { background: #333; }
      #status { margin-top: 10px; font-size: 11px; color: #555; text-align: center; min-height: 14px; }
    </style>
    <div id="widget">
      <div id="handle">
        <span id="title">📄 SCAN TO FILL</span>
        <button id="close-btn" type="button">✕</button>
      </div>
      <button class="action-btn" id="fill-btn"  type="button">▶ Fill Page</button>
      <button class="action-btn" id="clear-btn" type="button">✕ Clear Page</button>
      <div id="status"></div>
    </div>
  `;

  document.body.appendChild(host);

  // ── Helpers ────────────────────────────────────────────────────────────────

  function setStatus(msg, color) {
    const s = shadow.getElementById('status');
    if (s) { s.textContent = msg; s.style.color = color || '#555'; }
  }

  function setInput(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
  }

  function setSelectVal(select, value) {
    const v = value.trim().toLowerCase();
    const opt = [...select.options].find(o =>
      o.value.toLowerCase() === v || o.text.toLowerCase() === v
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

  // ── Close ──────────────────────────────────────────────────────────────────
  shadow.getElementById('close-btn').addEventListener('click', () => host.remove());

  // ── Drag ───────────────────────────────────────────────────────────────────
  let dragging = false, ox = 0, oy = 0;
  shadow.getElementById('handle').addEventListener('mousedown', e => {
    dragging = true;
    const r = host.getBoundingClientRect();
    ox = e.clientX - r.left;
    oy = e.clientY - r.top;
    host.style.setProperty('right', 'auto', 'important');
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    host.style.setProperty('left', (e.clientX - ox) + 'px', 'important');
    host.style.setProperty('top',  (e.clientY - oy) + 'px', 'important');
  });
  document.addEventListener('mouseup', () => { dragging = false; });

  // ── Fill ───────────────────────────────────────────────────────────────────
  shadow.getElementById('fill-btn').addEventListener('click', async () => {
    setStatus('Fetching…', '#7eb8f7');
    try {
      const res  = await fetch(SERVER + '/api/latest');
      const data = await res.json();
      if (!data.fields) { setStatus('No scan yet', '#fbbf24'); return; }
      const f = data.fields;
      let filled = 0;

      for (const [name, value] of [
        ['first_name',        f['First Name']],
        ['last_name',         f['Last Name']],
        ['phone_number',      f['Patient Phone No.']],
        ['address',           f['Address']],
        ['occupation',        f['Occupation']],
        ['religion',          f['Religion']],
        ['next_of_kin_phone', f['Next of Kin Phone']],
      ]) {
        if (!value) continue;
        const el = document.querySelector(`input[name="${name}"]`);
        if (el) { setInput(el, value); filled++; }
      }

      for (const [label, value] of [
        ['Gender',         f['Gender (Sex)']],
        ['Marital Status', f['Marital Status']],
      ]) {
        if (!value) continue;
        const s = findSelectByLabel(label);
        if (s && setSelectVal(s, value)) filled++;
      }

      const stateS = findSelectByLabel('State');
      if (stateS && setSelectVal(stateS, 'Kwara')) filled++;
      const locS = findSelectByLabel('Location');
      if (locS && setSelectVal(locS, 'Ilorin')) filled++;

      // DOB: prefer explicit date, fall back to age → Jan 1 of birth year
      let yr = null, mo = 0, dy = 1;
      if (f['Date of Birth']) {
        const d = new Date(f['Date of Birth']);
        if (!isNaN(d)) { yr = d.getFullYear(); mo = d.getMonth(); dy = d.getDate(); }
      } else if (parseInt(f['Age']) > 0) {
        yr = new Date().getFullYear() - parseInt(f['Age']);
      }

      if (yr) {
        const dateBtn = [...document.querySelectorAll('button')].find(
          b => b.textContent.trim() === 'Pick a date'
        );
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

      setStatus(
        filled > 0 ? `✓ ${filled} fields filled` : '⚠ Nothing filled',
        filled > 0 ? '#4ade80' : '#fbbf24'
      );
    } catch (e) {
      setStatus('Error: ' + e.message, '#f87171');
    }
  });

  // ── Clear ──────────────────────────────────────────────────────────────────
  shadow.getElementById('clear-btn').addEventListener('click', () => {
    document.querySelectorAll('input[name]').forEach(el => setInput(el, ''));
    document.querySelectorAll('select').forEach(el => {
      const ss = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      if (ss) ss.call(el, ''); else el.value = '';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    setStatus('Cleared', '#888');
  });

})();
