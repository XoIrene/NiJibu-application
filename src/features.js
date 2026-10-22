// Image uploads, push notifications and payments.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(here, '..', 'uploads');

const CURRENCY = (process.env.CURRENCY || 'tzs').toLowerCase();
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
// Without Stripe keys, a clearly-labelled sandbox gateway lets you try the full flow in development.
const SANDBOX = !STRIPE_KEY && process.env.NODE_ENV !== 'production';

export const IMAGE_URL_RE = /^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp|gif)$/;

function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Tanzanian shillings are shown as "TSh 10,000": whole shillings with thousands separators (amounts are stored in minor units, x100).
const money = (cents, cur) => {
  if (cur.toLowerCase() === 'tzs') return `TSh ${Math.round(cents / 100).toLocaleString('en-US')}`;
  try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur.toUpperCase() }).format(cents / 100); }
  catch { return `${(cents / 100).toFixed(2)} ${cur.toUpperCase()}`; }
};

export function createFeatures({ db, io, auth, hasConversation, isOnline, jwtSecret }) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  // ---------- shared views ----------
  const paymentRow = (id) => db.prepare(`
    SELECT p.*, pu.name AS provider_name, cu.name AS customer_name
    FROM payments p JOIN users pu ON pu.id = p.provider_id JOIN users cu ON cu.id = p.customer_id
    WHERE p.id = ?`).get(id);

  const paymentView = (p) => p && {
    id: p.id, provider_id: p.provider_id, customer_id: p.customer_id, provider_name: p.provider_name,
    customer_name: p.customer_name, amount_cents: p.amount_cents, currency: p.currency, description: p.description,
    status: p.status, created_at: p.created_at, paid_at: p.paid_at, label: money(p.amount_cents, p.currency),
  };

  /** Message as sent to clients: includes the payment (if any) and the sender's name for notifications. */
  function hydrate(m) {
    const sender = db.prepare('SELECT name FROM users WHERE id = ?').get(m.sender_id);
    return {
      ...m, deleted: !!m.deleted_at, sender_name: sender?.name, payment: m.payment_id ? paymentView(paymentRow(m.payment_id)) : null,
      location: m.lat != null && m.lng != null ? { lat: m.lat, lng: m.lng, accuracy: m.accuracy ?? null } : null,
    };
  }

  // ---------- push ----------
  const TOKEN_RE = /^Expo(nent)?PushToken\[[^\]]+\]$/;

  /** Push to a user's devices, but only when they have no live socket (the app shows its own alert otherwise). */
  async function notify(userId, { title, body, data }) {
    if (isOnline(userId)) return;
    const tokens = db.prepare('SELECT token FROM push_tokens WHERE user_id = ?').all(userId).map((r) => r.token);
    if (!tokens.length) return;
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(tokens.map((to) => ({ to, title, body: body.slice(0, 180), data, sound: 'default', channelId: 'messages' }))),
      });
      const out = await res.json().catch(() => ({}));
      (out.data ?? []).forEach((t, i) => {
        if (t.status === 'error' && t.details?.error === 'DeviceNotRegistered') db.prepare('DELETE FROM push_tokens WHERE token = ?').run(tokens[i]);
      });
    } catch (e) {
      console.warn('push failed:', e.message);
    }
  }

  const messagePreview = (m) => (m.payment_id ? '💰 Payment request' : m.lat != null ? '📍 Location' : m.image && !m.body ? '📷 Photo' : m.body);

  function notifyMessage(m) {
    const h = hydrate(m);
    return notify(m.receiver_id, { title: h.sender_name ?? 'New message', body: messagePreview(m), data: { type: 'message', peerId: m.sender_id, peerName: h.sender_name } });
  }

  // ---------- payments ----------
  function markPaid(id, gateway, ref) {
    const { changes } = db.prepare("UPDATE payments SET status='paid', gateway=?, gateway_ref=?, paid_at=? WHERE id=? AND status='pending'")
      .run(gateway, ref ?? null, new Date().toISOString(), id);
    if (!changes) return false;
    const view = paymentView(paymentRow(id));
    io.to(`u:${view.provider_id}`).to(`u:${view.customer_id}`).emit('payment_updated', view);
    notify(view.provider_id, { title: 'Payment received', body: `${view.customer_name} paid ${view.label}`, data: { type: 'payment', peerId: view.customer_id, peerName: view.customer_name } });
    return true;
  }

  const baseUrl = (req) => PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

  async function stripeCheckout(p, req) {
    const form = new URLSearchParams({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': p.currency,
      'line_items[0][price_data][unit_amount]': String(p.amount_cents),
      'line_items[0][price_data][product_data][name]': p.description || `Payment to ${p.provider_name}`,
      client_reference_id: String(p.id),
      'metadata[payment_id]': String(p.id),
      success_url: `${baseUrl(req)}/?paid=${p.id}`,
      cancel_url: `${baseUrl(req)}/?cancelled=${p.id}`,
    });
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${STRIPE_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `nijibu-pay-${p.id}-${Date.now() >> 16}` },
      body: form,
    });
    const s = await r.json();
    if (!r.ok) throw new Error(s.error?.message || 'Stripe error');
    db.prepare("UPDATE payments SET gateway='stripe', gateway_ref=? WHERE id=?").run(s.id, p.id);
    return s.url;
  }

  function verifyStripeSignature(raw, header) {
    if (!STRIPE_WEBHOOK_SECRET || !header) return false;
    const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
    const t = Number(parts.t);
    if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
    const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
    const given = header.split(',').filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
    return given.some((g) => g.length === expected.length && crypto.timingSafeEqual(Buffer.from(g), Buffer.from(expected)));
  }

  // ---------- routes that need the raw request body: mount BEFORE express.json ----------
  function mountRaw(app) {
    app.use('/uploads', express.static(UPLOAD_DIR, { index: false, dotfiles: 'deny', maxAge: '7d', immutable: true }));

    app.post(
      '/uploads',
      rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }),
      auth,
      express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], limit: '6mb' }),
      (req, res) => {
        if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Send a JPEG, PNG, WebP or GIF image (max 6 MB)' });
        const ext = sniffImage(req.body);
        if (!ext) return res.status(400).json({ error: 'File is not a valid image' });
        const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, name), req.body, { flag: 'wx' });
        res.status(201).json({ url: `/uploads/${name}` });
      },
    );

    app.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      if (!verifyStripeSignature(raw, req.headers['stripe-signature'])) return res.status(400).send('bad signature');
      let event;
      try { event = JSON.parse(raw); } catch { return res.status(400).send('bad json'); }
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        const s = event.data.object;
        const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(s.client_reference_id));
        if (p && s.payment_status === 'paid' && s.amount_total === p.amount_cents && s.currency === p.currency) markPaid(p.id, 'stripe', s.id);
      }
      res.json({ received: true });
    });
  }

  // ---------- regular JSON routes ----------
  function mountRoutes(app) {
    // ---- delete messages / clear a chat ----
    // scope=me hides one message from the caller's own view; scope=everyone (own messages only) leaves a "This message was deleted" tombstone.
    app.delete('/messages/:id', auth, (req, res) => {
      const me = req.user.id;
      const id = Number(req.params.id);
      const scope = req.query.scope === 'everyone' ? 'everyone' : 'me';
      const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
      if (!m || (m.sender_id !== me && m.receiver_id !== me)) return res.status(404).json({ error: 'Message not found' });
      const peerId = m.sender_id === me ? m.receiver_id : m.sender_id;

      if (scope === 'me') {
        db.prepare('INSERT OR IGNORE INTO message_hidden (user_id, message_id) VALUES (?, ?)').run(me, id);
        io.to(`u:${me}`).emit('message_hidden', { id, peerId });
        return res.json({ ok: true });
      }
      if (m.sender_id !== me) return res.status(403).json({ error: 'You can only delete your own messages for everyone' });
      if (m.payment_id) return res.status(400).json({ error: "Payment requests can't be deleted for everyone. Delete it for yourself instead." });
      if (m.deleted_at) return res.json({ ok: true });

      const image = m.image;
      db.prepare("UPDATE messages SET deleted_at = ?, body = '', image = NULL, lat = NULL, lng = NULL, accuracy = NULL WHERE id = ?").run(new Date().toISOString(), id);
      // remove the uploaded file too, unless another message still points at it
      if (image && IMAGE_URL_RE.test(image) && !db.prepare('SELECT 1 FROM messages WHERE image = ? LIMIT 1').get(image)) {
        fs.rmSync(path.join(UPLOAD_DIR, path.basename(image)), { force: true });
      }
      const msg = hydrate(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
      io.to(`u:${me}`).to(`u:${peerId}`).emit('message_deleted', msg);
      res.json({ ok: true, message: msg });
    });

    // Clears the chat from the caller's view only; the other person keeps their copy. New messages start it again.
    app.post('/conversations/:peerId/clear', auth, (req, res) => {
      const me = req.user.id;
      const peerId = Number(req.params.peerId);
      if (!Number.isInteger(peerId)) return res.status(400).json({ error: 'Invalid chat' });
      const { m } = db.prepare('SELECT MAX(id) AS m FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)').get(me, peerId, peerId, me);
      db.prepare('INSERT INTO conversation_clears (user_id, peer_id, up_to_id) VALUES (?, ?, ?) ON CONFLICT(user_id, peer_id) DO UPDATE SET up_to_id = excluded.up_to_id')
        .run(me, peerId, m ?? 0);
      io.to(`u:${me}`).emit('chat_cleared', { peerId });
      res.json({ ok: true });
    });

    // push tokens
    app.post('/push-token', auth, (req, res) => {
      const parsed = z.object({ token: z.string().regex(TOKEN_RE) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid push token' });
      db.prepare('INSERT INTO push_tokens (token, user_id) VALUES (?, ?) ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id')
        .run(parsed.data.token, req.user.id);
      res.json({ ok: true });
    });
    app.delete('/push-token', auth, (req, res) => {
      const parsed = z.object({ token: z.string() }).safeParse(req.body);
      if (parsed.success) db.prepare('DELETE FROM push_tokens WHERE token = ? AND user_id = ?').run(parsed.data.token, req.user.id);
      res.json({ ok: true });
    });

    // payments
    app.get('/payments', auth, (req, res) => {
      const rows = db.prepare(`
        SELECT p.id FROM payments p WHERE p.provider_id = ? OR p.customer_id = ? ORDER BY p.id DESC LIMIT 200`).all(req.user.id, req.user.id);
      const payments = rows.map((r) => paymentView(paymentRow(r.id)));
      const earned = payments.filter((p) => p.status === 'paid' && p.provider_id === req.user.id).reduce((a, p) => a + p.amount_cents, 0);
      res.json({ payments, currency: CURRENCY, total_earned: req.user.role === 'provider' ? money(earned, CURRENCY) : undefined, sandbox: SANDBOX });
    });

    app.post('/payments', auth, (req, res) => {
      if (req.user.role !== 'provider') return res.status(403).json({ error: 'Only service providers can request payments' });
      const parsed = z.object({
        customerId: z.number().int(),
        amount: z.number().positive('Enter an amount greater than 0').max(CURRENCY === 'tzs' ? 100_000_000 : 1_000_000, 'Amount is too large'),
        description: z.string().trim().max(200).optional(),
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
      const { customerId, amount, description } = parsed.data;
      const customer = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'customer'").get(customerId);
      if (!customer) return res.status(404).json({ error: 'Customer not found' });
      if (!hasConversation(req.user.id, customerId)) return res.status(403).json({ error: 'Start a chat with this customer first' });

      // whole shillings for TZS; two decimals for any other currency
      const cents = CURRENCY === 'tzs' ? Math.round(amount) * 100 : Math.round(amount * 100);
      if (cents < 100) return res.status(400).json({ error: 'Enter an amount greater than 0' });
      const { lastInsertRowid: pid } = db.prepare('INSERT INTO payments (provider_id, customer_id, amount_cents, currency, description) VALUES (?,?,?,?,?)')
        .run(req.user.id, customerId, cents, CURRENCY, description ?? '');
      const body = `Payment request: ${money(cents, CURRENCY)}${description ? ` — ${description}` : ''}`;
      const { lastInsertRowid: mid } = db.prepare('INSERT INTO messages (sender_id, receiver_id, body, payment_id) VALUES (?,?,?,?)')
        .run(req.user.id, customerId, body, pid);
      const msg = hydrate(db.prepare('SELECT * FROM messages WHERE id = ?').get(mid));
      io.to(`u:${customerId}`).to(`u:${req.user.id}`).emit('message', msg);
      notifyMessage(msg);
      res.status(201).json({ payment: msg.payment, message: msg });
    });

    app.post('/payments/:id/cancel', auth, (req, res) => {
      const p = paymentRow(Number(req.params.id));
      if (!p || p.provider_id !== req.user.id) return res.status(404).json({ error: 'Payment not found' });
      if (p.status !== 'pending') return res.status(409).json({ error: `Payment is already ${p.status}` });
      db.prepare("UPDATE payments SET status='cancelled' WHERE id = ? AND status='pending'").run(p.id);
      const view = paymentView(paymentRow(p.id));
      io.to(`u:${view.provider_id}`).to(`u:${view.customer_id}`).emit('payment_updated', view);
      res.json({ payment: view });
    });

    app.post('/payments/:id/checkout', auth, async (req, res) => {
      const p = paymentRow(Number(req.params.id));
      if (!p || p.customer_id !== req.user.id) return res.status(404).json({ error: 'Payment not found' });
      if (p.status !== 'pending') return res.status(409).json({ error: `Payment is already ${p.status}` });
      try {
        if (STRIPE_KEY) return res.json({ url: await stripeCheckout(p, req) });
        if (SANDBOX) {
          const t = jwt.sign({ pid: p.id, purpose: 'sandbox-pay' }, jwtSecret, { expiresIn: '15m' });
          return res.json({ url: `${baseUrl(req)}/pay/sandbox/${p.id}?t=${encodeURIComponent(t)}` });
        }
        res.status(503).json({ error: 'Payments are not configured on this server' });
      } catch (e) {
        console.error(e);
        res.status(502).json({ error: 'Could not start checkout. Try again.' });
      }
    });

    // Sandbox gateway: a fake checkout page, available only when no Stripe key is set and NODE_ENV != production.
    if (SANDBOX) {
      const sandboxToken = (req) => {
        try {
          const d = jwt.verify(String(req.query.t ?? req.body?.t ?? ''), jwtSecret);
          return d.purpose === 'sandbox-pay' && d.pid === Number(req.params.id) ? d : null;
        } catch { return null; }
      };
      const page = (title, inner) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font-family:system-ui,sans-serif;background:#F4F6F8;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="background:#fff;border-radius:16px;padding:28px;max-width:380px;width:calc(100% - 32px);box-shadow:0 4px 24px rgba(0,0,0,.08)">${inner}</div>`;

      app.get('/pay/sandbox/:id', (req, res) => {
        const p = sandboxToken(req) && paymentRow(Number(req.params.id));
        if (!p) return res.status(403).send(page('Link expired', '<h2>Link expired</h2><p>Go back to the app and tap Pay again.</p>'));
        if (p.status !== 'pending') return res.send(page('Done', `<h2>Payment ${esc(p.status)}</h2><p>You can close this tab and return to NiJibu.</p>`));
        res.send(page('Sandbox checkout', `
<p style="background:#FEF3C7;color:#92400E;padding:8px 12px;border-radius:8px;font-size:13px">SANDBOX — no real money moves</p>
<h2 style="margin:12px 0 4px">${esc(money(p.amount_cents, p.currency))}</h2>
<p style="color:#64748B;margin:0 0 16px">to ${esc(p.provider_name)}${p.description ? `<br>${esc(p.description)}` : ''}</p>
<form method="post" action="/pay/sandbox/${p.id}"><input type="hidden" name="t" value="${esc(String(req.query.t))}">
<button style="width:100%;padding:14px;border:0;border-radius:12px;background:#0F766E;color:#fff;font-size:16px;font-weight:700;cursor:pointer">Pay ${esc(money(p.amount_cents, p.currency))}</button></form>`));
      });

      app.post('/pay/sandbox/:id', express.urlencoded({ extended: false, limit: '5kb' }), (req, res) => {
        if (!sandboxToken(req)) return res.status(403).send(page('Link expired', '<h2>Link expired</h2>'));
        markPaid(Number(req.params.id), 'sandbox', `sandbox_${crypto.randomBytes(6).toString('hex')}`);
        res.send(page('Paid', '<h2>✅ Payment complete</h2><p>You can close this tab and return to NiJibu.</p>'));
      });
    }
  }

  return { mountRaw, mountRoutes, hydrate, notifyMessage, messagePreview, sandbox: SANDBOX };
}
