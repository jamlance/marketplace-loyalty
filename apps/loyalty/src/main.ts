import "./index.css";
import {
  initBv, bvApi, makeToast, type BvToastFn,
  mountShell, statRow, dataTable, card, openModal, flash,
  fmtMoney, relTime, pill, emptyState, h, iconEl,
} from "./bv-init";

interface Member { id: number; email: string | null; phone: string | null; name: string; points: number; lifetime: number; value: number; can_redeem: boolean; created_at: string; member_url: string | null; }
interface Txn { points: number; kind: string; reason: string | null; created_at: string; }
interface Reward { code: string; points: number; value: number; currency: string; state: string; created_at: string; redeemed_at?: string | null; member?: string; }
interface Config { points_per_unit: number; point_value: number; min_redeem: number; signup_bonus: number; auto_award: boolean; email_on_earn: boolean; digest: string; currency: string; }

const root = document.getElementById("root")!;
let toast: BvToastFn;
let merchantName = "Merchant";
let currency = "JMD";
let cfg: Config;
let sesOn = false, realtime = false, publicBase = false;
let shell: ReturnType<typeof mountShell>;
let memberSearch = "";

(async () => {
  let session;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has("inkress_session")) {
    const m = await import("./dev-mock"); m.installMockFetch(); session = m.mockSession();
  } else {
    try { session = await initBv(); }
    catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  merchantName = session.merchant.name || session.merchant.username || "Merchant";
  currency = session.merchant.currency_code || "JMD";

  await loadConfig();
  shell = mountShell({
    brandIcon: "sparkles", brandLogo: "/logo.svg", title: "Loyalty",
    subtitle: `${merchantName} · points & rewards`, poweredBy: "Marketplace",
    tabs: [
      { id: "overview", label: "Overview", icon: "chart", render: renderOverview },
      { id: "members", label: "Members", icon: "users", render: renderMembers },
      { id: "rewards", label: "Rewards", icon: "gift", render: renderRewards },
      { id: "settings", label: "Settings", icon: "settings", render: renderSettings },
    ],
  });
})();

async function loadConfig() {
  const r = await bvApi<{ config: Config; ses_configured: boolean; webhook_realtime: boolean; public_base: boolean }>("/api/config");
  cfg = r.config; sesOn = r.ses_configured; realtime = r.webhook_realtime; publicBase = r.public_base;
  currency = cfg.currency || currency;
}
const money = (n: number) => fmtMoney(n, currency);

// ---- Overview --------------------------------------------------------------
async function renderOverview(host: HTMLElement) {
  const data = await bvApi<{ stats: any; recent: any[]; currency: string; point_value: number }>("/api/overview");
  const s = data.stats;
  const parts: (HTMLElement | null)[] = [
    statRow([
      { k: "ACTIVE MEMBERS", v: String(s.members), icon: "users" },
      { k: "POINTS OUTSTANDING", v: s.outstanding.toLocaleString(), d: `≈ ${money(s.value_outstanding)}`, tone: "accent", icon: "sparkles" },
      { k: "REDEEMED", v: s.redeemed.toLocaleString(), icon: "gift" },
      { k: "LIFETIME EARNED", v: s.lifetime.toLocaleString(), icon: "chart" },
    ]),
    // Earn-from-sales: auto if realtime, manual backfill always available.
    card({
      title: "Earn from sales",
      action: h("button", { class: "bv-btn", onClick: backfill }, "Award points for recent orders"),
      body: h("p", { class: "bv-muted" },
        realtime
          ? `Members earn ${cfg.points_per_unit} point${cfg.points_per_unit === 1 ? "" : "s"} per ${currency} 1 spent — credited automatically the moment an order is paid. Use the button to backfill older orders.`
          : `Members earn ${cfg.points_per_unit} point per ${currency} 1 spent. Run this after sales to credit recent paid orders.`),
    }),
    realtime ? null : noticeRealtime(),
    sesOn ? null : noticeEmail(),
    card({
      title: "Recent activity",
      body: data.recent.length
        ? dataTable<any>({
            columns: [
              { head: "When", cell: (t) => relTime(t.created_at) },
              { head: "Member", cell: (t) => t.member },
              { head: "Type", cell: (t) => pill(t.kind, t.points < 0 ? "bad" : "ok") },
              { head: "Points", num: true, cell: (t) => h("b", { style: { color: t.points < 0 ? "#c92a2a" : "#2f9e44" } }, `${t.points > 0 ? "+" : ""}${t.points}`) },
            ],
            rows: data.recent,
          })
        : emptyState({ icon: "chart", title: "No activity yet", text: "Points appear here as customers earn and redeem." }),
    }),
  ];
  host.replaceChildren(...parts.filter((x): x is HTMLElement => x != null));
}

