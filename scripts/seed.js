// Demo data so every screen of the app has something to show.
//
//   node scripts/seed.js            add demo data (backs the database up first)
//   node scripts/seed.js --reset    remove the demo data, then add it again
//   node scripts/seed.js --remove   remove all demo data
//
// It only ADDS rows: existing accounts are never changed. Every demo account uses the email
// domain @demo.nijibu.test, and every demo row (messages, reviews, favourites, payments) belongs to
// one of those accounts, so removing the accounts removes everything the seed created.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { db } from '../src/db.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo accounts with a known password in production.');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(here, '..', 'uploads');
const DOMAIN = '@demo.nijibu.test';
const PASSWORD = 'Demo1234!';
const CURRENCY = (process.env.CURRENCY || 'tzs').toLowerCase();
const args = new Set(process.argv.slice(2));

db.exec('PRAGMA busy_timeout = 5000');

// ---------- images (small generated placeholders; names are deterministic so --remove can find them) ----------
const imageName = (key) => `${crypto.createHash('md5').update(`nijibu-demo-${key}`).digest('hex')}.png`;
const IMAGE_KEYS = ['pipe', 'garden', 'wiring', 'cake'];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h, pixel) {
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      const i = y * row + 1 + x * 3;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
function scene([r1, g1, b1], [r2, g2, b2], [ar, ag, ab]) {
  const W = 480, H = 320;
  return makePng(W, H, (x, y) => {
    const t = y / H;
    let c = [r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t];
    if ((x - 340) ** 2 + (y - 100) ** 2 < 55 ** 2) c = [ar, ag, ab];          // sun / light
    if (y > 230 && ((x + y) >> 4) % 2 === 0) c = c.map((v) => v * 0.88);        // ground stripes
    if (x > 60 && x < 190 && y > 120 && y < 260) c = c.map((v) => v * 0.7);     // object
    return c.map((v) => Math.max(0, Math.min(255, Math.round(v))));
  });
}
const IMAGE_SCENES = {
  pipe: [[120, 170, 210], [40, 80, 120], [255, 240, 200]],
  garden: [[150, 200, 140], [40, 110, 60], [255, 230, 120]],
  wiring: [[230, 200, 140], [110, 80, 50], [255, 255, 220]],
  cake: [[250, 200, 215], [190, 90, 130], [255, 245, 230]],
};

function removeDemo() {
  const demo = db.prepare('SELECT id FROM users WHERE email LIKE ?').all(`%${DOMAIN}`);
  db.prepare('DELETE FROM users WHERE email LIKE ?').run(`%${DOMAIN}`); // cascades to messages, reviews, favourites, payments
  for (const k of IMAGE_KEYS) fs.rmSync(path.join(UPLOAD_DIR, imageName(k)), { force: true });
  console.log(`Removed ${demo.length} demo accounts and everything attached to them.`);
}

if (args.has('--remove')) { removeDemo(); process.exit(0); }
if (args.has('--reset')) removeDemo();
if (db.prepare('SELECT 1 FROM users WHERE email LIKE ?').get(`%${DOMAIN}`)) {
  console.log('Demo data is already there. Use --reset to rebuild it or --remove to delete it.');
  process.exit(0);
}

// ---------- backup ----------
const dbFile = db.prepare('PRAGMA database_list').all().find((d) => d.name === 'main').file;
const backup = path.join(path.dirname(dbFile), `nijibu-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
db.prepare('VACUUM INTO ?').run(backup);
console.log(`Backup written: ${backup}`);

// ---------- helpers ----------
let seed = 7;
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rand() * a.length)];
const MIN = 60 * 1000;
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
// Tanzanian shillings read as "TSh 10,000" (whole shillings, thousands separators), matching the server.
const money = (cents) => (CURRENCY === 'tzs'
  ? `TSh ${Math.round(cents / 100).toLocaleString('en-US')}`
  : new Intl.NumberFormat('en', { style: 'currency', currency: CURRENCY.toUpperCase() }).format(cents / 100));
const first = (u) => u.name.split(' ')[0];

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
for (const k of IMAGE_KEYS) fs.writeFileSync(path.join(UPLOAD_DIR, imageName(k)), scene(...IMAGE_SCENES[k]));

// ---------- users ----------
const hash = bcrypt.hashSync(PASSWORD, 10);
const takenPhones = new Set(db.prepare('SELECT phone FROM users').all().map((r) => r.phone));
let phoneSeq = 0;
const nextPhone = (prefix) => { let p; do { p = `${prefix}${String(++phoneSeq).padStart(5, '0')}`; } while (takenPhones.has(p)); takenPhones.add(p); return p; };

const addUser = (u, daysAgo) => {
  const email = `${u.name.toLowerCase().replace(/[^a-z]+/g, '.')}${DOMAIN}`;
  const created = new Date(NOW - daysAgo * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO users (name, email, phone, password_hash, role, category, bio, location, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(u.name, email, nextPhone(u.role === 'provider' ? '+2557400' : '+2557410'), hash, u.role, u.category ?? null, u.bio ?? '', u.location ?? '', created);
  return { id: Number(lastInsertRowid), email, ...u };
};

const providers = [
  { name: 'Juma Mwakyusa', category: 'Plumbing', location: 'Kinondoni, Dar es Salaam', bio: 'Licensed plumber with 9 years of experience. Leaks, blocked drains, water heaters and new installations. Same-day callouts across Dar es Salaam.' },
  { name: 'Neema Kileo', category: 'Cleaning', location: 'Mikocheni, Dar es Salaam', bio: 'Deep cleaning for homes, offices and post-construction. Eco-friendly products, reliable team of four. Weekly and monthly plans available.' },
  { name: 'Baraka Mushi', category: 'Electrical', location: 'Arusha', bio: 'Certified electrician: wiring, fuse boards, solar installations and security lighting. Safe work, clear quotes, no surprises.' },
  { name: 'Salma Hassan', category: 'Beauty & Salon', location: 'Stone Town, Zanzibar', bio: 'Braids, makeup and bridal styling. I come to you for weddings and photo shoots. Booking 3+ days ahead is best.' },
  { name: 'Emmanuel Lyimo', category: 'Mechanic', location: 'Mwanza', bio: 'Engine diagnostics, brakes, suspension and routine service for all major brands. Pick-up and drop-off available.' },
  { name: 'Grace Mollel', category: 'Catering', location: 'Mbezi Beach, Dar es Salaam', bio: 'Weddings, birthdays and corporate lunches for 20 to 400 guests. Swahili, continental and vegetarian menus. Cakes on request.' },
  { name: 'Hamisi Selemani', category: 'Carpentry', location: 'Dodoma', bio: 'Custom furniture, doors, wardrobes and roofing timber. Quality finishing and delivery included within Dodoma.' },
  { name: 'Agnes Mwakalinga', category: 'Tutoring', location: 'Mbeya', bio: 'Secondary maths and physics tutor (Form 1 to 6). Past-paper practice, patient and results-focused. Online or in person.' },
  { name: 'Peter Massawe', category: 'Photography', location: 'Moshi', bio: 'Events, portraits and product photography. Edited photos delivered within 5 days. Drone footage available.' },
  { name: 'Rehema Kimaro', category: 'Gardening', location: 'Morogoro', bio: 'Garden design, lawn care, tree trimming and irrigation. Monthly maintenance packages for homes and offices.' },
  { name: 'Yusuf Abdallah', category: 'IT & Repairs', location: 'Posta, Dar es Salaam', bio: 'Laptop and phone repair, network setup, CCTV and data recovery. Free diagnosis, warranty on every repair.' },
  { name: 'Zawadi Mtui', category: 'Painting', location: 'Tanga', bio: 'Interior and exterior painting, waterproofing and decorative finishes. Neat, fast and fully insured.' },
  { name: 'Oscar Ndunguru', category: 'Delivery', location: 'Kariakoo, Dar es Salaam', bio: 'Fast parcel and grocery delivery by motorbike within the city. Pay on delivery for verified customers.' },
].map((u, i) => addUser({ ...u, role: 'provider' }, 120 - i * 7));

const customers = [
  { name: 'Amani Mrema', location: 'Sinza, Dar es Salaam' },
  { name: 'Fatuma Juma', location: 'Mikocheni, Dar es Salaam' },
  { name: 'Daniel Komba', location: 'Arusha' },
  { name: 'Lilian Swai', location: 'Moshi' },
  { name: 'Kelvin Mbwambo', location: 'Mwanza' },
].map((u, i) => addUser({ ...u, role: 'customer' }, 60 - i * 9));

const [juma, neema, baraka, salma, emmanuel, grace, hamisi, agnes, peter, rehema, yusuf, zawadi, oscar] = providers;
const [amani, fatuma, daniel, lilian, kelvin] = customers;

// Existing (real) accounts also get demo activity so you see a full app whoever you log in as.
const realCustomers = db.prepare("SELECT * FROM users WHERE role = 'customer' AND email NOT LIKE ?").all(`%${DOMAIN}`);
const realProviders = db.prepare("SELECT * FROM users WHERE role = 'provider' AND email NOT LIKE ?").all(`%${DOMAIN}`);

// ---------- messages / payments (collected, then inserted in time order so ids match chronology) ----------
const outbox = [];
let fakeRef = 0;

const JOBS = {
  Plumbing: 'a leaking kitchen tap and a slow bathroom drain',
  Cleaning: 'a deep clean of my 3-bedroom apartment',
  Electrical: 'rewiring two sockets and fitting new security lights',
  'Beauty & Salon': 'bridal makeup and braids for my sister\'s wedding',
  Mechanic: 'a full service and brake check for my Toyota',
  Catering: 'lunch for 60 guests at a birthday party',
  Carpentry: 'a custom wardrobe for the bedroom',
  Tutoring: 'weekly physics lessons for my son in Form 4',
  Photography: 'photos for our engagement party',
  Gardening: 'a monthly garden maintenance plan',
  'IT & Repairs': 'a laptop that will not switch on',
  Painting: 'painting the living room and two bedrooms',
  Delivery: 'delivering a parcel across town today',
};
const PRICE = { Plumbing: [40000, 90000], Cleaning: [80000, 170000], Electrical: [70000, 200000], 'Beauty & Salon': [100000, 300000], Mechanic: [120000, 350000], Catering: [600000, 1500000], Carpentry: [350000, 1000000], Tutoring: [40000, 60000], Photography: [250000, 600000], Gardening: [60000, 150000], 'IT & Repairs': [40000, 150000], Painting: [500000, 1200000], Delivery: [8000, 25000] };

/**
 * Builds a conversation. `startAgoMin` is when it begins; `turns` are [who, text, gapMinutes] with who 'c' (customer) or 'p' (provider);
 * a turn may instead be { who, image } or { who, pay: {amount, status, desc} }. The last `unread` messages are left unread.
 */
function convo(c, p, startAgoMin, turns, { unread = 0 } = {}) {
  let t = NOW - startAgoMin * MIN;
  const rows = [];
  for (const turn of turns) {
    const [who, content, gap = 3 + Math.floor(rand() * 25)] = Array.isArray(turn) ? turn : [turn.who, turn, turn.gap];
    t += gap * MIN;
    const sender = who === 'c' ? c : p;
    const receiver = who === 'c' ? p : c;
    const row = { at: Math.min(t, NOW - MIN), from: sender.id, to: receiver.id, body: '', image: null, payment: null, location: null };
    if (typeof content === 'string') row.body = content;
    else if (content.image) { row.image = `/uploads/${imageName(content.image)}`; row.body = content.caption ?? ''; }
    else if (content.pay) row.payment = { provider: p.id, customer: c.id, ...content.pay };
    else if (content.location) row.location = content.location;
    rows.push(row);
  }
  rows.slice(rows.length - unread).forEach((r) => { r.unread = true; });
  outbox.push(...rows);
}

function standardChat(c, p, startAgoMin, extra = [], opts) {
  const job = JOBS[p.category] ?? 'some work';
  const [lo, hi] = PRICE[p.category] ?? [20, 60];
  return convo(c, p, startAgoMin, [
    ['c', `Hi ${first(p)}, are you available this week for ${job}?`, 0],
    ['p', `Hello ${first(c)}! Yes, I can help. Where are you located?`, 12],
    ['c', `I'm in ${c.location || 'town'}.`, 4],
    ['p', 'Great, that is close to me. I can come tomorrow morning. Would 9am work?', 9],
    ['c', 'Yes, 9am works. Roughly how much will it cost?', 6],
    ['p', `For this kind of job it is usually between ${money(lo * 100)} and ${money(hi * 100)}. I will confirm after seeing it.`, 11],
    ['c', 'Okay, sounds fair. See you then!', 5],
    ['p', 'See you tomorrow 👍', 3],
    ...extra,
  ], opts);
}

