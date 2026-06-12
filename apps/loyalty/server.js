import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore, inkressApi, createInkressOrder, listInkressOrders, orderStatusName, isPaidStatus } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";
import { openMerchantTokens } from "@inkress/apps-core/merchant-tokens";
import { sendEmail, sesConfigured } from "@inkress/apps-core/ses";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const WEBHOOK_SECRET = process.env.INKRESS_WEBHOOK_SECRET || "";
const TOKEN_SECRET = process.env.MEMBER_TOKEN_SECRET || process.env.OAUTH_CLIENT_SECRET || "loyalty-dev-secret";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[loyalty] Missing env: ${k}`); process.exit(1); }
}

// One Postgres database, own schema. Money/points are stored in MAJOR units
// (points are integers; point_value_jmd is the JMD a single point is worth).
const db = await openPg("loyalty", `
  CREATE TABLE IF NOT EXISTS config (
    merchant_id BIGINT PRIMARY KEY,
    points_per_unit NUMERIC NOT NULL DEFAULT 1,     -- points earned per 1 unit of currency spent
    point_value NUMERIC NOT NULL DEFAULT 0.5,       -- currency value of ONE point on redemption
    min_redeem INTEGER NOT NULL DEFAULT 100,        -- fewest points a customer can redeem
    signup_bonus INTEGER NOT NULL DEFAULT 0,        -- points granted on a member's first paid order
    auto_award BOOLEAN NOT NULL DEFAULT true,       -- award automatically on paid order (vs manual backfill only)
    email_on_earn BOOLEAN NOT NULL DEFAULT true,    -- email the customer each time they earn
    digest TEXT NOT NULL DEFAULT 'off',             -- off | weekly | monthly balance email
    currency TEXT NOT NULL DEFAULT 'JMD',
    merchant_name TEXT, merchant_logo TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_digest_on DATE
  );
  -- A legacy "loyalty" schema may already hold a config table from the v1 app, in
  -- which case CREATE TABLE IF NOT EXISTS above is a no-op and our columns are absent.
  -- Add each idempotently so the app works whether the table is fresh or inherited.
  ALTER TABLE config ADD COLUMN IF NOT EXISTS points_per_unit NUMERIC NOT NULL DEFAULT 1;
  ALTER TABLE config ADD COLUMN IF NOT EXISTS point_value NUMERIC NOT NULL DEFAULT 0.5;
  ALTER TABLE config ADD COLUMN IF NOT EXISTS min_redeem INTEGER NOT NULL DEFAULT 100;
  ALTER TABLE config ADD COLUMN IF NOT EXISTS signup_bonus INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE config ADD COLUMN IF NOT EXISTS auto_award BOOLEAN NOT NULL DEFAULT true;
  ALTER TABLE config ADD COLUMN IF NOT EXISTS email_on_earn BOOLEAN NOT NULL DEFAULT true;
  ALTER TABLE config ADD COLUMN IF NOT EXISTS digest TEXT NOT NULL DEFAULT 'off';
  ALTER TABLE config ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'JMD';
  ALTER TABLE config ADD COLUMN IF NOT EXISTS merchant_name TEXT;
  ALTER TABLE config ADD COLUMN IF NOT EXISTS merchant_logo TEXT;
  ALTER TABLE config ADD COLUMN IF NOT EXISTS last_digest_on DATE;
  CREATE TABLE IF NOT EXISTS members (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL,
    email TEXT, phone TEXT, name TEXT,
    points INTEGER NOT NULL DEFAULT 0, lifetime INTEGER NOT NULL DEFAULT 0,
    signup_awarded BOOLEAN NOT NULL DEFAULT false,
    last_earn_email_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, email)
  );
  ALTER TABLE members ADD COLUMN IF NOT EXISTS points INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE members ADD COLUMN IF NOT EXISTS lifetime INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE members ADD COLUMN IF NOT EXISTS signup_awarded BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE members ADD COLUMN IF NOT EXISTS last_earn_email_at TIMESTAMPTZ;
  ALTER TABLE members ADD COLUMN IF NOT EXISTS phone TEXT;
  ALTER TABLE members ADD COLUMN IF NOT EXISTS name TEXT;
  CREATE INDEX IF NOT EXISTS idx_loy_members ON members (merchant_id, points DESC);
  CREATE TABLE IF NOT EXISTS txns (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, member_id BIGINT NOT NULL,
    points INTEGER NOT NULL,                          -- +earn / -redeem
    kind TEXT NOT NULL,                               -- earn | redeem | signup | adjust | expire
    reason TEXT, order_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_loy_txns ON txns (merchant_id, created_at DESC);
  -- one earn per order (idempotency for backfill + webhook races)
  CREATE UNIQUE INDEX IF NOT EXISTS idx_loy_earn_once ON txns (merchant_id, order_id) WHERE kind='earn' AND order_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS rewards (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, member_id BIGINT NOT NULL,
    code TEXT NOT NULL, points INTEGER NOT NULL, value NUMERIC NOT NULL, currency TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'issued',             -- issued | redeemed | void
    redeemed_at TIMESTAMPTZ, redeemed_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, code)
  );
  CREATE TABLE IF NOT EXISTS webhook_subs (merchant_id BIGINT PRIMARY KEY, url TEXT NOT NULL, registered_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS webhook_seen (webhook_id TEXT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL DEFAULT now());
`);

const app = express();
app.use("/webhooks/inkress", express.raw({ type: () => true, limit: "1mb" }));
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID, clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE, frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
  onBootstrap: (entry) => { tokens.save(entry.merchantId, entry.refreshToken).catch(() => {}); },
});
const tokens = await openMerchantTokens("loyalty", core.cfg);

// ---- helpers ---------------------------------------------------------------
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const PUBLIC_BASE = (req) => process.env.PUBLIC_BASE_URL || `https://${req.get("host")}`;
const PUBLIC_BASE_STR = () => process.env.PUBLIC_BASE_URL || "";
function genCode(prefix = "LP") { const p = () => crypto.randomBytes(2).toString("hex").toUpperCase(); return `${prefix}-${p()}-${p()}`; }
function qrUrl(data, size = 200) { return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=8&data=${encodeURIComponent(data)}`; }
// Member page token: unguessable, self-describing, no DB lookup table needed.
function memberToken(id) { const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(`m:${id}`).digest("base64url").slice(0, 16); return `${id}.${sig}`; }
function memberIdFromToken(tok) { const [id, sig] = String(tok || "").split("."); if (!id || !sig) return null; const ok = crypto.createHmac("sha256", TOKEN_SECRET).update(`m:${id}`).digest("base64url").slice(0, 16); const a = Buffer.from(sig), b = Buffer.from(ok); return a.length === b.length && crypto.timingSafeEqual(a, b) ? Number(id) : null; }

async function getConfig(mid, merchant) {
  let c = await db.one(`SELECT * FROM config WHERE merchant_id=$1`, [mid]);
  if (!c) c = await db.one(`INSERT INTO config (merchant_id, currency, merchant_name, merchant_logo) VALUES ($1,$2,$3,$4)
      ON CONFLICT (merchant_id) DO UPDATE SET merchant_id=EXCLUDED.merchant_id RETURNING *`,
    [mid, merchant?.currency_code || "JMD", merchant?.name || null, merchant?.logo || merchant?.logo_url || null]);
  return c;
}
const serializeMember = (m, cfg, req) => ({
  id: m.id, email: m.email, phone: m.phone, name: m.name || m.email || "Member",
  points: m.points, lifetime: m.lifetime, value: round2(m.points * Number(cfg.point_value)),
  can_redeem: m.points >= cfg.min_redeem, created_at: m.created_at,
  member_url: req ? `${PUBLIC_BASE(req)}/m/${memberToken(m.id)}` : null,
});

// Find or create a member from an order's customer details.
async function upsertMember(mid, { email, phone, name }) {
  email = (email || "").trim().toLowerCase() || null;
  if (email) {
    const ex = await db.one(`SELECT * FROM members WHERE merchant_id=$1 AND email=$2`, [mid, email]);
    if (ex) {
      if ((!ex.name && name) || (!ex.phone && phone)) await db.run(`UPDATE members SET name=COALESCE(NULLIF($2,''),name), phone=COALESCE(NULLIF($3,''),phone) WHERE id=$1`, [ex.id, name || "", phone || ""]);
      return await db.one(`SELECT * FROM members WHERE id=$1`, [ex.id]);
    }
    return await db.one(`INSERT INTO members (merchant_id, email, phone, name) VALUES ($1,$2,$3,$4) RETURNING *`, [mid, email, phone || null, name || null]);
  }
  if (phone) {
    const ex = await db.one(`SELECT * FROM members WHERE merchant_id=$1 AND phone=$2 AND email IS NULL`, [mid, phone]);
    if (ex) return ex;
    return await db.one(`INSERT INTO members (merchant_id, phone, name) VALUES ($1,$2,$3) RETURNING *`, [mid, phone, name || null]);
  }
  return null;
}

// Award points for one paid order. Idempotent on (merchant, order_id) via the
// partial unique index — a duplicate webhook/backfill simply no-ops.
async function awardForOrder(mid, cfg, order, { emailMember = true } = {}) {
  const total = Number(order.total || 0);
  const email = order.customer?.email || order.email || null;
  const name = order.customer?.full_name || [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" ") || null;
  const phone = order.customer?.phone || order.phone || null;
  const pts = Math.floor(total * Number(cfg.points_per_unit));
  if (!(pts > 0)) return null;
  const member = await upsertMember(mid, { email, phone, name });
  if (!member) return null;
  let earned = 0, bonus = 0;
  try {
    await db.run(`INSERT INTO txns (merchant_id, member_id, points, kind, reason, order_id) VALUES ($1,$2,$3,'earn',$4,$5)`,
      [mid, member.id, pts, `Order ${order.reference_id || order.id}`, String(order.id)]);
    earned = pts;
  } catch (e) { if (/duplicate|unique/i.test(String(e?.message))) return null; throw e; } // already awarded
  if (!member.signup_awarded && Number(cfg.signup_bonus) > 0) {
    bonus = Number(cfg.signup_bonus);
    await db.run(`INSERT INTO txns (merchant_id, member_id, points, kind, reason) VALUES ($1,$2,$3,'signup','Welcome bonus')`, [mid, member.id, bonus]);
    await db.run(`UPDATE members SET signup_awarded=true WHERE id=$1`, [member.id]);
  }
  const upd = await db.one(`UPDATE members SET points=points+$2, lifetime=lifetime+$2 WHERE id=$1 RETURNING *`, [member.id, earned + bonus]);
  if (emailMember && cfg.email_on_earn && upd.email) await emailEarned(cfg, upd, earned, bonus).catch(() => {});
  return { member: upd, earned, bonus };
}

// ---- merchant API ----------------------------------------------------------
app.get("/api/config", core.requireSession, async (req, res) => {
  const cfg = await getConfig(req.session.merchantId, req.session.data?.merchant);
  res.json({ config: {
    points_per_unit: Number(cfg.points_per_unit), point_value: Number(cfg.point_value), min_redeem: cfg.min_redeem,
    signup_bonus: cfg.signup_bonus, auto_award: cfg.auto_award, email_on_earn: cfg.email_on_earn, digest: cfg.digest, currency: cfg.currency },
    ses_configured: sesConfigured(), webhook_realtime: Boolean(WEBHOOK_SECRET), public_base: Boolean(PUBLIC_BASE_STR()) });
});
app.patch("/api/config", core.requireSession, async (req, res) => {
  const b = req.body || {}; const mid = req.session.merchantId;
  await getConfig(mid, req.session.data?.merchant);
  const num = (v, d, lo, hi) => { let n = Number(v); if (!Number.isFinite(n)) n = d; return Math.min(hi, Math.max(lo, n)); };
  const cur = await db.one(`SELECT * FROM config WHERE merchant_id=$1`, [mid]);
  const c = await db.one(`UPDATE config SET points_per_unit=$2, point_value=$3, min_redeem=$4, signup_bonus=$5, auto_award=$6, email_on_earn=$7, digest=$8 WHERE merchant_id=$1 RETURNING *`,
    [mid,
     b.points_per_unit != null ? num(b.points_per_unit, 1, 0, 1000) : Number(cur.points_per_unit),
     b.point_value != null ? num(b.point_value, 0.5, 0, 100000) : Number(cur.point_value),
     b.min_redeem != null ? Math.round(num(b.min_redeem, 100, 1, 1e7)) : cur.min_redeem,
     b.signup_bonus != null ? Math.round(num(b.signup_bonus, 0, 0, 1e7)) : cur.signup_bonus,
     b.auto_award != null ? !!b.auto_award : cur.auto_award,
     b.email_on_earn != null ? !!b.email_on_earn : cur.email_on_earn,
     b.digest != null ? (["off", "weekly", "monthly"].includes(b.digest) ? b.digest : "off") : cur.digest]);
  res.json({ config: { points_per_unit: Number(c.points_per_unit), point_value: Number(c.point_value), min_redeem: c.min_redeem, signup_bonus: c.signup_bonus, auto_award: c.auto_award, email_on_earn: c.email_on_earn, digest: c.digest, currency: c.currency } });
});

app.get("/api/overview", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId; const cfg = await getConfig(mid, req.session.data?.merchant);
  const m = await db.one(`SELECT COUNT(*)::int n, COALESCE(SUM(points),0)::int outstanding, COALESCE(SUM(lifetime),0)::int lifetime FROM members WHERE merchant_id=$1`, [mid]);
  const red = await db.one(`SELECT COALESCE(SUM(-points),0)::int redeemed FROM txns WHERE merchant_id=$1 AND kind='redeem'`, [mid]);
  const recent = await db.q(`SELECT t.points, t.kind, t.reason, t.created_at, m.name, m.email FROM txns t JOIN members m ON m.id=t.member_id WHERE t.merchant_id=$1 ORDER BY t.created_at DESC LIMIT 20`, [mid]);
  res.json({ stats: { members: m.n, outstanding: m.outstanding, redeemed: red.redeemed, lifetime: m.lifetime, value_outstanding: round2(m.outstanding * Number(cfg.point_value)) },
    recent: recent.map((r) => ({ points: r.points, kind: r.kind, reason: r.reason, created_at: r.created_at, member: r.name || r.email || "Member" })),
    currency: cfg.currency, point_value: Number(cfg.point_value) });
});

app.get("/api/members", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId; const cfg = await getConfig(mid, req.session.data?.merchant);
  let rows = await db.q(`SELECT * FROM members WHERE merchant_id=$1 ORDER BY points DESC, lifetime DESC LIMIT 500`, [mid]);
  const q = String(req.query.q || "").trim().toLowerCase();
  if (q) rows = rows.filter((m) => ((m.name || "") + (m.email || "") + (m.phone || "")).toLowerCase().includes(q));
  res.json({ members: rows.map((m) => serializeMember(m, cfg, req)) });
});
app.get("/api/members/:id", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId; const cfg = await getConfig(mid, req.session.data?.merchant);
  const m = await db.one(`SELECT * FROM members WHERE id=$1 AND merchant_id=$2`, [req.params.id, mid]);
  if (!m) return res.status(404).json({ error: "not_found" });
  const history = await db.q(`SELECT points, kind, reason, created_at FROM txns WHERE member_id=$1 ORDER BY created_at DESC LIMIT 100`, [m.id]);
  const rewards = await db.q(`SELECT code, points, value, currency, state, created_at FROM rewards WHERE member_id=$1 ORDER BY created_at DESC LIMIT 50`, [m.id]);
  res.json({ member: serializeMember(m, cfg, req), history, rewards });
});
app.post("/api/members", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId; const cfg = await getConfig(mid, req.session.data?.merchant);
  const m = await upsertMember(mid, { email: req.body?.email, phone: req.body?.phone, name: req.body?.name });
  if (!m) return res.status(400).json({ error: "need_contact", message: "Add an email or phone." });
  res.status(201).json({ member: serializeMember(m, cfg, req) });
});

// Manual adjust (+/-) — comps, corrections.
app.post("/api/members/:id/adjust", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId; const cfg = await getConfig(mid, req.session.data?.merchant);
  const m = await db.one(`SELECT * FROM members WHERE id=$1 AND merchant_id=$2`, [req.params.id, mid]);
  if (!m) return res.status(404).json({ error: "not_found" });
  const pts = Math.round(Number(req.body?.points) || 0);
  if (!pts) return res.status(400).json({ error: "bad_amount" });
  if (m.points + pts < 0) return res.status(400).json({ error: "insufficient", message: "Member doesn't have that many points." });
  await db.run(`INSERT INTO txns (merchant_id, member_id, points, kind, reason) VALUES ($1,$2,$3,'adjust',$4)`, [mid, m.id, pts, req.body?.reason || "Manual adjustment"]);
  const u = await db.one(`UPDATE members SET points=points+$2, lifetime=lifetime+GREATEST($2,0) WHERE id=$1 RETURNING *`, [m.id, pts]);
  res.json({ member: serializeMember(u, cfg, req) });
});

// Redeem points → a reward voucher (real, spendable value). Used by the merchant
// (in person) and by the customer on their own member page.
async function redeemPoints(mid, cfg, member, points, by) {
  points = Math.round(points);
  if (points < cfg.min_redeem) return { error: "below_min", message: `Minimum redemption is ${cfg.min_redeem} points.` };
  if (points > member.points) return { error: "insufficient", message: "Not enough points." };
  const value = round2(points * Number(cfg.point_value));
  const code = genCode("LP");
  await db.run(`INSERT INTO rewards (merchant_id, member_id, code, points, value, currency) VALUES ($1,$2,$3,$4,$5,$6)`, [mid, member.id, code, points, value, cfg.currency]);
  await db.run(`INSERT INTO txns (merchant_id, member_id, points, kind, reason) VALUES ($1,$2,$3,'redeem',$4)`, [mid, member.id, -points, `Reward ${code} · ${cfg.currency} ${value}`]);
  const u = await db.one(`UPDATE members SET points=points-$2 WHERE id=$1 RETURNING *`, [member.id, points]);
  emailReward(cfg, u, { code, value, points }).catch(() => {});
  return { member: u, reward: { code, value, points, currency: cfg.currency } };
}
app.post("/api/members/:id/redeem", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId; const cfg = await getConfig(mid, req.session.data?.merchant);
  const m = await db.one(`SELECT * FROM members WHERE id=$1 AND merchant_id=$2`, [req.params.id, mid]);
  if (!m) return res.status(404).json({ error: "not_found" });
  const out = await redeemPoints(mid, cfg, m, Number(req.body?.points || m.points), req.actor?.name || "staff");
  if (out.error) return res.status(400).json(out);
  res.json({ member: serializeMember(out.member, cfg, req), reward: out.reward });
});

// Staff redeem a reward voucher in store (mark used).
app.post("/api/rewards/redeem", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  const code = String(req.body?.code || "").trim().toUpperCase();
  const r = await db.one(`SELECT * FROM rewards WHERE merchant_id=$1 AND code=$2`, [mid, code]);
  if (!r) return res.json({ found: false });
  if (r.state !== "issued") return res.json({ found: true, state: r.state, value: Number(r.value), currency: r.currency });
  const u = await db.one(`UPDATE rewards SET state='redeemed', redeemed_at=now(), redeemed_by=$2 WHERE id=$1 RETURNING *`, [r.id, req.actor?.name || "staff"]);
  res.json({ found: true, state: u.state, value: Number(u.value), currency: u.currency });
});
app.get("/api/rewards", core.requireSession, async (req, res) => {
  const rows = await db.q(`SELECT r.code, r.points, r.value, r.currency, r.state, r.created_at, r.redeemed_at, m.name, m.email FROM rewards r JOIN members m ON m.id=r.member_id WHERE r.merchant_id=$1 ORDER BY r.created_at DESC LIMIT 200`, [req.session.merchantId]);
  res.json({ rewards: rows.map((r) => ({ code: r.code, points: r.points, value: Number(r.value), currency: r.currency, state: r.state, created_at: r.created_at, redeemed_at: r.redeemed_at, member: r.name || r.email || "Member" })) });
});

// Manual backfill — award points for recent paid orders not yet credited.
app.post("/api/backfill", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId; const cfg = await getConfig(mid, req.session.data?.merchant);
  let awarded = 0, members = 0, scanned = 0;
  try {
    const list = await listInkressOrders(core.cfg, req.session.accessToken, "limit=100&order=id desc");
    // The orders list nests under result.entries (see order-tagger/receipts); accept the
    // other shapes too so a server-side rename can't silently zero out the backfill.
    const orders = Array.isArray(list) ? list : (list?.entries || list?.orders || list?.data || []);
    for (const o of orders) {
      scanned++;
      if (!isPaidStatus(o)) continue;
      const r = await awardForOrder(mid, cfg, {
        id: o.id, reference_id: o.reference_id, total: o.total,
        customer: o.customer, email: o.customer?.email || o.email, phone: o.customer?.phone,
      }, { emailMember: false }); // backfill is silent — don't blast historical customers
      if (r) { awarded += r.earned + r.bonus; members++; }
    }
  } catch (err) { return res.status(502).json({ error: "orders_failed", message: err?.message }); }
  res.json({ awarded, members, scanned });
});

// Webhook self-registration + status.
app.get("/api/status", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  let sub = await db.one(`SELECT * FROM webhook_subs WHERE merchant_id=$1`, [mid]);
  const canRegister = WEBHOOK_SECRET && (req.session.scope || []).includes("webhooks:manage");
  if (!sub && canRegister) {
    const url = `${PUBLIC_BASE(req)}/webhooks/inkress/${mid}`;
    try { await inkressApi(core.cfg, req.session.accessToken, `webhook_urls`, { method: "POST", body: JSON.stringify({ url, event: "orders" }) }); await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO UPDATE SET url=$2`, [mid, url]); sub = { merchant_id: mid, url }; }
    catch (err) { if (String(err?.message || "").match(/already|unique|exist|422/i)) { await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO NOTHING`, [mid, url]); sub = { merchant_id: mid, url }; } }
  }
  res.json({ realtime: Boolean(sub) && Boolean(WEBHOOK_SECRET), webhook_registered: Boolean(sub), can_register: Boolean(canRegister), ses_configured: sesConfigured() });
});

// ---- webhook receiver — auto-earn on paid order ----------------------------
app.post("/webhooks/inkress/:merchantId", async (req, res) => {
  const merchantId = Number(req.params.merchantId);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  if (WEBHOOK_SECRET) {
    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("base64");
    const got = String(req.get("x-inkress-webhook-signature") || "");
    const a = Buffer.from(expected), b = Buffer.from(got);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "bad_signature" });
  }
  res.json({ received: true });
  try {
    const evt = JSON.parse(raw.toString("utf8"));
    const o = evt?.order || evt?.data?.order;
    if (!o || !merchantId || String(o.status || "").toLowerCase() !== "paid") return;
    const wid = String(req.get("x-inkress-webhook-id") || `${o.id}.${o.status}`);
    if (await db.one(`SELECT 1 FROM webhook_seen WHERE webhook_id=$1`, [wid])) return;
    await db.run(`INSERT INTO webhook_seen (webhook_id) VALUES ($1) ON CONFLICT DO NOTHING`, [wid]);
    const cfg = await getConfig(merchantId, null);
    if (!cfg.auto_award) return;
    // Don't reward our own redemption vouchers if they ever flow back as orders.
    if (String(o.reference_id || "").startsWith("loyalty-")) return;
    await awardForOrder(merchantId, cfg, o, { emailMember: true });
  } catch (err) { console.error(`[loyalty] webhook failed: ${err?.message}`); }
});

// ---- public member page (self-service) -------------------------------------
app.get("/m/:token", async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const id = memberIdFromToken(req.params.token);
  const m = id ? await db.one(`SELECT * FROM members WHERE id=$1`, [id]).catch(() => null) : null;
  if (!m) return res.status(404).send(shell("Not found", `<div class="pad"><h1>Card not found</h1><p class="muted">This loyalty link isn't valid.</p></div>`));
  const cfg = await getConfig(m.merchant_id, null);
  res.send(memberPage(m, cfg, req.params.token));
});
app.get("/api/public/member/:token", async (req, res) => {
  const id = memberIdFromToken(req.params.token);
  const m = id ? await db.one(`SELECT * FROM members WHERE id=$1`, [id]).catch(() => null) : null;
  if (!m) return res.status(404).json({ error: "not_found" });
  const cfg = await getConfig(m.merchant_id, null);
  const history = await db.q(`SELECT points, kind, reason, created_at FROM txns WHERE member_id=$1 ORDER BY created_at DESC LIMIT 30`, [m.id]);
  const rewards = await db.q(`SELECT code, points, value, currency, state, created_at FROM rewards WHERE member_id=$1 AND state='issued' ORDER BY created_at DESC`, [m.id]);
  res.json({ name: m.name || "Member", points: m.points, value: round2(m.points * Number(cfg.point_value)), currency: cfg.currency,
    min_redeem: cfg.min_redeem, can_redeem: m.points >= cfg.min_redeem, point_value: Number(cfg.point_value),
    shop: cfg.merchant_name || "our shop", history, rewards: rewards.map((r) => ({ code: r.code, value: Number(r.value), points: r.points, currency: r.currency })) });
});
app.post("/api/public/member/:token/redeem", express.json(), async (req, res) => {
  const id = memberIdFromToken(req.params.token);
  const m = id ? await db.one(`SELECT * FROM members WHERE id=$1`, [id]).catch(() => null) : null;
  if (!m) return res.status(404).json({ error: "not_found" });
  const cfg = await getConfig(m.merchant_id, null);
  // Customer redeems either a chosen amount or their full balance.
  const points = Math.min(m.points, Math.max(cfg.min_redeem, Math.round(Number(req.body?.points) || m.points)));
  const out = await redeemPoints(m.merchant_id, cfg, m, points, "customer");
  if (out.error) return res.status(400).json(out);
  res.json({ points: out.member.points, value: round2(out.member.points * Number(cfg.point_value)), reward: out.reward });
});

