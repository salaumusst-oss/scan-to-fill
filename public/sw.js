// Minimal service worker — exists solely to make the PWA installable.
// No caching: all requests go to the network as normal.
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(clients.claim()));
