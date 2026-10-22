import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { Server } from 'socket.io';
import { db, CATEGORIES } from './db.js';
import { createFeatures, IMAGE_URL_RE } from './features.js';

const PORT = Number(process.env.PORT) || 4000;
const here = path.dirname(fileURLToPath(import.meta.url));

// Persist a generated secret so tokens survive restarts without requiring config in dev.
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(here, '..', '.jwt-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
const JWT_SECRET = loadSecret();

const app = express();
const server = http.createServer(app);
const origin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true;
const io = new Server(server, { cors: { origin } });

// Uploaded images are loaded cross-origin by the app (e.g. Expo dev server on another port).
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      // blob: is how the browser hands the web app a photo the user just picked
      'img-src': ["'self'", 'data:', 'blob:', 'https://tile.openstreetmap.org'], // OSM tiles for location previews
      'connect-src': ["'self'", 'blob:', 'ws:', 'wss:', 'https://nominatim.openstreetmap.org'], // place search for the manual location picker
    },
  },
}));
app.use(cors({ origin }));

const features = createFeatures({
  db, io, auth, hasConversation, isOnline: (id) => isOnline(id), jwtSecret: JWT_SECRET,
});
features.mountRaw(app); // raw-body routes (uploads, webhooks) must come before express.json

app.use(express.json({ limit: '50kb' }));
app.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: true, legacyHeaders: false }));

// ---------- helpers ----------
const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s\-().]/g, ''))
  .refine((v) => /^\+?[1-9]\d{7,14}$/.test(v), 'Enter a valid phone number, e.g. +255712345678');

const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Name is too short').max(80),
    email: z.string().trim().toLowerCase().email('Invalid email'),
    phone: phoneSchema,
    password: z.string().min(8, 'Password must be at least 8 characters').max(128),
    role: z.enum(['customer', 'provider']),
    category: z.string().optional(),
    bio: z.string().trim().max(500).optional(),
    location: z.string().trim().max(120).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.role === 'provider' && !CATEGORIES.includes(v.category ?? '')) {
      ctx.addIssue({ code: 'custom', path: ['category'], message: 'Providers must choose a service category' });
    }
  });

const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'Email or phone required'),
  password: z.string().min(1, 'Password required'),
});

const profileSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  phone: phoneSchema.optional(),
  bio: z.string().trim().max(500).optional(),
  location: z.string().trim().max(120).optional(),
  category: z.string().optional(),
});

const publicUser = (u) =>
  u && {
    id: u.id, name: u.name, role: u.role, category: u.category,
    bio: u.bio, location: u.location, created_at: u.created_at,
  };

const privateUser = (u) => u && { ...publicUser(u), email: u.email, phone: u.phone };

const sign = (u) => jwt.sign({ sub: u.id }, JWT_SECRET, { expiresIn: '30d' });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parse(schema, data, res) {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  res.status(400).json({ error: first.message, field: first.path[0] });
  return null;
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try {
    const { sub } = jwt.verify(h.replace(/^Bearer /, ''), JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(sub);
    if (!user) throw new Error('no user');
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

const withRating = `
  SELECT u.*,
    (SELECT ROUND(AVG(rating), 1) FROM reviews r WHERE r.provider_id = u.id) AS rating,
    (SELECT COUNT(*) FROM reviews r WHERE r.provider_id = u.id) AS review_count
  FROM users u`;

// ---------- auth ----------
app.post('/auth/register', wrap(async (req, res) => {
  const d = parse(registerSchema, req.body, res);
  if (!d) return;
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(d.email))
    return res.status(409).json({ error: 'Email already registered', field: 'email' });
  if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(d.phone))
    return res.status(409).json({ error: 'Phone number already registered', field: 'phone' });

  const hash = await bcrypt.hash(d.password, 12);
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO users (name, email, phone, password_hash, role, category, bio, location)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(d.name, d.email, d.phone, hash, d.role, d.role === 'provider' ? d.category : null, d.bio ?? '', d.location ?? '');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
  res.status(201).json({ token: sign(user), user: privateUser(user) });
}));

app.post('/auth/login', wrap(async (req, res) => {
  const d = parse(loginSchema, req.body, res);
  if (!d) return;
  const id = d.identifier.includes('@') ? d.identifier.toLowerCase() : d.identifier.replace(/[\s\-().]/g, '');
  const user = db.prepare('SELECT * FROM users WHERE email = ? OR phone = ?').get(id, id);
  // Compare against a dummy hash when user is missing to keep timing uniform.
  const ok = await bcrypt.compare(d.password, user?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi');
  if (!user || !ok) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: sign(user), user: privateUser(user) });
}));