function noticeRealtime() {
  return card({ body: h("div", { class: "bv-note" },
    iconEl("alert", 18),
    h("div", null,
      h("b", null, "Automatic earning is off"),
      h("p", { class: "bv-muted" }, "This merchant connection can't register an order webhook yet, so points are credited only when you press “Award points”. Reconnect with the webhooks permission to enable real-time earning.")),
  ) });
}
function noticeEmail() {
  return card({ body: h("div", { class: "bv-note" },
    iconEl("send", 18),
    h("div", null,
      h("b", null, "Customer emails are off"),
      h("p", { class: "bv-muted" }, "Email isn't configured on this deployment, so customers won't be notified when they earn or get a reward. Points and redemption still work; set up SES to turn on the customer loop.")),
  ) });
}

async function backfill() {
  const r = await bvApi<{ awarded: number; members: number; scanned: number }>("/api/backfill", { method: "POST" });
  flash(r.awarded > 0 ? `Awarded ${r.awarded} points across ${r.members} member${r.members === 1 ? "" : "s"}.` : "All recent paid orders are already credited.", "success");
  shell.select("overview");
}

// ---- Members ---------------------------------------------------------------
async function renderMembers(host: HTMLElement) {
  const r = await bvApi<{ members: Member[] }>(`/api/members${memberSearch ? `?q=${encodeURIComponent(memberSearch)}` : ""}`);
  const searchEl = h("input", { class: "bv-input", placeholder: "Search members…", value: memberSearch,
    onInput: (e: any) => { memberSearch = e.target.value; }, onKeyDown: (e: any) => { if (e.key === "Enter") shell.select("members"); } }) as HTMLInputElement;
  host.replaceChildren(
    card({
      title: "Members",
      action: h("div", { class: "bv-row" }, searchEl, h("button", { class: "bv-btn ghost", onClick: () => shell.select("members") }, "Search"), h("button", { class: "bv-btn", onClick: addMember }, "Add member")),
      body: r.members.length
        ? dataTable<Member>({
            columns: [
              { head: "Member", cell: (m) => h("div", null, h("div", null, m.name), m.email || m.phone ? h("div", { class: "bv-muted bv-sm" }, m.email || m.phone) : null) },
              { head: "Points", num: true, cell: (m) => h("b", null, m.points.toLocaleString()) },
              { head: "Worth", num: true, cell: (m) => money(m.value) },
              { head: "Lifetime", num: true, cell: (m) => m.lifetime.toLocaleString() },
            ],
            rows: r.members,
            rowActions: (m) => h("button", { class: "bv-btn sm", onClick: () => openMember(m.id) }, "Open"),
            onRowClick: (m) => openMember(m.id),
          })
        : emptyState({ icon: "users", title: memberSearch ? "No matches" : "No members yet", text: memberSearch ? "Try another search." : "Members are added automatically when customers pay — or add one manually." }),
    }),
  );
}

async function openMember(id: number) {
  const r = await bvApi<{ member: Member; history: Txn[]; rewards: Reward[] }>(`/api/members/${id}`);
  const m = r.member;
  const body = h("div", null,
    h("div", { class: "bv-bigstat" }, h("div", { class: "v" }, m.points.toLocaleString()), h("div", { class: "k" }, `points · ${money(m.value)}`)),
    m.member_url ? h("div", { class: "bv-note" }, iconEl("link", 16), h("div", null, h("div", { class: "bv-muted bv-sm" }, "Customer rewards page"),
      h("a", { href: m.member_url, target: "_blank", class: "bv-link" }, m.member_url))) : null,
    h("div", { class: "bv-rowbtns" },
      h("button", { class: "bv-btn", disabled: !m.can_redeem, onClick: () => redeemMember(m) }, m.can_redeem ? `Redeem ${m.points} pts → ${money(m.value)}` : `Min ${cfg.min_redeem} pts to redeem`),
      h("button", { class: "bv-btn ghost", onClick: () => adjustMember(m) }, "Adjust"),
    ),
    r.rewards.length ? card({ title: "Rewards", body: dataTable<Reward>({
      columns: [{ head: "Code", cell: (x) => h("span", { class: "bv-mono" }, x.code) }, { head: "Value", num: true, cell: (x) => money(x.value) }, { head: "State", cell: (x) => pill(x.state, x.state === "redeemed" ? undefined : "ok") }],
      rows: r.rewards }) }) : null,
    card({ title: "History", body: r.history.length ? dataTable<Txn>({
      columns: [{ head: "When", cell: (t) => relTime(t.created_at) }, { head: "Reason", cell: (t) => t.reason || t.kind }, { head: "Points", num: true, cell: (t) => h("b", { style: { color: t.points < 0 ? "#c92a2a" : "#2f9e44" } }, `${t.points > 0 ? "+" : ""}${t.points}`) }],
      rows: r.history }) : emptyState({ icon: "chart", title: "No history" }) }),
  );
  openModal({ title: m.name, body });
}

