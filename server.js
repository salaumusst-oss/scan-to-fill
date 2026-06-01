const express  = require('express');
const multer   = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const archiver = require('archiver');
const os   = require('os');
const path = require('path');
const fs   = require('fs');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\n❌ ANTHROPIC_API_KEY is not set.');
  console.error(process.env.NODE_ENV === 'production'
    ? '   Set it in your Render dashboard → Environment tab.\n'
    : '   Run: export ANTHROPIC_API_KEY=your_key_here\n');
  process.exit(1);
}

const client = new Anthropic();

// ── Version ────────────────────────────────────────────────────────────────────
const EXTENSION_VERSION = '1.4.0';
app.get('/api/version', (req, res) => res.json({ version: EXTENSION_VERSION }));

// ── SSE: push events to website clients the instant a scan arrives ─────────────
const sseClients = {};  // { roomCode: [res, ...] }

function sseNotify(room, event, data) {
  (sseClients[room] || []).forEach(res => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  });
}

app.get('/api/stream', (req, res) => {
  const room = (req.query.room || '').trim().toUpperCase();
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');

  if (!sseClients[room]) sseClients[room] = [];
  sseClients[room].push(res);

  // Ping every 20s — keeps Render from closing the idle connection
  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(keepAlive); }
  }, 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients[room] = sseClients[room].filter(c => c !== res);
  });
});

// ── In-memory state ────────────────────────────────────────────────────────────
//
// rooms: { roomCode: {
//   unopened : [scanEntry, ...]   newest-first, max 20
//   opened   : [scanEntry, ...]   newest-first
//   selected : scanEntry | null   the scan the laptop will fill next
//   laptop   : { session, name, lastSeen } | null
//   phones   : [{ session, name, lastSeen }, ...]   unlimited
// }}
//
// scanEntry: { id, fields, timestamp, scannerName }

const rooms = {};

function getRoom(code) {
  if (!rooms[code]) rooms[code] = {
    unopened: [], opened: [], selected: null,
    laptop: null, phones: []
  };
  return rooms[code];
}

function isOnline(device) {
  if (!device) return false;
  return (Date.now() - device.lastSeen) < 3 * 60 * 1000;
}

function parseDevice(ua) {
  if (!ua) return 'Unknown device';
  if (/iPhone/i.test(ua))    return 'iPhone';
  if (/iPad/i.test(ua))      return 'iPad';
  if (/Android/i.test(ua))   return 'Android phone';
  if (/Mac OS X/i.test(ua))  return 'Mac';
  if (/Windows/i.test(ua))   return 'Windows PC';
  if (/Linux/i.test(ua))     return 'Linux PC';
  return 'Unknown device';
}

function makeScanId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
}

// ── Persistence: save/load state to disk so restarts don't lose data ──────────
const DATA_FILE = path.join(__dirname, 'data', 'state.json');

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (saved.users) Object.assign(users, saved.users);
    if (saved.rooms) {
      for (const [code, r] of Object.entries(saved.rooms)) {
        rooms[code] = {
          unopened: r.unopened || [],
          opened:   r.opened   || [],
          selected: r.selected || null,
          laptop:   null,   // devices re-register via heartbeat
          phones:   [],
        };
      }
    }
    console.log(`✅ State loaded — ${Object.keys(users).length} users, ${Object.keys(rooms).length} rooms`);
  } catch {
    console.log('No saved state found — starting fresh.');
  }
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      // Strip device connections — they're ephemeral and re-register via heartbeat
      const roomsToSave = {};
      for (const [code, r] of Object.entries(rooms)) {
        roomsToSave[code] = { unopened: r.unopened, opened: r.opened, selected: r.selected };
      }
      fs.writeFileSync(DATA_FILE, JSON.stringify({ users, rooms: roomsToSave }));
    } catch (e) { console.error('Save failed:', e.message); }
  }, 500); // debounce — batch rapid changes into one write
}

// ── Users: name → persistent room code ────────────────────────────────────────
const users = {};  // { normalizedName: { room, displayName } }

function getUserRoom(name) {
  const key = name.trim().toLowerCase();
  if (!users[key]) {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code;
    const existing = new Set(Object.values(users).map(u => u.room));
    do {
      code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
    } while (existing.has(code));
    users[key] = { room: code, displayName: name.trim() };
    console.log(`[user] "${name}" → room ${code}`);
  }
  return users[key].room;
}

loadState(); // ← restore state from disk on startup