// ---- digest scheduler (weekly / monthly balance email) ---------------------
async function runDigests() {
  if (!sesConfigured() || !PUBLIC_BASE_STR()) return;
  try {
    const cfgs = await db.q(`SELECT * FROM config WHERE digest IN ('weekly','monthly')`);
    const now = new Date(); const dow = now.getUTCDay(); const dom = now.getUTCDate(); const t = today();
    for (const cfg of cfgs) {
      const due = cfg.digest === "weekly" ? dow === 1 : dom === 1; // Mondays / 1st of month
      if (!due || cfg.last_digest_on === t) continue;
      const members = await db.q(`SELECT * FROM members WHERE merchant_id=$1 AND points>0 AND email IS NOT NULL LIMIT 2000`, [cfg.merchant_id]);
      for (const m of members) { await emailDigest(cfg, m).catch(() => {}); }
      await db.run(`UPDATE config SET last_digest_on=$2 WHERE merchant_id=$1`, [cfg.merchant_id, t]);
    }
  } catch (err) { console.error(`[loyalty] digest: ${err?.message}`); }
}
setInterval(runDigests, 3600 * 1000); setTimeout(runDigests, 60000);

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[loyalty] listening on ${HOST}:${PORT}`));

// ---- emails ----------------------------------------------------------------
function money(n, c) { try { return new Intl.NumberFormat("en-JM", { style: "currency", currency: c }).format(n); } catch { return `${c} ${n}`; } }
const memberLink = (m) => PUBLIC_BASE_STR() ? `${PUBLIC_BASE_STR()}/m/${memberToken(m.id)}` : null;
async function emailEarned(cfg, m, earned, bonus) {
  if (!sesConfigured() || !m.email) return;
  // throttle: at most one earn email per member per 6h (avoids spam on rapid orders)
  if (m.last_earn_email_at && (Date.now() - new Date(m.last_earn_email_at).getTime()) < 6 * 3600 * 1000) return;
  await db.run(`UPDATE members SET last_earn_email_at=now() WHERE id=$1`, [m.id]);
  const shop = cfg.merchant_name || "our shop"; const link = memberLink(m);
  const bonusLine = bonus > 0 ? `<p style="color:#2f9e44;margin:4px 0;">+${bonus} welcome bonus 🎉</p>` : "";
  await sendEmail({ to: m.email, subject: `You earned ${earned} points at ${shop}`, html: emailShell(shop, `
    <div style="font-size:38px">⭐</div><h2 style="margin:6px 0;">+${earned} points</h2>${bonusLine}
    <p style="color:#555;margin:6px 0 2px;">Your balance</p>
    <div style="font-size:30px;font-weight:800;">${m.points} pts</div>
    <p style="color:#888;font-size:13px;">worth about ${money(round2(m.points * Number(cfg.point_value)), cfg.currency)}</p>
    ${link ? `<p style="margin-top:16px;"><a href="${esc(link)}" style="background:#3b5bdb;color:#fff;padding:11px 20px;border-radius:9px;text-decoration:none;font-weight:700;">View my rewards</a></p>` : ""}`) });
}
async function emailReward(cfg, m, r) {
  if (!sesConfigured() || !m.email) return;
  const shop = cfg.merchant_name || "our shop";
  await sendEmail({ to: m.email, subject: `Your ${money(r.value, cfg.currency)} reward from ${shop}`, html: emailShell(shop, `
    <div style="font-size:38px">🎁</div><h2 style="margin:6px 0;">${money(r.value, cfg.currency)} reward</h2>
    <p style="color:#555;">You redeemed ${r.points} points. Show this code in store:</p>
    <div style="font-family:ui-monospace,monospace;font-size:24px;font-weight:800;letter-spacing:.08em;margin:8px 0;">${esc(r.code)}</div>
    <img src="${qrUrl(r.code, 160)}" width="150" height="150" style="border-radius:10px;background:#fff;padding:6px;" alt="">`) });
}
async function emailDigest(cfg, m) {
  const shop = cfg.merchant_name || "our shop"; const link = memberLink(m);
  await sendEmail({ to: m.email, subject: `You have ${m.points} points at ${shop}`, html: emailShell(shop, `
    <div style="font-size:38px">⭐</div><h2 style="margin:6px 0;">${m.points} points</h2>
    <p style="color:#888;font-size:13px;">worth about ${money(round2(m.points * Number(cfg.point_value)), cfg.currency)}</p>
    ${m.points >= cfg.min_redeem ? `<p style="color:#2f9e44;">You have enough to redeem a reward!</p>` : `<p style="color:#888;">Earn ${cfg.min_redeem - m.points} more to redeem a reward.</p>`}
    ${link ? `<p style="margin-top:16px;"><a href="${esc(link)}" style="background:#3b5bdb;color:#fff;padding:11px 20px;border-radius:9px;text-decoration:none;font-weight:700;">View my rewards</a></p>` : ""}`) });
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function emailShell(shop, inner) {
  return `<div style="font-family:system-ui,sans-serif;max-width:440px;margin:0 auto;text-align:center;color:#1a1a1a;padding:8px;">
    ${inner}<p style="color:#aaa;font-size:12px;margin-top:20px;">${esc(shop)} loyalty · via Marketplace</p></div>`;
}

// ---- public HTML -----------------------------------------------------------
function shell(title, inner, accent = "#3b5bdb") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f6f7f9;color:#1f2430;display:grid;place-items:center;min-height:100vh;padding:20px}
  .card{background:#fff;border:1px solid #e9ebef;border-radius:18px;box-shadow:0 14px 44px rgba(20,25,40,.12);max-width:420px;width:100%;overflow:hidden}
  .accent{height:4px;background:${accent}}.pad{padding:26px}.muted{color:#6b7280}
  h1{font-size:1.4rem;margin:0 0 6px;text-align:center}
  .bal{font-size:2.6rem;font-weight:800;text-align:center;margin:6px 0 0}.sub{text-align:center;color:#6b7280;margin:2px 0 16px}
  .row{display:flex;justify-content:space-between;padding:9px 0;border-top:1px solid #f0f1f4;font-size:14px}
  button{width:100%;padding:14px;border:0;border-radius:10px;background:${accent};color:#fff;font-size:15px;font-weight:700;cursor:pointer}
  button:disabled{opacity:.5}
  .rew{background:#eef1fd;border-radius:10px;padding:12px;text-align:center;margin:8px 0}
  .code{font-family:ui-monospace,monospace;font-weight:800;letter-spacing:.06em;font-size:18px}
  .foot{text-align:center;color:#aab;font-size:12px;padding:14px}</style></head>
  <body><div class="card"><div class="accent"></div>${inner}<div class="foot">powered by Marketplace</div></div></body></html>`;
}
function memberPage(m, cfg, token) {
  return shell(`${cfg.merchant_name || "Loyalty"} — your points`, `<div class="pad">
    <h1>${esc(cfg.merchant_name || "Loyalty")}</h1>
    <p class="muted" style="text-align:center;margin:0">${esc(m.name || "Your rewards")}</p>
    <div class="bal" id="bal">${m.points}</div><div class="sub">points · <span id="val"></span></div>
    <div id="rewards"></div>
    <button id="redeem" style="display:none"></button>
    <div id="hist" style="margin-top:14px"></div>
    <script>
    const tok=${JSON.stringify(token)};
    async function load(){const r=await fetch('/api/public/member/'+tok);const j=await r.json();
      const f=(n)=>new Intl.NumberFormat('en-JM',{style:'currency',currency:j.currency}).format(n);
      document.getElementById('bal').textContent=j.points;
      document.getElementById('val').textContent='worth about '+f(j.value);
      const rw=document.getElementById('rewards');rw.innerHTML=(j.rewards||[]).map(r=>'<div class="rew">Reward <b>'+f(r.value)+'</b><div class="code">'+r.code+'</div><div style="color:#6b7280;font-size:12px">show in store</div></div>').join('');
      const b=document.getElementById('redeem');
      if(j.can_redeem){b.style.display='block';b.textContent='Redeem '+j.points+' points for '+f(j.value);b.onclick=redeem;}
      else{b.style.display='block';b.disabled=true;b.textContent='Earn '+(j.min_redeem-j.points)+' more to redeem';}
      document.getElementById('hist').innerHTML=(j.history||[]).slice(0,8).map(h=>'<div class="row"><span>'+(h.reason||h.kind)+'</span><b style="color:'+(h.points<0?'#c92a2a':'#2f9e44')+'">'+(h.points>0?'+':'')+h.points+'</b></div>').join('');
    }
    async function redeem(){const b=document.getElementById('redeem');b.disabled=true;b.textContent='Redeeming…';
      const r=await fetch('/api/public/member/'+tok+'/redeem',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      const j=await r.json();if(j.reward){await load();}else{b.disabled=false;b.textContent=j.message||'Try again';}}
    load();
    </script></div>`);
}
