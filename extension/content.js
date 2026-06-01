// content.js — runs on every page in ISOLATED world.
// On the NCNMO patient form, polls for a pending auto-fill and asks
// background.js to execute it in MAIN world (where React lives).

const STF_SERVER = 'https://scan-to-fill.onrender.com';
const NCNMO_HOST = 'ncnmoplatformemr.axocheck.com';

if (location.hostname === NCNMO_HOST) {
  chrome.storage.local.get({ roomCode: '' }, ({ roomCode }) => {
    if (roomCode) startPoll(roomCode);
  });
}

function startPoll(roomCode) {
  setInterval(async () => {
    try {
      const res  = await fetch(`${STF_SERVER}/api/pending-fill?room=${roomCode}`);
      const data = await res.json();
      if (!data.fields) return;

      // Ask background to fill in MAIN world and navigate when done
      chrome.runtime.sendMessage({ type: 'auto-fill', fields: data.fields });
    } catch {}
  }, 1500);
}