const DAY = 1440;

// --- demo customers <-> demo providers ---
standardChat(amani, juma, 6 * DAY, [
  ['p', 'All done! The tap and drain are fixed. Sending the payment request now.', 1500],
  ['p', { pay: { amount: 80000, status: 'paid', desc: 'Kitchen tap + drain repair' } }, 2],
  ['c', 'Paid, thank you so much Juma! Works perfectly.', 30],
  ['p', 'Karibu tena anytime 🙏', 5],
]);
standardChat(fatuma, neema, 3 * DAY, [
  ['c', { image: 'cake', caption: 'This is the kitchen, it needs the most work' }, 2200],
  ['p', 'Thanks for the photo. I will bring two people and all the equipment.', 20],
  ['p', { pay: { amount: 140000, status: 'pending', desc: 'Deep clean, 3 bedrooms' } }, 3],
], { unread: 2 });
standardChat(daniel, baraka, 2 * DAY, [
  ['c', { image: 'wiring', caption: 'This is the socket that keeps tripping' }, 600],
  ['p', 'I see the problem, the cable is too thin for that load. I will replace it.', 14],
]);
standardChat(lilian, salma, 5 * DAY, [['c', 'Can we do the trial makeup on Saturday?', 800], ['p', 'Saturday at 2pm works. Karibu 💄', 25]]);
standardChat(kelvin, yusuf, 1 * DAY, [['p', 'Diagnosis done: the charger port is damaged. Repair takes about 2 hours.', 300]], { unread: 1 });
standardChat(amani, emmanuel, 8 * DAY, [['p', 'Your brakes are done. Come and collect the car any time before 6pm.', 900]]);