app.get('/api/user-room', (req, res) => {
  const name = (req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const isNew = !users[name.trim().toLowerCase()];
  const room  = getUserRoom(name);
  if (isNew) scheduleSave(); // new user created — persist immediately
  res.json({ room });
});

app.get('/api/room-name', (req, res) => {
  const room  = (req.query.room || '').trim().toUpperCase();
  const entry = Object.values(users).find(u => u.room === room);
  res.json({ name: entry ? entry.displayName : null });
});

// ── POST /api/connect ─────────────────────────────────────────────────────────
// Laptop: one per room (enforced). Phones: unlimited — just register.
app.post('/api/connect', (req, res) => {
  const { room: rawRoom, session, type, name } = req.body;
  if (!rawRoom || !session || !type) return res.status(400).json({ error: 'Missing fields' });

  const room = rawRoom.trim().toUpperCase();
  const r    = getRoom(room);
  const deviceName = name || parseDevice(req.headers['user-agent']);

  if (type === 'phone') {
    // Update existing session or add new phone
    const existing = r.phones.find(p => p.session === session);
    if (existing) {
      existing.name = deviceName;
      existing.lastSeen = Date.now();
    } else {
      r.phones.push({ session, name: deviceName, lastSeen: Date.now() });
      console.log(`[${room}] phone connected: ${deviceName}`);
    }
    return res.json({ ok: true, name: deviceName });
  }

  // Laptop
  if (r.laptop && r.laptop.session !== session && isOnline(r.laptop)) {
    return res.json({ ok: false, error: 'Room taken', takenBy: r.laptop.name });
  }
  r.laptop = { session, name: deviceName, lastSeen: Date.now() };
  console.log(`[${room}] laptop connected: ${deviceName}`);
  res.json({ ok: true, name: deviceName });
});

// ── POST /api/heartbeat ───────────────────────────────────────────────────────
app.post('/api/heartbeat', (req, res) => {
  const { room: rawRoom, session, type } = req.body;
  if (!rawRoom || !session) return res.status(400).json({ error: 'Missing fields' });

  const room = rawRoom.trim().toUpperCase();
  const r    = getRoom(room);

  if (type === 'phone') {
    const phone = r.phones.find(p => p.session === session);
    if (phone) phone.lastSeen = Date.now();
  } else if (r.laptop && r.laptop.session === session) {
    r.laptop.lastSeen = Date.now();
  }
  res.json({ ok: true });
});

// ── POST /api/disconnect ──────────────────────────────────────────────────────
app.post('/api/disconnect', (req, res) => {
  const { room: rawRoom, session, type } = req.body;
  if (!rawRoom || !session) return res.status(400).json({ error: 'Missing fields' });

  const room = rawRoom.trim().toUpperCase();
  const r    = getRoom(room);

  if (type === 'phone') {
    const phone = r.phones.find(p => p.session === session);
    if (phone) { phone.lastSeen = 0; console.log(`[${room}] phone disconnected: ${phone.name}`); }
  } else if (r.laptop && r.laptop.session === session) {
    r.laptop.lastSeen = 0;
    console.log(`[${room}] laptop disconnected`);
  }
  res.json({ ok: true });
});

// ── GET /api/room-status?room=XXXX ────────────────────────────────────────────
app.get('/api/room-status', (req, res) => {
  const room = (req.query.room || 'default').trim().toUpperCase();
  const r = getRoom(room);
  res.json({
    laptop: r.laptop ? { name: r.laptop.name, online: isOnline(r.laptop) } : null,
    phones: r.phones.map(p => ({ name: p.name, online: isOnline(p) })),
  });
});

// ── POST /api/upload ──────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const room = (req.body.room || 'default').trim().toUpperCase();
  try {
    const fields = await extractWithAI(req.file.buffer, req.file.mimetype);
    const r      = getRoom(room);

    // Determine which phone is sending (match session if provided)
    const senderSession = req.body.session || '';
    const phone = r.phones.find(p => p.session === senderSession);
    const scannerName = phone ? phone.name : parseDevice(req.headers['user-agent']);

    const entry = { id: makeScanId(), fields, timestamp: Date.now(), scannerName };

    // Add to unopened (newest first), cap at 20
    r.unopened.unshift(entry);
    if (r.unopened.length > 20) r.unopened = r.unopened.slice(0, 20);

    console.log(`[${room}] Scan from ${scannerName}:`, JSON.stringify(fields, null, 2));

    scheduleSave(); // persist the new scan
    sseNotify(room, 'new-scan', { unopened: r.unopened, opened: r.opened, selected: r.selected });
    res.json({ ok: true, fields, id: entry.id });
  } catch (err) {
    console.error(`[${room}] AI error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/scans?room=XXXX ──────────────────────────────────────────────────
// Returns the full scan queue for a room — used by the website and extension.
app.get('/api/scans', (req, res) => {
  const room = (req.query.room || 'default').trim().toUpperCase();
  const r = getRoom(room);
  res.json({
    unopened: r.unopened,
    opened:   r.opened,
    selected: r.selected,
  });
});

// ── POST /api/scan/select ─────────────────────────────────────────────────────
// Select a scan to fill. Moves it from unopened → opened if needed.
app.post('/api/scan/select', (req, res) => {
  const { room: rawRoom, id } = req.body;
  if (!rawRoom || !id) return res.status(400).json({ error: 'Missing fields' });

  const room = rawRoom.trim().toUpperCase();
  const r    = getRoom(room);

  // Check unopened first
  const unopenedIdx = r.unopened.findIndex(s => s.id === id);
  if (unopenedIdx !== -1) {
    const [scan] = r.unopened.splice(unopenedIdx, 1);
    scan.openedAt = Date.now();
    r.opened.unshift(scan);
    if (r.opened.length > 50) r.opened = r.opened.slice(0, 50);
    r.selected = scan;
    scheduleSave();
    console.log(`[${room}] Selected scan ${id} (from unopened)`);
    return res.json({ ok: true, scan });
  }

  // Check opened (re-select)
  const openedScan = r.opened.find(s => s.id === id);
  if (openedScan) {
    r.selected = openedScan;
    scheduleSave();
    console.log(`[${room}] Re-selected scan ${id} (from opened)`);
    return res.json({ ok: true, scan: openedScan });
  }

  res.status(404).json({ error: 'Scan not found' });
});

// ── GET /api/latest?room=XXXX ─────────────────────────────────────────────────
// Returns the SELECTED scan — this is what the extension fills.
app.get('/api/latest', (req, res) => {
  const room = (req.query.room || 'default').trim().toUpperCase();
  const r = getRoom(room);
  res.json(r.selected || { fields: null, timestamp: 0 });
});

// ── GET /download/extension ───────────────────────────────────────────────────
app.get('/download/extension', (req, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="scan-to-fill-extension.zip"');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => res.status(500).send(err.message));
  archive.pipe(res);
  archive.directory(path.join(__dirname, 'extension'), 'scan-to-fill-extension');
  archive.finalize();
});

// ── Claude AI extraction ───────────────────────────────────────────────────────
async function extractWithAI(buffer, mimeType) {
  const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const mediaType  = validTypes.includes(mimeType) ? mimeType : 'image/jpeg';

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
        { type: 'text', text: `This is an NCNMO Medical Mission patient intake form. Read all the handwritten values filled in on the form.

Return ONLY a JSON object with these exact keys — use empty string "" if a field is blank or unreadable:
{
  "First Name": "",
  "Last Name": "",
  "Gender (Sex)": "",
  "Age": "",
  "Date of Birth": "",
  "Occupation": "",
  "Marital Status": "",
  "Address": "",
  "Religion": "",
  "Next of Kin Phone": "",
  "Patient Phone No.": ""
}

Rules:
- The "Name" line is a full name — split into First Name and Last Name on the first space. If one word, put it all in First Name.
- Gender: the form may say "M" or "F" or write it in full. Always return exactly "Male" or "Female".
- Marital Status: the form may use abbreviations — "M" or "Married", "D" or "Divorced", "W" or "Widowed", "S" or "Single". Always return the full word: "Married", "Divorced", "Widowed", or "Single".
- Age should be just the number (e.g. "45").
- Date of Birth: only fill if an actual date is explicitly written on the form (format as YYYY-MM-DD). If only age is written, leave this empty.
- Return only the JSON, no other text.` }
      ]
    }]
  });

  const text  = response.content[0].text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse AI response');
  return JSON.parse(match[0]);
}

// ── Start ──────────────────────────────────────────────────────────────────────
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of ['en0', 'en1', 'wlan0', 'wlan1']) {
    const iface = (ifaces[name] || []).find(i => i.family === 'IPv4' && !i.internal);
    if (iface) return iface.address;
  }
  for (const list of Object.values(ifaces))
    for (const i of list)
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  if (process.env.NODE_ENV === 'production') {
    console.log(`✅ Scan to Fill server running on port ${PORT}`);
  } else {
    const ip = getLocalIP();
    console.log('\n╔══════════════════════════════════╗');
    console.log('║       Scan to Fill — Ready       ║');
    console.log('╚══════════════════════════════════╝\n');
    console.log(`  Web:   http://localhost:${PORT}`);
    console.log(`  Phone: http://${ip}:${PORT}/mobile.html\n`);
  }
});
