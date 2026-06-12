# Loyalty

Points & rewards on the apps-core stack. Rebuilt 2026-06-12 to close the customer
loop that the legacy bserve Loyalty app was missing (earn-display + manual redeem,
no customer notification, no self-service, no real redemption value).

## What it does

**Earning**
- **Auto-earn on paid orders** via the Inkress `orders` webhook (HMAC-verified, idempotent
  per order). Members earn `points_per_unit` points per 1 unit of currency spent.
- **Signup bonus** on a member's first paid order (configurable, default 0).
- **Manual backfill** ("Award points for recent orders") for older/un-webhooked orders.

**Customer surface** (the gap in v1)
- **Email on earn** (SES, throttled to ≤1 per member per 6h) — "you earned X points,
  balance Y, worth ~Z".
- **Balance reminder digest** — optional weekly/monthly email (off by default to avoid spam).
- **Public member page** `/m/:token` — unguessable HMAC-signed link showing balance, value,
  history, issued rewards, and a **self-serve Redeem** button.

**Redemption** (real, spendable value today)
- Redeeming points issues a **reward voucher** (a `LP-XXXX-XXXX` code worth the point value)
  emailed to the customer and accepted in store via the Rewards tab.
- **Platform note (C8):** Inkress can't yet apply a points discount directly to checkout /
  a payment link. When a "checkout adjustment" API exists, redemption can apply straight to
  an order (the Promo Codes pattern). The voucher is the honest interim that moves real value.

**Merchant UI** — Overview (KPIs + activity + earn controls), Members (search, open, redeem,
adjust), Rewards (issued vouchers + accept-in-store), Settings (economics + customer-loop toggles).

## Stack
Express + `@inkress/apps-core` (Postgres schema `loyalty`, session via app-bridge, SES, webhooks,
`createInkressOrder`), Vite/TS SPA using the shared `apps-core/browser` UI kit. Mirrors `gift-cards`.

## Env
```
OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, INKRESS_API_BASE   # required
APPS_DATABASE_URL                                         # Postgres (shared db, own schema)
INKRESS_WEBHOOK_SECRET                                    # enables real-time auto-earn
PUBLIC_BASE_URL                                           # for member links + webhook URL
MEMBER_TOKEN_SECRET                                       # signs /m/:token (falls back to client secret)
AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, SES_FROM   # optional, for customer email
```
Scopes needed: `orders:read customers:read webhooks:manage offline_access`.

## Verified (2026-06-12, local Postgres)
- vite build + tsc clean.
- Signed paid-order webhook → member created + points awarded; replay is idempotent; bad
  signature → 401; signup bonus fires when configured.
- Public member JSON + HTML render; self-serve redeem deducts points and issues a voucher;
  below-minimum redeem is rejected; tampered token → 404.

## Not yet done (needs explicit go-ahead — outward-facing)
- `register-app` to mint client_id/secret/webhook_secret (replaces the legacy Loyalty registration).
- Coolify deploy. **Data migration** from the live legacy Loyalty (15 members / ~56k points)
  is a separate decision — the legacy app's DB isn't in this repo.