// --- real customers (e.g. the account you log in with) <-> demo providers ---
for (const rc of realCustomers) {
  rc.location = rc.location || 'Dar es Salaam';
  standardChat(rc, juma, 4 * DAY, [
    ['c', 'Here is exactly where the house is:', 2300],
    ['c', { location: { lat: -6.7924, lng: 39.2083, accuracy: 12 } }, 1],
    ['p', 'Good morning! Just checking you are still happy for me to come at 9?', 100],
    ['p', 'I am on my way, about 20 minutes away.', 55],
  ], { unread: 2 });
  standardChat(rc, neema, 2 * DAY + 300, [
    ['p', 'Cleaning finished. It looks great! Here is the payment request.', 500],
    ['p', { pay: { amount: 120000, status: 'pending', desc: 'Apartment deep clean' } }, 1],
  ], { unread: 2 });
  standardChat(rc, baraka, 9 * DAY, [
    ['p', 'Finished! Everything is tested and safe.', 700],
    ['p', { pay: { amount: 160000, status: 'paid', desc: 'Sockets + security lights' } }, 2],
    ['c', 'Paid. Great work, thanks Baraka!', 40],
  ]);
  standardChat(rc, grace, 5 * DAY, [
    ['p', { image: 'cake', caption: 'Here is a sample of the cake design' }, 900],
    ['c', 'It looks amazing! Let us go with that one.', 17],
    ['p', 'Wonderful. I will send the full menu and quote this evening 😊', 6],
  ]);
  standardChat(rc, zawadi, 12 * DAY, [
    ['p', { pay: { amount: 550000, status: 'cancelled', desc: 'Living room + 2 bedrooms (cancelled, rescheduled)' } }, 1200],
    ['c', 'Sorry, we had to postpone. Can we plan for next month?', 90],
    ['p', 'No problem at all, just message me when you are ready.', 25],
  ]);
  convo(rc, yusuf, 14 * DAY, [
    ['c', 'Hello Yusuf, my laptop is very slow lately.', 0],
    ['p', 'Hi! It may need an SSD upgrade or a clean install. Can you bring it in?', 35],
    ['c', 'I can come on Thursday.', 600],
    ['p', 'Perfect, I am at Posta, opposite the post office. Thursday 10am.', 20],
    ['c', 'Thanks, see you then.', 15],
    ['p', 'Your laptop is ready. I replaced the hard drive with an SSD.', 4320],
    ['c', 'It is so fast now! How much do I owe you?', 40],
    ['p', { pay: { amount: 100000, status: 'paid', desc: 'SSD upgrade + labour' } }, 3],
    ['c', 'Done. Thank you!', 12],
  ]);
}

