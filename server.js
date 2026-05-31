const express  = require('express');
const multer   = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const archiver = require('archiver');
const os   = require('os');
const path = require('path');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS — allow Chrome extension and any origin to reach the server
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\n❌ ANTHROPIC_API_KEY is not set.');
  if (process.env.NODE_ENV === 'production') {
    console.error('   Set it in your Render dashboard → Environment tab.\n');
  } else {
    console.error('   Run: export ANTHROPIC_API_KEY=your_key_here\n');
  }
  process.exit(1);
}

const client = new Anthropic();

// ── In-memory store ────────────────────────────────────────────────────────────
// scans: latest scan per room (for fast polling)
const scans = {};  // { roomCode: { fields, timestamp } }

// rooms: full state per room — history + device connections
const rooms = {};  // { roomCode: { history: [...], laptop: {...}, phone: {...} } }

// users: persistent name → room code mapping
const users = {};  // { normalizedName: roomCode }

function getUserRoom(name) {
  const key = name.trim().toLowerCase();
  if (!users[key]) {
    // Generate a unique random 4-letter code
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code;
    const existing = new Set(Object.values(users));
    do {
      code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
    } while (existing.has(code));
    users[key] = code;
    console.log(`[user] "${name}" → room ${code}`);
  }
  return users[key];
}

function getRoom(code) {
  if (!rooms[code]) rooms[code] = { history: [], laptop: null, phone: null };
  return rooms[code];
}

// Device is "online" if it sent a heartbeat within the last 3 minutes
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

// ── GET /api/user-room?name=NAME ──────────────────────────────────────────────
// Returns (and creates if new) a persistent room code for this person.
app.get('/api/user-room', (req, res) => {
  const name = (req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  res.json({ room: getUserRoom(name) });
});

// ── POST /api/connect ─────────────────────────────────────────────────────────
// Called by laptop (extension) and phone when they first connect to a room.
// Enforces one laptop + one phone per room.
app.post('/api/connect', (req, res) => {
  const { room: rawRoom, session, type, name } = req.body;
  if (!rawRoom || !session || !type) return res.status(400).json({ error: 'Missing fields' });

  const room = rawRoom.trim().toUpperCase();
  const r    = getRoom(room);
  const slot = type === 'phone' ? 'phone' : 'laptop';
  const curr = r[slot];

  // Reject if slot is already claimed by a different session that's still online
  if (curr && curr.session !== session && isOnline(curr)) {
    return res.json({ ok: false, error: 'Room taken', takenBy: curr.name });
  }

  const deviceName = name || parseDevice(req.headers['user-agent']);
  r[slot] = { session, name: deviceName, lastSeen: Date.now() };
  console.log(`[${room}] ${slot} connected: ${deviceName}`);
  res.json({ ok: true, name: deviceName });
});

// ── POST /api/disconnect ──────────────────────────────────────────────────────
// Called (via sendBeacon) when a device leaves. Marks it offline immediately.
app.post('/api/disconnect', (req, res) => {
  const { room: rawRoom, session, type } = req.body;
  if (!rawRoom || !session) return res.status(400).json({ error: 'Missing fields' });

  const room = rawRoom.trim().toUpperCase();
  const r    = getRoom(room);
  const slot = type === 'phone' ? 'phone' : 'laptop';

  if (r[slot] && r[slot].session === session) {
    r[slot].lastSeen = 0; // immediately offline
    console.log(`[${room}] ${slot} disconnected`);
  }
  res.json({ ok: true });
});

// ── POST /api/heartbeat ───────────────────────────────────────────────────────
// Keep a device's "online" status alive. Call every ~60 s.
app.post('/api/heartbeat', (req, res) => {
  const { room: rawRoom, session, type } = req.body;
  if (!rawRoom || !session) return res.status(400).json({ error: 'Missing fields' });

  const room = rawRoom.trim().toUpperCase();
  const r    = getRoom(room);
  const slot = type === 'phone' ? 'phone' : 'laptop';

  if (r[slot] && r[slot].session === session) {
    r[slot].lastSeen = Date.now();
  }
  res.json({ ok: true });
});

// ── GET /api/history?room=XXXX ────────────────────────────────────────────────
// Returns the last 10 scans for the room.
app.get('/api/history', (req, res) => {
  const room = (req.query.room || 'default').trim().toUpperCase();
  res.json({ history: getRoom(room).history });
});

// ── GET /api/room-status?room=XXXX ────────────────────────────────────────────
// Returns connected-device info for the room.
app.get('/api/room-status', (req, res) => {
  const room = (req.query.room || 'default').trim().toUpperCase();
  const r = getRoom(room);
  res.json({
    laptop: r.laptop ? { name: r.laptop.name, online: isOnline(r.laptop) } : null,
    phone:  r.phone  ? { name: r.phone.name,  online: isOnline(r.phone)  } : null,
  });
});

// ── POST /api/upload ──────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const room = (req.body.room || 'default').trim().toUpperCase();
  try {
    const fields = await extractWithAI(req.file.buffer, req.file.mimetype);
    const entry  = { fields, timestamp: Date.now() };
    scans[room]  = entry;

    // Prepend to history, keep last 10
    const r = getRoom(room);
    r.history.unshift(entry);
    if (r.history.length > 10) r.history = r.history.slice(0, 10);

    console.log(`[${room}] Scan received:`, JSON.stringify(fields, null, 2));
    res.json({ ok: true, fields });
  } catch (err) {
    console.error(`[${room}] AI error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/latest?room=XXXX ─────────────────────────────────────────────────
app.get('/api/latest', (req, res) => {
  const room = (req.query.room || 'default').trim().toUpperCase();
  res.json(scans[room] || { fields: null, timestamp: 0 });
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

// ── Claude AI field extraction ─────────────────────────────────────────────────
async function extractWithAI(buffer, mimeType) {
  const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const mediaType  = validTypes.includes(mimeType) ? mimeType : 'image/jpeg';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') }
        },
        {
          type: 'text',
          text: `This is an NCNMO Medical Mission patient intake form. Read all the handwritten values filled in on the form.

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
- Gender must be exactly "Male" or "Female" (capitalised).
- Marital Status must be exactly one of: "Single", "Married", "Divorced", "Widowed".
- Age should be just the number (e.g. "45").
- Date of Birth: only fill if an actual date is explicitly written on the form (format as YYYY-MM-DD). If only age is written, leave this empty.
- Return only the JSON, no other text.`
        }
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