function redeemMember(m: Member) {
  let modal: { close: () => void };
  modal = openModal({
    title: `Redeem points`,
    body: h("div", null,
      h("p", { class: "bv-muted" }, `Redeem ${m.points} points for a ${money(m.value)} reward voucher. The customer gets a code to use in store${sesOn ? " (emailed automatically)" : ""}.`),
      h("div", { class: "bv-note" }, iconEl("alert", 16), h("p", { class: "bv-muted bv-sm" }, "Heads up: Inkress can’t yet apply points as a discount at checkout — so redemption issues a reward voucher. See Settings for the platform note.")),
    ),
    actions: [
      { label: "Cancel" },
      { label: `Redeem ${money(m.value)}`, primary: true, onClick: () => {
        void (async () => {
          const r = await bvApi<{ reward: Reward }>(`/api/members/${m.id}/redeem`, { method: "POST", body: JSON.stringify({ points: m.points }) }).catch((e: any) => { flash(e?.message || "Redeem failed", "error"); return null; });
          if (r) { flash(`Issued reward ${r.reward.code} · ${money(r.reward.value)}`, "success"); modal.close(); shell.select("members"); }
        })();
        return true; // keep open; close on success
      } },
    ],
  });
}
function adjustMember(m: Member) {
  const pts = h("input", { class: "bv-input", type: "number", placeholder: "e.g. 50 or -50" }) as HTMLInputElement;
  const why = h("input", { class: "bv-input", placeholder: "Reason (optional)" }) as HTMLInputElement;
  let modal: { close: () => void };
  modal = openModal({ title: `Adjust ${m.name}`, body: h("div", null, h("label", { class: "bv-label" }, "Points (+/−)"), pts, h("label", { class: "bv-label" }, "Reason"), why),
    actions: [{ label: "Cancel" }, { label: "Apply", primary: true, onClick: () => {
      void (async () => {
        const r = await bvApi(`/api/members/${m.id}/adjust`, { method: "POST", body: JSON.stringify({ points: Number(pts.value), reason: why.value }) }).catch((e: any) => { flash(e?.message || "Failed", "error"); return null; });
        if (r) { flash("Balance updated", "success"); modal.close(); shell.select("members"); }
      })();
      return true;
    } }] });
}
function addMember() {
  const name = h("input", { class: "bv-input", placeholder: "Name" }) as HTMLInputElement;
  const email = h("input", { class: "bv-input", type: "email", placeholder: "Email" }) as HTMLInputElement;
  const phone = h("input", { class: "bv-input", placeholder: "Phone (optional)" }) as HTMLInputElement;
  let modal: { close: () => void };
  modal = openModal({ title: "Add member", body: h("div", null, h("label", { class: "bv-label" }, "Name"), name, h("label", { class: "bv-label" }, "Email"), email, h("label", { class: "bv-label" }, "Phone"), phone),
    actions: [{ label: "Cancel" }, { label: "Add", primary: true, onClick: () => {
      void (async () => {
        const r = await bvApi("/api/members", { method: "POST", body: JSON.stringify({ name: name.value, email: email.value, phone: phone.value }) }).catch((e: any) => { flash(e?.message || "Failed", "error"); return null; });
        if (r) { flash("Member added", "success"); modal.close(); shell.select("members"); }
      })();
      return true;
    } }] });
}

// ---- Rewards ---------------------------------------------------------------
async function renderRewards(host: HTMLElement) {
  const r = await bvApi<{ rewards: Reward[] }>("/api/rewards");
  const codeEl = h("input", { class: "bv-input bv-mono", placeholder: "LP-XXXX-XXXX", style: { textTransform: "uppercase" } }) as HTMLInputElement;
  host.replaceChildren(
    card({
      title: "Redeem a voucher in store",
      body: h("div", { class: "bv-row" }, codeEl, h("button", { class: "bv-btn", onClick: async () => {
        const code = codeEl.value.trim().toUpperCase(); if (!code) return;
        const v = await bvApi<{ found: boolean; state?: string; value?: number; currency?: string }>("/api/rewards/redeem", { method: "POST", body: JSON.stringify({ code }) });
        if (!v.found) flash("No reward with that code", "error");
        else if (v.state === "redeemed") flash(`Accepted — ${money(v.value || 0)} off`, "success");
        else flash(`Already ${v.state}`, "warning");
        shell.select("rewards");
      } }, "Accept")),
    }),
    card({
      title: "Issued rewards",
      body: r.rewards.length
        ? dataTable<Reward>({
            columns: [
              { head: "Code", cell: (x) => h("span", { class: "bv-mono" }, x.code) },
              { head: "Member", cell: (x) => x.member || "—" },
              { head: "Value", num: true, cell: (x) => money(x.value) },
              { head: "State", cell: (x) => pill(x.state, x.state === "redeemed" ? undefined : "ok") },
              { head: "When", cell: (x) => relTime(x.created_at) },
            ],
            rows: r.rewards,
          })
        : emptyState({ icon: "gift", title: "No rewards issued yet", text: "When a customer redeems points, the voucher appears here." }),
    }),
  );
}