// --- real providers <-> demo customers ---
for (const rp of realProviders) {
  const cat = rp.category || 'Other';
  convo(amani, rp, 2 * DAY, [
    ['c', `Hello ${first(rp)}, I saw your profile. Are you available for ${JOBS[cat] ?? 'some work'}?`, 0],
    ['p', 'Hello Amani! Yes, I am available this week.', 22],
    ['c', { image: 'garden', caption: 'This is the place' }, 15],
    ['c', 'Could you send me a rough quote?', 2],
  ], { unread: 2 });
  convo(fatuma, rp, 5 * DAY, [
    ['c', 'Hi, thanks for the great work last week!', 0],
    ['p', 'Asante sana Fatuma, I am glad you liked it.', 60],
    ['p', { pay: { amount: 110000, status: 'pending', desc: 'Monthly maintenance' } }, 30],
  ]);
  convo(daniel, rp, 9 * DAY, [
    ['c', 'Good afternoon, what do you charge for a weekly visit?', 0],
    ['p', 'Good afternoon Daniel. Weekly visits are TSh 75,000 per month for a small compound.', 45],
    ['c', 'Okay, let us start next Monday.', 30],
    ['p', 'Done. See you Monday.', 6],
    ['p', { pay: { amount: 75000, status: 'paid', desc: 'First month' } }, 4000],
    ['c', 'Payment sent!', 10],
  ]);
  convo(lilian, rp, 1 * DAY, [
    ['c', 'Hello! Do you also do tree trimming?', 0],
    ['p', 'Yes, I do. How many trees and how tall?', 40],
    ['c', 'Three mango trees, about 6 metres.', 8],
  ], { unread: 0 });
  convo(kelvin, rp, 20 * DAY, [
    ['c', 'Can you do an urgent job today?', 0],
    ['p', 'Sorry Kelvin, I am fully booked today. Tomorrow works.', 70],
    ['p', { pay: { amount: 45000, status: 'cancelled', desc: 'Urgent visit (cancelled)' } }, 5],
  ]);
}

