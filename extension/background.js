const SERVER = 'http://localhost:3000';

// Badge: show server connection status
async function checkServer() {
  try {
    await fetch(SERVER + '/api/latest', { signal: AbortSignal.timeout(2000) });
    chrome.action.setBadgeText({ text: '●' });
    chrome.action.setBadgeBackgroundColor({ color: '#4ade80' });
  } catch {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f87171' });
  }
}
chrome.alarms.create('heartbeat', { periodInMinutes: 1 / 6 });
chrome.alarms.onAlarm.addListener(checkServer);
checkServer();

// Handle messages from popup
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'showWidget' && msg.tabId) {
    injectWidget(msg.tabId);
  }
});

async function injectWidget(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (serverUrl) => {
        // Remove existing widget
        document.getElementById('stf-floating-widget')?.remove();

        const widget = document.createElement('div');
        widget.id = 'stf-floating-widget';
        Object.assign(widget.style, {
          position: 'fixed', top: '80px', right: '20px',
          background: '#1a1a2e', border: '1px solid #2a2a45',
          borderRadius: '14px', padding: '14px',
          zIndex: '2147483647', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          minWidth: '170px', fontFamily: 'system-ui, -apple-system, sans-serif',
          userSelect: 'none',
        });

        widget.innerHTML = `
          <div id="stf-handle" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;cursor:move">
            <span style="color:#7eb8f7;font-size:12px;font-weight:800;letter-spacing:0.5px">📄 SCAN TO FILL</span>
            <button id="stf-x" style="background:none;border:none;color:#666;font-size:15px;cursor:pointer;padding:0 0 0 10px;line-height:1">✕</button>
          </div>
          <button id="stf-fill-btn" style="display:block;width:100%;padding:10px;background:#4ade80;color:#0f0f1a;border:none;border-radius:9px;font-size:13px;font-weight:800;cursor:pointer;margin-bottom:7px">▶ Fill Page</button>
          <button id="stf-clear-btn" style="display:block;width:100%;padding:10px;background:#2a2a45;color:#888;border:1px solid #3a3a55;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer">✕ Clear Page</button>
          <div id="stf-status" style="margin-top:10px;font-size:11px;color:#555;text-align:center;min-height:14px"></div>
        `;

        document.body.appendChild(widget);

        // Drag
        let dragging = false, ox = 0, oy = 0;
        document.getElementById('stf-handle').addEventListener('mousedown', e => {
          dragging = true;
          const r = widget.getBoundingClientRect();
          ox = e.clientX - r.left; oy = e.clientY - r.top;
          widget.style.right = 'auto';
          e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
          if (!dragging) return;
          widget.style.left = (e.clientX - ox) + 'px';
          widget.style.top  = (e.clientY - oy) + 'px';
        });
        document.addEventListener('mouseup', () => { dragging = false; });

        // Close
        document.getElementById('stf-x').onclick = () => widget.remove();

        // Helpers
        function setStatus(msg, color) {
          const s = document.getElementById('stf-status');
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
          const opt = [...select.options].find(o =>
            o.value.toLowerCase() === value.toLowerCase() ||
            o.text.toLowerCase()  === value.toLowerCase()
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

        // Fill
        document.getElementById('stf-fill-btn').onclick = async () => {
          setStatus('Fetching scan…', '#7eb8f7');
          try {
            const res = await fetch(serverUrl + '/api/latest');
            const data = await res.json();
            if (!data.fields) { setStatus('No scan yet', '#fbbf24'); return; }
            const fields = data.fields;
            let filled = 0;

            const textMap = [
              ['first_name',        fields['First Name']],
              ['last_name',         fields['Last Name']],
              ['phone_number',      fields['Patient Phone No.']],
              ['address',           fields['Address']],
              ['occupation',        fields['Occupation']],
              ['religion',          fields['Religion']],
              ['next_of_kin_phone', fields['Next of Kin Phone']],
            ];
            for (const [name, value] of textMap) {
              if (!value) continue;
              const el = document.querySelector(`input[name="${name}"]`);
              if (el) { setInput(el, value); filled++; }
            }

            for (const [label, value] of [['Gender', fields['Gender (Sex)']], ['Marital Status', fields['Marital Status']]]) {
              if (!value) continue;
              const s = findSelectByLabel(label);
              if (s && setSelectVal(s, value)) filled++;
            }

            const stateS = findSelectByLabel('State');
            if (stateS && setSelectVal(stateS, 'Kwara')) filled++;
            const locS = findSelectByLabel('Location');
            if (locS && setSelectVal(locS, 'Ilorin')) filled++;

            // DOB
            let targetYear = null, targetMonth = 0, targetDay = 1;
            if (fields['Date of Birth']) {
              const d = new Date(fields['Date of Birth']);
              if (!isNaN(d)) { targetYear = d.getFullYear(); targetMonth = d.getMonth(); targetDay = d.getDate(); }
            } else if (parseInt(fields['Age']) > 0) {
              targetYear = new Date().getFullYear() - parseInt(fields['Age']);
            }

            if (targetYear) {
              const dateBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Pick a date');
              if (dateBtn) {
                dateBtn.click();
                await new Promise(r => setTimeout(r, 400));
                const allSel = [...document.querySelectorAll('select')];
                const monthSel = allSel.find(s => s.options[0]?.value === '0' && s.options.length === 12);
                const yearSel  = allSel.find(s => s.options.length > 50 && !isNaN(s.options[0]?.value));
                if (monthSel && yearSel) {
                  const ss = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
                  if (ss) ss.call(monthSel, String(targetMonth)); else monthSel.value = String(targetMonth);
                  monthSel.dispatchEvent(new Event('change', { bubbles: true }));
                  if (ss) ss.call(yearSel, String(targetYear)); else yearSel.value = String(targetYear);
                  yearSel.dispatchEvent(new Event('change', { bubbles: true }));
                  await new Promise(r => setTimeout(r, 300));
                  const dayBtn = [...document.querySelectorAll('button')].find(b =>
                    b.textContent.trim() === String(targetDay) && !b.disabled && !b.className.includes('outside')
                  );
                  if (dayBtn) { dayBtn.click(); filled++; }
                }
              }
            }

            setStatus(filled > 0 ? `✓ ${filled} fields filled` : '⚠ Nothing filled', filled > 0 ? '#4ade80' : '#fbbf24');
          } catch(e) {
            setStatus('Error: ' + e.message, '#f87171');
          }
        };

        // Clear
        document.getElementById('stf-clear-btn').onclick = () => {
          document.querySelectorAll('input[name]').forEach(el => setInput(el, ''));
          document.querySelectorAll('select').forEach(el => {
            const ss = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
            if (ss) ss.call(el, ''); else el.value = '';
            el.dispatchEvent(new Event('change', { bubbles: true }));
          });
          setStatus('Cleared', '#888');
        };
      },
      args: [SERVER]
    });
  } catch(e) {
    console.error('Widget inject error:', e);
  }
}