// ---------- profile ----------
app.get('/me', auth, (req, res) => res.json({ user: privateUser(req.user) }));

app.put('/me', auth, (req, res) => {
  const d = parse(profileSchema, req.body, res);
  if (!d) return;
  if (d.phone && db.prepare('SELECT 1 FROM users WHERE phone = ? AND id != ?').get(d.phone, req.user.id))
    return res.status(409).json({ error: 'Phone number already in use', field: 'phone' });
  if (d.category && req.user.role === 'provider' && !CATEGORIES.includes(d.category))
    return res.status(400).json({ error: 'Invalid category', field: 'category' });
  const u = req.user;
  db.prepare('UPDATE users SET name=?, phone=?, bio=?, location=?, category=? WHERE id=?').run(
    d.name ?? u.name, d.phone ?? u.phone, d.bio ?? u.bio, d.location ?? u.location,
    u.role === 'provider' ? d.category ?? u.category : null, u.id,
  );
  res.json({ user: privateUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

app.get('/categories', (_req, res) => res.json({ categories: CATEGORIES }));

// ---------- providers ----------
app.get('/providers', auth, (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const category = String(req.query.category ?? '').trim();
  const where = ["u.role = 'provider'"];
  const params = [];
  if (category) { where.push('u.category = ?'); params.push(category); }
  if (q) {
    where.push('(u.name LIKE ? ESCAPE \'\\\' OR u.bio LIKE ? ESCAPE \'\\\' OR u.location LIKE ? ESCAPE \'\\\' OR u.category LIKE ? ESCAPE \'\\\')');
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    params.push(like, like, like, like);
  }
  const rows = db.prepare(`SELECT * FROM (${withRating}) u WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(rating, 0) DESC, review_count DESC, name LIMIT 100`).all(...params);
  const favs = new Set(db.prepare('SELECT provider_id FROM favorites WHERE customer_id = ?').all(req.user.id).map((r) => r.provider_id));
  res.json({
    providers: rows.map((r) => ({ ...publicUser(r), rating: r.rating, review_count: r.review_count, favorite: favs.has(r.id) })),
  });
});

app.get('/users/:id', auth, (req, res) => {
  const row = db.prepare(`${withRating} WHERE u.id = ?`).get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  const out = { ...publicUser(row), rating: row.rating, review_count: row.review_count };
  // Phone number is shared only between a provider and customers, so catching up is easy.
  if (row.role === 'provider' && req.user.role === 'customer') out.phone = row.phone;
  if (row.role === 'customer' && req.user.role === 'provider' && hasConversation(req.user.id, row.id)) out.phone = row.phone;
  out.favorite = !!db.prepare('SELECT 1 FROM favorites WHERE customer_id=? AND provider_id=?').get(req.user.id, row.id);
  out.online = isOnline(row.id);
  res.json({ user: out });
});

function hasConversation(a, b) {
  return !!db.prepare('SELECT 1 FROM messages WHERE (sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?) LIMIT 1').get(a, b, b, a);
}

app.get('/favorites', auth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM (${withRating}) x WHERE x.id IN (SELECT provider_id FROM favorites WHERE customer_id = ?)`).all(req.user.id);
  res.json({ providers: rows.map((r) => ({ ...publicUser(r), rating: r.rating, review_count: r.review_count, favorite: true })) });
});

app.post('/favorites/:id', auth, (req, res) => {
  if (req.user.role !== 'customer') return res.status(403).json({ error: 'Only customers can save providers' });
  const p = db.prepare("SELECT id FROM users WHERE id=? AND role='provider'").get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Provider not found' });
  db.prepare('INSERT OR IGNORE INTO favorites VALUES (?, ?)').run(req.user.id, p.id);
  res.json({ favorite: true });
});

app.delete('/favorites/:id', auth, (req, res) => {
  db.prepare('DELETE FROM favorites WHERE customer_id=? AND provider_id=?').run(req.user.id, Number(req.params.id));
  res.json({ favorite: false });
});

// ---------- reviews ----------
app.get('/providers/:id/reviews', auth, (req, res) => {
  const rows = db.prepare(`SELECT r.id, r.rating, r.comment, r.created_at, u.name AS author_name
    FROM reviews r JOIN users u ON u.id = r.author_id WHERE r.provider_id = ? ORDER BY r.id DESC LIMIT 100`).all(Number(req.params.id));
  res.json({ reviews: rows });
});

app.post('/providers/:id/reviews', auth, (req, res) => {
  const d = parse(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(500).optional() }), req.body, res);
  if (!d) return;
  const pid = Number(req.params.id);
  if (req.user.role !== 'customer') return res.status(403).json({ error: 'Only customers can leave reviews' });
  if (!db.prepare("SELECT 1 FROM users WHERE id=? AND role='provider'").get(pid)) return res.status(404).json({ error: 'Provider not found' });
  if (!hasConversation(req.user.id, pid)) return res.status(403).json({ error: 'Chat with this provider before reviewing' });
  db.prepare(`INSERT INTO reviews (provider_id, author_id, rating, comment) VALUES (?,?,?,?)
    ON CONFLICT(provider_id, author_id) DO UPDATE SET rating=excluded.rating, comment=excluded.comment`)
    .run(pid, req.user.id, d.rating, d.comment ?? '');
  res.status(201).json({ ok: true });
});

// ---------- chat (REST) ----------
// A message is visible to user `me` unless they hid it ("delete for me") or cleared the chat past it. `x` is the messages row,
// `peer` the SQL expression for the other user. `me` is the authenticated user's integer id, never user input.
const visibleTo = (me, x, peer) => `${x}.id > COALESCE((SELECT c.up_to_id FROM conversation_clears c WHERE c.user_id = ${me} AND c.peer_id = ${peer}), 0)
  AND ${x}.id NOT IN (SELECT h.message_id FROM message_hidden h WHERE h.user_id = ${me})`;

app.get('/conversations', auth, (req, res) => {
  const me = Number(req.user.id);
  const rows = db.prepare(`
    SELECT u.id, u.name, u.role, u.category,
      CASE WHEN m.deleted_at IS NOT NULL THEN 'This message was deleted' WHEN m.payment_id IS NOT NULL THEN '💰 Payment request' WHEN m.lat IS NOT NULL THEN '📍 Location' WHEN m.image IS NOT NULL AND m.body = '' THEN '📷 Photo' ELSE m.body END AS last_body, m.created_at AS last_at, m.sender_id AS last_sender,
      (SELECT COUNT(*) FROM messages x WHERE x.sender_id = u.id AND x.receiver_id = ${me} AND x.read_at IS NULL AND x.deleted_at IS NULL AND ${visibleTo(me, 'x', 'u.id')}) AS unread
    FROM users u
    JOIN messages m ON m.id = (
      SELECT MAX(y.id) FROM messages y
      WHERE ((y.sender_id = ${me} AND y.receiver_id = u.id) OR (y.sender_id = u.id AND y.receiver_id = ${me})) AND ${visibleTo(me, 'y', 'u.id')})
    ORDER BY m.id DESC`).all();
  res.json({ conversations: rows.map((r) => ({ ...r, online: isOnline(r.id) })) });
});

app.get('/messages/:userId', auth, (req, res) => {
  const me = req.user.id, other = Number(req.params.userId);
  if (!Number.isInteger(other)) return res.status(400).json({ error: 'Invalid chat' });
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = db.prepare(`SELECT * FROM messages
    WHERE ((sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?)) AND id < ? AND ${visibleTo(Number(me), 'messages', Number(other))}
    ORDER BY id DESC LIMIT 50`).all(me, other, other, me, before).reverse();
  res.json({ messages: rows.map(features.hydrate) });
});

app.post('/messages/:userId/read', auth, (req, res) => markRead(req.user.id, Number(req.params.userId), res));

function markRead(me, other, res) {
  const now = new Date().toISOString();
  const { changes } = db.prepare('UPDATE messages SET read_at=? WHERE sender_id=? AND receiver_id=? AND read_at IS NULL').run(now, other, me);
  if (changes) io.to(`u:${other}`).emit('messages_read', { by: me, at: now });
  res?.json({ ok: true });
}

app.get('/unread-count', auth, (req, res) => {
  const me = Number(req.user.id);
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM messages x WHERE x.receiver_id = ${me} AND x.read_at IS NULL AND x.deleted_at IS NULL AND ${visibleTo(me, 'x', 'x.sender_id')}`).get();
  res.json({ count: n });
});

// ---------- chat (realtime) ----------
const online = new Map(); // userId -> socket count
const isOnline = (id) => (online.get(id) ?? 0) > 0;

io.use((socket, next) => {
  try {
    const { sub } = jwt.verify(socket.handshake.auth?.token ?? '', JWT_SECRET);
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(sub);
    if (!user) throw new Error('no user');
    socket.data.userId = user.id;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  const me = socket.data.userId;
  socket.join(`u:${me}`);
  online.set(me, (online.get(me) ?? 0) + 1);
  io.emit('presence', { userId: me, online: true });

  socket.on('send', (payload, ack) => {
    const parsed = z.object({
      to: z.number().int(),
      body: z.string().trim().max(2000).default(''),
      image: z.string().regex(IMAGE_URL_RE).optional(),
      location: z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        accuracy: z.number().min(0).max(100000).optional(),
      }).optional(),
      clientId: z.string().max(64).optional(),
    }).refine((v) => v.body || v.image || v.location, 'Empty message').safeParse(payload);
    if (!parsed.success) return ack?.({ error: 'Invalid message' });
    const { to, body, image, location, clientId } = parsed.data;
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
    if (!target || to === me) return ack?.({ error: 'Invalid recipient' });
    const { lastInsertRowid } = db.prepare('INSERT INTO messages (sender_id, receiver_id, body, image, lat, lng, accuracy) VALUES (?,?,?,?,?,?,?)')
      .run(me, to, body, image ?? null, location ? Math.round(location.lat * 1e6) / 1e6 : null, location ? Math.round(location.lng * 1e6) / 1e6 : null, location?.accuracy != null ? Math.round(location.accuracy) : null);
    const msg = features.hydrate(db.prepare('SELECT * FROM messages WHERE id = ?').get(lastInsertRowid));
    io.to(`u:${to}`).emit('message', msg);
    io.to(`u:${me}`).except(socket.id).emit('message', msg);
    features.notifyMessage(msg);
    ack?.({ message: msg, clientId });
  });

  socket.on('typing', ({ to, typing }) => {
    if (Number.isInteger(to)) io.to(`u:${to}`).emit('typing', { from: me, typing: !!typing });
  });

  socket.on('read', ({ from }) => {
    if (Number.isInteger(from)) markRead(me, from);
  });

  socket.on('who_online', (ids, ack) => {
    if (Array.isArray(ids)) ack?.(ids.filter((i) => isOnline(i)));
  });

  socket.on('disconnect', () => {
    const n = (online.get(me) ?? 1) - 1;
    if (n <= 0) { online.delete(me); io.emit('presence', { userId: me, online: false }); }
    else online.set(me, n);
  });
});

features.mountRoutes(app);

app.get('/health', (_req, res) => res.json({ ok: true }));

// Serve the exported web build when present (npm run build:web in /app).
const webDir = process.env.WEB_DIR || path.join(here, '..', '..', 'app', 'dist');
if (fs.existsSync(webDir)) {
  // index.html must never be cached (it names the current bundle); hashed bundles can be cached forever.
  app.use(express.static(webDir, {
    setHeaders: (res, file) => {
      if (file.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
      else if (file.includes(`${path.sep}_expo${path.sep}static${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));
  app.get(/^\/(?!auth|me|providers|users|favorites|messages|conversations|categories|unread-count|socket\.io|health|uploads|payments|pay|push-token|webhooks).*/, (_req, res) =>
    res.set('Cache-Control', 'no-store').sendFile(path.join(webDir, 'index.html')));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

server.listen(PORT, () => console.log(`NiJibu server listening on :${PORT}`));
