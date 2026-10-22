import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
export const db = new DatabaseSync(process.env.DB_PATH || path.join(dir, '..', 'nijibu.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('customer','provider')),
  category      TEXT,
  bio           TEXT NOT NULL DEFAULT '',
  location      TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (sender_id, receiver_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages (receiver_id, read_at);

CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (provider_id, author_id)
);

CREATE TABLE IF NOT EXISTS favorites (
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (customer_id, provider_id)
);
`);

// Lightweight migrations for databases created before these columns/tables existed.
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (!cols('messages').includes('image')) db.exec('ALTER TABLE messages ADD COLUMN image TEXT');
if (!cols('messages').includes('payment_id')) db.exec('ALTER TABLE messages ADD COLUMN payment_id INTEGER');
if (!cols('messages').includes('deleted_at')) db.exec('ALTER TABLE messages ADD COLUMN deleted_at TEXT');
for (const c of ['lat', 'lng', 'accuracy']) if (!cols('messages').includes(c)) db.exec(`ALTER TABLE messages ADD COLUMN ${c} REAL`);

db.exec(`
CREATE TABLE IF NOT EXISTS payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency     TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled')),
  gateway      TEXT,
  gateway_ref  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_provider ON payments (provider_id, id);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments (customer_id, id);

-- "Delete for me": a message one user has hidden from their own view.
CREATE TABLE IF NOT EXISTS message_hidden (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, message_id)
);

-- "Clear chat": everything up to this message id is hidden from user_id's view of the chat with peer_id.
CREATE TABLE IF NOT EXISTS conversation_clears (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  up_to_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, peer_id)
);

CREATE TABLE IF NOT EXISTS push_tokens (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_tokens (user_id);
`);

export const CATEGORIES = [
  'Plumbing', 'Electrical', 'Cleaning', 'Carpentry', 'Painting', 'Gardening',
  'Mechanic', 'Tutoring', 'Beauty & Salon', 'Catering', 'Photography',
  'Delivery', 'IT & Repairs', 'Other',
];
