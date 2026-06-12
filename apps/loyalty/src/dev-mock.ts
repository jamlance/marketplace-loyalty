/** DEV-ONLY preview harness — tree-shaken from prod. Lets `vite` render the
 *  SPA without a real Inkress session by faking the bridge + API. */
import type { BvSession } from "./bv-init";

let CONFIG = { points_per_unit: 1, point_value: 0.5, min_redeem: 100, signup_bonus: 50, auto_award: true, email_on_earn: true, digest: "off", currency: "JMD" };
let MID = 5;
const MEMBERS: any[] = [
  { id: 1, name: "Maria Gomez", email: "maria@example.com", phone: null, points: 1240, lifetime: 3200, value: 620, can_redeem: true, created_at: new Date(Date.now() - 9e8).toISOString(), member_url: location.origin + "/m/1.abcdef0123456789" },
  { id: 2, name: "Devon Brown", email: "devon@example.com", phone: null, points: 80, lifetime: 80, value: 40, can_redeem: false, created_at: new Date(Date.now() - 36e5).toISOString(), member_url: location.origin + "/m/2.abcdef0123456789" },
  { id: 3, name: "Kemar Reid", email: "kemar@example.com", phone: "+18761234567", points: 540, lifetime: 1900, value: 270, can_redeem: true, created_at: new Date(Date.now() - 5e8).toISOString(), member_url: location.origin + "/m/3.abcdef0123456789" },
];
const TXNS: Record<number, any[]> = {
  1: [{ points: 240, kind: "earn", reason: "Order #rmg36n8", created_at: new Date(Date.now() - 8e7).toISOString() }, { points: 50, kind: "signup", reason: "Welcome bonus", created_at: new Date(Date.now() - 9e8).toISOString() }, { points: -500, kind: "redeem", reason: "Reward LP-A1B2-C3D4 · JMD 250", created_at: new Date(Date.now() - 2e8).toISOString() }],
  2: [{ points: 80, kind: "earn", reason: "Order #abc", created_at: new Date(Date.now() - 36e5).toISOString() }],
  3: [{ points: 540, kind: "earn", reason: "Order #xyz", created_at: new Date(Date.now() - 2e7).toISOString() }],
};
const REWARDS: any[] = [{ code: "LP-A1B2-C3D4", points: 500, value: 250, currency: "JMD", state: "redeemed", created_at: new Date(Date.now() - 2e8).toISOString(), member: "Maria Gomez" }];

function overview() {
  const outstanding = MEMBERS.reduce((s, m) => s + m.points, 0);
  return { stats: { members: MEMBERS.length, outstanding, redeemed: 500, lifetime: MEMBERS.reduce((s, m) => s + m.lifetime, 0), value_outstanding: outstanding * CONFIG.point_value },
    recent: [{ points: 240, kind: "earn", reason: "", created_at: new Date(Date.now() - 8e7).toISOString(), member: "Maria Gomez" }, { points: -500, kind: "redeem", reason: "", created_at: new Date(Date.now() - 2e8).toISOString(), member: "Maria Gomez" }],
    currency: CONFIG.currency, point_value: CONFIG.point_value };
}

export function installMockFetch() {
  window.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(url, location.origin);
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
    await new Promise((r) => setTimeout(r, 70));
    const mm = u.pathname.match(/\/api\/members\/(\d+)(?:\/(adjust|redeem))?$/);

    if (u.pathname === "/api/config" && method === "GET") return json({ config: CONFIG, ses_configured: true, webhook_realtime: true, public_base: true });
    if (u.pathname === "/api/config" && method === "PATCH") { CONFIG = { ...CONFIG, ...body }; return json({ config: CONFIG }); }
    if (u.pathname === "/api/overview") return json(overview());
    if (u.pathname === "/api/status") return json({ realtime: true, webhook_registered: true, can_register: true, ses_configured: true });
    if (u.pathname === "/api/backfill") return json({ awarded: 320, members: 2, scanned: 40 });
    if (u.pathname === "/api/rewards" && method === "GET") return json({ rewards: REWARDS });
    if (u.pathname === "/api/rewards/redeem") { const r = REWARDS.find((x) => x.code === String(body.code).toUpperCase()); return json(r ? { found: true, state: "redeemed", value: r.value, currency: r.currency } : { found: false }); }
    if (u.pathname === "/api/members" && method === "GET") { const q = (u.searchParams.get("q") || "").toLowerCase(); const rows = q ? MEMBERS.filter((m) => (m.name + (m.email || "")).toLowerCase().includes(q)) : MEMBERS; return json({ members: rows }); }
    if (u.pathname === "/api/members" && method === "POST") { const m = { id: ++MID, name: body.name || body.email, email: body.email || null, phone: body.phone || null, points: 0, lifetime: 0, value: 0, can_redeem: false, created_at: new Date().toISOString(), member_url: location.origin + "/m/" + MID + ".x" }; MEMBERS.push(m); return json({ member: m }, 201); }
    if (mm && !mm[2]) { const m = MEMBERS.find((x) => x.id === Number(mm[1])); return json({ member: m, history: TXNS[m.id] || [], rewards: REWARDS.filter((r) => r.member === m.name) }); }
    if (mm && mm[2] === "adjust") { const m = MEMBERS.find((x) => x.id === Number(mm[1])); m.points += Number(body.points); m.value = m.points * CONFIG.point_value; m.can_redeem = m.points >= CONFIG.min_redeem; return json({ member: m }); }
    if (mm && mm[2] === "redeem") { const m = MEMBERS.find((x) => x.id === Number(mm[1])); const pts = Number(body.points) || m.points; const value = pts * CONFIG.point_value; const code = "LP-" + Math.random().toString(16).slice(2, 6).toUpperCase() + "-" + Math.random().toString(16).slice(2, 6).toUpperCase(); m.points -= pts; m.value = m.points * CONFIG.point_value; m.can_redeem = m.points >= CONFIG.min_redeem; REWARDS.unshift({ code, points: pts, value, currency: CONFIG.currency, state: "issued", created_at: new Date().toISOString(), member: m.name }); return json({ member: m, reward: { code, value, points: pts, currency: CONFIG.currency } }); }
    return json({ error: "not_mocked", path: u.pathname }, 404);
  };
}

export function mockSession(): BvSession {
  return {
    inkress: { merchant: { id: 183, username: "jackjack", name: "Jack Jack", currency_code: "JMD" }, toast: () => {} } as any,
    merchant: { id: 183, username: "jackjack", name: "Jack Jack", currency_code: "JMD", email: null, logo: null },
    user: { id: 1, name: "Dev User", email: "dev@example.com" } as any,
    scopes: ["orders:read", "customers:read", "webhooks:manage", "offline_access"],
  };
}