// ---------- insert payments + messages in chronological order ----------
const insertPayment = db.prepare(`INSERT INTO payments (provider_id, customer_id, amount_cents, currency, description, status, gateway, gateway_ref, created_at, paid_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);
const insertMessage = db.prepare('INSERT INTO messages (sender_id, receiver_id, body, created_at, read_at, image, payment_id, lat, lng, accuracy) VALUES (?,?,?,?,?,?,?,?,?,?)');

outbox.sort((a, b) => a.at - b.at);
db.exec('BEGIN');
for (const m of outbox) {
  let paymentId = null;
  let body = m.body;
  if (m.payment) {
    const pay = m.payment;
    const cents = Math.round(pay.amount * 100);
    const paid = pay.status === 'paid';
    const { lastInsertRowid } = insertPayment.run(pay.provider, pay.customer, cents, CURRENCY, pay.desc, pay.status,
      paid ? 'sandbox' : null, paid ? `sandbox_demo_${++fakeRef}` : null, new Date(m.at).toISOString(), paid ? new Date(m.at + 40 * MIN).toISOString() : null);
    paymentId = Number(lastInsertRowid);
    body = `Payment request: ${money(cents)} — ${pay.desc}`;
  }
  insertMessage.run(m.from, m.to, body, new Date(m.at).toISOString(), m.unread ? null : new Date(m.at + 2 * MIN).toISOString(), m.image, paymentId, m.location?.lat ?? null, m.location?.lng ?? null, m.location?.accuracy ?? null);
}
db.exec('COMMIT');

// ---------- reviews ----------
const COMMENTS = {
  5: ['Excellent work, very professional and on time.', 'Highly recommended! Will book again.', 'Great communication and top quality. Asante sana!', 'Better than I expected, fair price too.'],
  4: ['Good job overall, arrived a little late but did great work.', 'Very good service, would use again.', 'Nice work and friendly. Small delay at the start.'],
  3: ['Work was okay but took longer than agreed.', 'Decent service, communication could be better.'],
};
const insertReview = db.prepare('INSERT OR IGNORE INTO reviews (provider_id, author_id, rating, comment, created_at) VALUES (?,?,?,?,?)');
const reviewers = [...customers, ...realCustomers];
const target = { 'Juma Mwakyusa': [5, 5, 4, 5, 5], 'Neema Kileo': [5, 4, 5, 5], 'Baraka Mushi': [5, 5, 5, 4], 'Salma Hassan': [4, 5, 4], 'Emmanuel Lyimo': [4, 3, 5], 'Grace Mollel': [5, 5, 5, 4, 5], 'Hamisi Selemani': [4, 4], 'Agnes Mwakalinga': [5, 5, 4], 'Peter Massawe': [3, 4], 'Rehema Kimaro': [5, 4, 5], 'Yusuf Abdallah': [5, 5, 4, 5], 'Zawadi Mtui': [4, 5] };
for (const p of [...providers, ...realProviders]) {
  const ratings = target[p.name] ?? [5, 4, 5];
  ratings.forEach((rating, i) => {
    const author = reviewers[i % reviewers.length];
    insertReview.run(p.id, author.id, rating, pick(COMMENTS[rating]), iso((2 + i * 5 + Math.floor(rand() * 4)) * DAY * MIN));
  });
}

// ---------- favourites ----------
const fav = db.prepare('INSERT OR IGNORE INTO favorites (customer_id, provider_id) VALUES (?, ?)');
for (const rc of realCustomers) [juma, neema, baraka, grace, yusuf].forEach((p) => fav.run(rc.id, p.id));
for (const rp of realProviders) fav.run(amani.id, rp.id);
[juma, neema, grace].forEach((p) => fav.run(amani.id, p.id));
[neema, salma].forEach((p) => fav.run(fatuma.id, p.id));

// ---------- summary ----------
const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
console.log(`Done. users: ${count('users')}, messages: ${count('messages')}, payments: ${count('payments')}, reviews: ${count('reviews')}, favourites: ${count('favorites')}`);
console.log(`\nDemo accounts (password for all: ${PASSWORD})`);
console.log('  customers:', customers.map((u) => u.email).join(', '));
console.log('  providers:', providers.slice(0, 3).map((u) => u.email).join(', '), '…');
console.log(`  your existing accounts keep their own passwords and now also have demo chats, payments, reviews and favourites.`);
console.log('\nRemove everything later with:  npm run seed:remove');