// ---- Settings --------------------------------------------------------------
async function renderSettings(host: HTMLElement) {
  await loadConfig();
  const f = (k: keyof Config, attrs: any = {}) => h("input", { class: "bv-input", value: String(cfg[k]), ...attrs }) as HTMLInputElement;
  const ppu = f("points_per_unit", { type: "number", step: "0.1", min: "0" });
  const pv = f("point_value", { type: "number", step: "0.01", min: "0" });
  const minr = f("min_redeem", { type: "number", min: "1" });
  const bonus = f("signup_bonus", { type: "number", min: "0" });
  const auto = h("input", { type: "checkbox", checked: cfg.auto_award }) as HTMLInputElement;
  const onEarn = h("input", { type: "checkbox", checked: cfg.email_on_earn }) as HTMLInputElement;
  const digest = h("select", { class: "bv-input" },
    ...["off", "weekly", "monthly"].map((v) => h("option", { value: v, selected: cfg.digest === v }, v.charAt(0).toUpperCase() + v.slice(1)))) as HTMLSelectElement;

  host.replaceChildren(
    card({
      title: "Earning & rewards",
      action: h("button", { class: "bv-btn", onClick: save }, "Save settings"),
      body: h("div", { class: "bv-formgrid" },
        field(`Points per ${currency} 1 spent`, ppu),
        field(`Value of 1 point (${currency})`, pv),
        field("Minimum points to redeem", minr),
        field("Signup bonus (first order)", bonus),
      ),
    }),
    card({
      title: "Customer loop",
      body: h("div", null,
        toggle("Award points automatically on paid orders", auto, realtime ? "" : "Needs the webhooks permission — reconnect to enable."),
        toggle("Email the customer when they earn points", onEarn, sesOn ? "" : "Email isn’t configured on this deployment."),
        h("label", { class: "bv-label" }, "Balance reminder email"),
        digest,
        h("p", { class: "bv-muted bv-sm" }, "Send members a periodic reminder of their balance (off by default to avoid spam). Throttled so customers never get more than one earn-email every 6 hours."),
      ),
    }),
    // The one real platform gap, surfaced honestly.
    card({
      title: "Redemption today",
      body: h("div", { class: "bv-note" }, iconEl("wallet", 18), h("div", null,
        h("p", { class: "bv-muted" }, "Inkress doesn’t yet let an app apply a points discount directly to checkout. So redemption issues a reward voucher (a code worth the point value) the customer uses in store — real, spendable value today."),
        h("p", { class: "bv-muted bv-sm" }, "Platform ask: a “checkout adjustment” API would let points apply straight to a payment link / hosted checkout. Tracked as C8 in the marketplace review."))),
    }),
  );

  async function save() {
    const body = { points_per_unit: Number(ppu.value), point_value: Number(pv.value), min_redeem: Number(minr.value), signup_bonus: Number(bonus.value), auto_award: auto.checked, email_on_earn: onEarn.checked, digest: digest.value };
    const r = await bvApi<{ config: Config }>("/api/config", { method: "PATCH", body: JSON.stringify(body) }).catch((e: any) => { flash(e?.message || "Save failed", "error"); return null; });
    if (r) { cfg = r.config; flash("Settings saved", "success"); }
  }
}
function field(label: string, input: HTMLElement) { return h("div", null, h("label", { class: "bv-label" }, label), input); }
function toggle(label: string, input: HTMLInputElement, note: string) {
  return h("label", { class: "bv-toggle" }, input, h("span", null, label), note ? h("span", { class: "bv-muted bv-sm", style: { marginLeft: "auto" } }, note) : null);
}

function fatal(msg?: string) {
  return h("div", { class: "bv-shell" }, h("div", { class: "bv-card" }, h("h3", null, "Couldn’t load Loyalty"), h("p", { class: "bv-muted" }, msg || "Try reopening from the dashboard.")));
}
