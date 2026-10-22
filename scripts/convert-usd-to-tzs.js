// One-time converter: turns existing USD payments (and the demo price chat lines) into Tanzanian shillings.
//
//   node scripts/convert-usd-to-tzs.js [--rate 2500]
//
// Only rows still in USD are touched, so running it twice is harmless. Amounts become round figures (nearest TSh 5,000)
// (e.g. $65.00 -> TSh 165,000). The database is backed up first.
import path from 'node:path';
import { db } from '../src/db.js';

const rateArg = process.argv.indexOf('--rate');
const RATE = rateArg > -1 ? Number(process.argv[rateArg + 1]) : 2500; // TSh per USD, rough and only for converting sample data
if (!(RATE > 0)) { console.error('Invalid --rate'); process.exit(1); }

db.exec('PRAGMA busy_timeout = 5000');
const dbFile = db.prepare('PRAGMA database_list').all().find((d) => d.name === 'main').file;
const backup = path.join(path.dirname(dbFile), `nijibu-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
db.prepare('VACUUM INTO ?').run(backup);
console.log(`Backup written: ${backup}`);

const fmt = (tsh) => `TSh ${tsh.toLocaleString('en-US')}`;
const toTsh = (usd) => Math.round((usd * RATE) / 5000) * 5000;

db.exec('BEGIN');
const rows = db.prepare("SELECT id, amount_cents, description FROM payments WHERE currency = 'usd'").all();
const upd = db.prepare("UPDATE payments SET amount_cents = ?, currency = 'tzs' WHERE id = ?");
const updMsg = db.prepare('UPDATE messages SET body = ? WHERE payment_id = ?');
for (const r of rows) {
  const tsh = toTsh(r.amount_cents / 100);
  upd.run(tsh * 100, r.id);
  updMsg.run(`Payment request: ${fmt(tsh)}${r.description ? ` — ${r.description}` : ''}`, r.id);
}

// the sample "usually between $35.00 and $70.00" and "30 per month" chat lines
let texts = 0;
const upText = db.prepare('UPDATE messages SET body = ? WHERE id = ?');
for (const m of db.prepare("SELECT id, body FROM messages WHERE body LIKE '%between $%'").all()) {
  upText.run(m.body.replace(/\$([\d,]+(?:\.\d+)?)/g, (_, n) => fmt(toTsh(Number(n.replace(/,/g, ''))))), m.id); texts++;
}
for (const m of db.prepare("SELECT id, body FROM messages WHERE body LIKE '%Weekly visits are 30 per month%'").all()) {
  upText.run(m.body.replace('are 30 per month', `are ${fmt(toTsh(30))} per month`), m.id); texts++;
}
db.exec('COMMIT');
console.log(`Converted ${rows.length} payments and ${texts} chat lines at ${RATE} TSh per USD.`);
