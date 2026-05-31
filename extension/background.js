const DEFAULT_SERVER = 'https://scan-to-fill.onrender.com';

async function getServerUrl() {
  return new Promise(resolve => {
    chrome.storage.local.get({ serverUrl: DEFAULT_SERVER }, d => resolve(d.serverUrl));
  });
}

// Badge: green dot = server reachable, red ! = not reachable
async function checkServer() {
  const serverUrl = await getServerUrl();
  try {
    await fetch(serverUrl + '/api/latest', { signal: AbortSignal.timeout(15000) });
    chrome.action.setBadgeText({ text: '●' });
    chrome.action.setBadgeBackgroundColor({ color: '#4ade80' });
  } catch {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f87171' });
  }
}

// Check every 2 minutes (Render free tier sleeps after 15 min of no traffic)
chrome.alarms.create('heartbeat', { periodInMinutes: 2 });
chrome.alarms.onAlarm.addListener(checkServer);
checkServer();
