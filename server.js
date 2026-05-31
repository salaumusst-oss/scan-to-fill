const express = require('express');
const multer  = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
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
    // On Render: set it in the Environment Variables dashboard
    console.error('   Set it in your Render dashboard → Environment tab.\n');
  } else {
    console.error('   Run: export ANTHROPIC_API_KEY=your_key_here\n');
  }
  process.exit(1);
}

const client = new Anthropic();

// Store latest scan per room — rooms are just short strings like "A1B2"
const scans = {};   // { roomCode: { fields, timestamp } }

// ── POST /api/upload ──────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const room = (req.body.room || 'default').trim().toUpperCase();
  try {
    const fields = await extractWithAI(req.file.buffer, req.file.mimetype);
    scans[room] = { fields, timestamp: Date.now() };
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
    console.log(`  Laptop: http://localhost:${PORT}/viewer.html`);
    console.log(`  Phone:  http://${ip}:${PORT}/mobile.html\n`);
  }
});
