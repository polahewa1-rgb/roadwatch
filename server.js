import express from 'express';
import cors from 'cors';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'roadwatch.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_token TEXT UNIQUE NOT NULL,
    score INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    note TEXT,
    confirms INTEGER NOT NULL DEFAULT 0,
    denies INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_geo ON reports (lat, lng);
  CREATE INDEX IF NOT EXISTS idx_exp ON reports (expires_at);
  CREATE TABLE IF NOT EXISTS votes (
    report_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    vote INTEGER NOT NULL,
    PRIMARY KEY (report_id, user_id)
  );
`);

const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const MIN = 60_000;
const TTL = { police: 60, accident: 90, traffic: 45, hazard: 120, closure: 360, camera: 1440 };
const TYPES = Object.keys(TTL);
const PUBLIC = 'id, type, lat, lng, note, confirms, denies, created_at, expires_at';

const rad = d => (d * Math.PI) / 180;
function dist(lat1, lng1, lat2, lng2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(a));
}
const validCoord = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const cell = (lat, lng) => `cell:${Math.floor(lat / 0.1)}:${Math.floor(lng / 0.1)}`;

function auth(req, res, next) {
  const t = req.header('x-device-token');
  if (!t || t.length < 16 || t.length > 64) return res.status(401).json({ error: 'device token required' });
  db.prepare('INSERT OR IGNORE INTO users (device_token) VALUES (?)').run(t);
  req.userId = db.prepare('SELECT id FROM users WHERE device_token = ?').get(t).id;
  next();
}

const recent = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const arr = (recent.get(req.userId) || []).filter(t => now - t < 5 * MIN);
  if (arr.length >= 5) return res.status(429).json({ error: 'too many reports' });
  arr.push(now);
  recent.set(req.userId, arr);
  next();
}

app.post('/api/reports', auth, rateLimit, (req, res) => {
  const { type, lat, lng, note } = req.body || {};
  if (!TYPES.includes(type) || !validCoord(lat, lng)) return res.status(400).json({ error: 'invalid input' });
  const now = Date.now();
  const r = db.prepare(
    'INSERT INTO reports (user_id, type, lat, lng, note, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.userId, type, lat, lng, String(note || '').slice(0, 255) || null, now, now + TTL[type] * MIN);
  const report = db.prepare(`SELECT ${PUBLIC} FROM reports WHERE id = ?`).get(r.lastInsertRowid);
  io.to(cell(lat, lng)).emit('report:new', report);
  res.status(201).json(report);
});

app.get('/api/reports', (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const radius = Math.min(parseInt(req.query.radius) || 5000, 50000);
  if (!validCoord(lat, lng)) return res.status(400).json({ error: 'invalid coords' });
  const dLat = radius / 111320;
  const dLng = radius / (111320 * Math.max(Math.cos(rad(lat)), 0.01));
  const rows = db.prepare(
    `SELECT ${PUBLIC} FROM reports
     WHERE expires_at > ? AND denies - confirms < 3
       AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`
  ).all(Date.now(), lat - dLat, lat + dLat, lng - dLng, lng + dLng);
  res.json(
    rows.map(r => ({ ...r, distance_m: dist(lat, lng, r.lat, r.lng) }))
      .filter(r => r.distance_m <= radius)
      .sort((a, b) => a.distance_m - b.distance_m)
  );
});

app.post('/api/reports/:id/vote', auth, (req, res) => {
  const vote = req.body?.vote === 'confirm' ? 1 : req.body?.vote === 'deny' ? -1 : 0;
  if (!vote) return res.status(400).json({ error: 'vote must be confirm|deny' });
  const id = parseInt(req.params.id);
  const rep = db.prepare('SELECT * FROM reports WHERE id = ? AND expires_at > ?').get(id, Date.now());
  if (!rep) return res.status(404).json({ error: 'not found' });
  if (rep.user_id === req.userId) return res.status(403).json({ error: 'cannot vote own report' });
  const ins = db.prepare('INSERT OR IGNORE INTO votes (report_id, user_id, vote) VALUES (?, ?, ?)').run(id, req.userId, vote);
  if (!ins.changes) return res.status(409).json({ error: 'already voted' });
  if (vote === 1) {
    db.prepare('UPDATE reports SET confirms = confirms + 1, expires_at = MIN(expires_at + ?, created_at + ?) WHERE id = ?')
      .run(10 * MIN, 24 * 60 * MIN, id);
    db.prepare('UPDATE users SET score = score + 1 WHERE id = ?').run(rep.user_id);
  } else {
    db.prepare('UPDATE reports SET denies = denies + 1 WHERE id = ?').run(id);
  }
  const updated = db.prepare(`SELECT ${PUBLIC} FROM reports WHERE id = ?`).get(id);
  io.to(cell(updated.lat, updated.lng)).emit('report:update', updated);
  res.json(updated);
});

io.on('connection', socket => {
  socket.on('subscribe', ({ lat, lng } = {}) => {
    if (!validCoord(lat, lng)) return;
    socket.rooms.forEach(r => r.startsWith('cell:') && socket.leave(r));
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++) socket.join(cell(lat + a * 0.1, lng + b * 0.1));
  });
});

setInterval(() => {
  db.prepare('DELETE FROM reports WHERE expires_at < ?').run(Date.now() - 24 * 60 * MIN);
}, 10 * MIN);

app.get('/health', (_, res) => res.json({ ok: true }));

const dist_dir = path.join(__dirname, 'dist');
if (fs.existsSync(dist_dir)) {
  app.use(express.static(dist_dir));
  app.get('*', (req, res, next) =>
    req.path.startsWith('/api') || req.path.startsWith('/socket.io')
      ? next() : res.sendFile(path.join(dist_dir, 'index.html')));
}
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'server error' }); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`RoadWatch ready on port ${PORT}`));
