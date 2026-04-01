require('dotenv').config();
const express = require('express');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3009;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// ─── Energy factors (must match client-side) ───────────────────────────────

const CATEGORIES = [
  { id: 'ai',     factor: 0.003,  max: 5000 },
  { id: 'google', factor: 0.0003, max: 10000 },
  { id: 'video',  factor: 0.150,  max: 168 },
  { id: 'calls',  factor: 0.150,  max: 168 },
  { id: 'music',  factor: 0.020,  max: 168 },
  { id: 'cloud',  factor: 0.060,  max: 500 },
];

// ─── Session state ──────────────────────────────────────────────────────────

let session = {
  submissions: {},
  qrSvg: null,
  qrUrl: null,
};

// ─── Auth middleware ────────────────────────────────────────────────────────

function requirePin(req, res, next) {
  if (req.headers['x-admin-pin'] !== ADMIN_PIN) {
    return res.status(401).json({ error: 'Invalid PIN' });
  }
  next();
}

// ─── Public API ─────────────────────────────────────────────────────────────

app.post('/api/submit', (req, res) => {
  const { visitorId, ai, google, video, calls, music, cloud } = req.body;
  if (!visitorId) return res.status(400).json({ error: 'Missing visitorId' });

  // Server-side validation and recalculation
  const inputs = { ai, google, video, calls, music, cloud };
  const cleaned = {};
  let totalKwh = 0;

  for (const cat of CATEGORIES) {
    const raw = parseFloat(inputs[cat.id]);
    const val = isNaN(raw) || raw < 0 ? 0 : Math.min(raw, cat.max);
    cleaned[cat.id] = val;
    totalKwh += val * cat.factor;
  }

  if (totalKwh === 0) return res.status(400).json({ error: 'All values are zero' });

  session.submissions[visitorId] = {
    ...cleaned,
    totalKwh: Math.round(totalKwh * 1000) / 1000,
    timestamp: new Date().toISOString(),
  };

  res.json({ ok: true });
});

app.get('/api/state', (req, res) => {
  const subs = Object.values(session.submissions);
  const count = subs.length;

  if (count === 0) {
    return res.json({
      submissionCount: 0,
      classAverage: null,
      categoryAverages: null,
      distribution: [],
      topCategory: null,
    });
  }

  // Category averages
  const catSums = {};
  let totalSum = 0;
  for (const cat of CATEGORIES) catSums[cat.id] = 0;

  for (const sub of subs) {
    totalSum += sub.totalKwh;
    for (const cat of CATEGORIES) {
      catSums[cat.id] += (sub[cat.id] || 0) * cat.factor;
    }
  }

  const categoryAverages = {};
  let topCat = { id: null, avgKwh: 0 };
  for (const cat of CATEGORIES) {
    const avg = catSums[cat.id] / count;
    categoryAverages[cat.id] = Math.round(avg * 1000) / 1000;
    if (avg > topCat.avgKwh) topCat = { id: cat.id, avgKwh: avg };
  }

  const classAvg = totalSum / count;

  // Distribution buckets
  const buckets = [
    { range: '0\u20131', min: 0, max: 1, count: 0 },
    { range: '1\u20132', min: 1, max: 2, count: 0 },
    { range: '2\u20133', min: 2, max: 3, count: 0 },
    { range: '3\u20134', min: 3, max: 4, count: 0 },
    { range: '4\u20135', min: 4, max: 5, count: 0 },
    { range: '5\u20137', min: 5, max: 7, count: 0 },
    { range: '7\u201310', min: 7, max: 10, count: 0 },
    { range: '10+', min: 10, max: Infinity, count: 0 },
  ];

  for (const sub of subs) {
    for (const b of buckets) {
      if (sub.totalKwh >= b.min && sub.totalKwh < b.max) { b.count++; break; }
    }
  }

  res.json({
    submissionCount: count,
    classAverage: Math.round(classAvg * 100) / 100,
    categoryAverages,
    distribution: buckets.map(b => ({ range: b.range, count: b.count })),
    topCategory: {
      id: topCat.id,
      avgKwh: Math.round(topCat.avgKwh * 1000) / 1000,
      pctOfAvg: Math.round((topCat.avgKwh / classAvg) * 100),
    },
  });
});

// ─── Admin API ──────────────────────────────────────────────────────────────

app.get('/api/admin/verify', requirePin, (req, res) => {
  res.json({ ok: true });
});

app.post('/api/admin/reset', requirePin, (req, res) => {
  const { confirm } = req.body;
  if (!confirm) return res.status(400).json({ error: 'Must confirm reset' });
  session = { submissions: {}, qrSvg: null, qrUrl: null };
  res.json({ ok: true });
});

app.get('/api/admin/qr', requirePin, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const svg = await QRCode.toString(url, { type: 'svg', margin: 2 });
    session.qrSvg = svg;
    session.qrUrl = url;
    res.type('image/svg+xml').send(svg);
  } catch (e) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// ─── Dummy data ─────────────────────────────────────────────────────────────

app.post('/api/admin/load-dummy', requirePin, (req, res) => {
  session.submissions = {};
  for (let i = 0; i < 40; i++) {
    const vid = `dummy_${i}`;
    const ai     = Math.round(10 + Math.random() * 150);
    const google  = Math.round(50 + Math.random() * 400);
    const video   = Math.round((2 + Math.random() * 25) * 2) / 2;
    const calls   = Math.round((1 + Math.random() * 12) * 2) / 2;
    const music   = Math.round((2 + Math.random() * 30) * 2) / 2;
    const cloud   = Math.round((1 + Math.random() * 15) * 2) / 2;

    let totalKwh = 0;
    const inputs = { ai, google, video, calls, music, cloud };
    for (const cat of CATEGORIES) {
      totalKwh += Math.min(inputs[cat.id], cat.max) * cat.factor;
    }

    session.submissions[vid] = {
      ai, google, video, calls, music, cloud,
      totalKwh: Math.round(totalKwh * 1000) / 1000,
      timestamp: new Date().toISOString(),
    };
  }
  res.json({ ok: true, count: 40 });
});

// ─── Error handling ─────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error('[Express error]', err.message);
  res.status(500).json({ error: 'Server error' });
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught exception]', err.message);
});

process.on('unhandledRejection', (err) => {
  console.error('[Unhandled rejection]', err);
});

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Data Footprint Calculator running on http://localhost:${PORT}`);
  console.log(`  Student:    http://localhost:${PORT}/`);
  console.log(`  Dashboard:  http://localhost:${PORT}/dashboard`);
});
