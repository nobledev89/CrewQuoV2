# CrewQuo v2 — Progress & To-Do

Living checklist for the build. Full detail for every item is in **[CREWQUO_V2_PLAN.md](./CREWQUO_V2_PLAN.md)** (section references below). Phases are shipped one at a time — do not batch.

**Legend:** `[x]` done · `[~]` in progress · `[ ]` not started

Last updated: 2026-07-21 · Current phase: **Phase 3 (not started)** · Phase 2 shipped

---

## ✅ Phase 0 — Foundations (DONE — commit `78220a3`)

- [x] pnpm + Turborepo monorepo (`apps/*`, `packages/*`, `infra/`)
- [x] Root config: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`, `.gitattributes`, `.nvmrc`, `.env.example`
- [x] `packages/shared`: domain enums + Zod schemas (health, error envelope) + unit tests (vitest)
- [x] `apps/api`: Express 5 + node-postgres, Zod-validated env, `GET /` and `GET /healthz` (DB ping)
- [x] `infra/migrations/run.ts`: forward-only SQL migration runner (`schema_migrations`, per-file transactions)
- [x] `infra/migrations/0001_init.sql`: `users`, `companies`, `memberships`, `refresh_tokens`, `system_settings`
- [x] `infra/seed/index.ts`: placeholder seed
- [x] `infra/docker-compose.yml`: local Postgres 16
- [x] `infra/render.yaml`: Render blueprint (API + Postgres)
- [x] CI workflow (`.github/workflows/ci.yml`): type-check + test
- [x] `README.md`
- [x] **Verified:** `pnpm install`, `pnpm type-check`, `pnpm test` (3 passing), API boots on :4000
- [x] Initial git commit in a fresh repo (local only — no GitHub remote yet)

**Deferred within Phase 0 (small, non-blocking):**
- [ ] ESLint config (skipped for now; type-check + test are the CI gates)
- [ ] Bundled production build for `apps/api` (currently runs via `tsx`)
- [ ] Push to a GitHub remote (needs the user's account/decision)

---

## ✅ Phase 1 — Identity, tenancy & entitlements (DONE) — plan §3.1, §4, §5, §5B

- [x] Migrations: entitlements tables — `features`, `limits`, `plans`, `plan_prices`, `plan_features`, `plan_limits`, `company_subscriptions`, `company_entitlement_overrides` (`0002_entitlements.sql`)
- [x] Auth: `POST /v1/auth/register | login | google | refresh | logout | request-password-reset | reset-password | verify-email` (bcryptjs cost 12 + JWT access/refresh, hashed+rotating `refresh_tokens`)
- [x] Google sign-in (`google-auth-library` verify-id-token; 501/validation until `GOOGLE_CLIENT_ID` set)
- [x] Auth-context middleware (`Ctx`) resolving active company from `X-Company-Id` vs `memberships` (role read from DB per request — no claims)
- [x] `authorization/policies.ts` (company scoping, role gates, engagement one-hop, PAY/BILL guard, work-workflow invariants) + unit tests
- [x] Entitlements engine: `resolveEntitlements` (plan ⊕ overrides), `hasFeature`, `withinLimit`, `requireFeature` guard, in-process TTL cache (Redis swap-in Phase 2)
- [x] Super-admin plan CRUD (`/v1/admin/plans[/:id][/prices]`, `/features`, `/limits`) + seeded default plans (Crew/Starter/Pro/Business/Enterprise, USD anchor prices)
- [x] `GET /v1/me`, `/v1/me/memberships`, `POST /v1/me/companies`; `GET /v1/entitlements` (resolved + live usage)
- [x] Minimal Expo app (`apps/mobile`, expo-router): login, register, home (plan/usage), company switcher; secure-store token storage + refresh-on-launch
- [x] Tests (28 passing) + type-check green across `@crewquo/shared`, `@crewquo/api`, `@crewquo/mobile`
- [x] **Verified end-to-end** against live Postgres: migrate + seed + full auth/entitlements/admin smoke (register→me→switch→entitlements→refresh-rotation→super-admin CRUD)
- [x] **Milestone:** log in, pick a company, gates read from configurable plans ✅

**Deferred within Phase 1 (non-blocking):**
- [ ] Email delivery (Resend) for verify/reset links — currently logged in dev (arrives Phase 5, §5)
- [ ] `api-client` package extraction (mobile currently uses an inline typed fetch client)
- [ ] Redis-backed entitlement cache (in-process TTL for now; Phase 2 stack)

> **Local env note:** two native Postgres instances occupy host ports 5432/5433 on this machine, shadowing the docker container (which binds IPv6). Phase 1 was verified with the compose Postgres remapped to `127.0.0.1:15432`. `infra/docker-compose.yml` still targets 5432 — free those ports or remap before `pnpm db:migrate`.

## ✅ Phase 2 — Rate engine + catalog (DONE) — plan §3.3, §6

- [x] Rate engine in `packages/shared/src/rate-engine/` (pure TS): `shiftTypeToRateLabel`, `resolveRateLabel` (FRI_SAT_NIGHT date logic), `selectEffectiveCard`, `extractRate`, `resolveRate`, `applyMinHours`, `getHolidayInfo`, `calculateCost`, `calculateMargin` — 37 vitest cases pinning every branch
- [x] Migration `0003_rates.sql`: `role_catalog`, `rate_card_templates` (holiday/timeframe defs), `rate_cards` (PAY/BILL)
- [x] `GET /v1/rates/resolve?roleId&shiftType&date&kind&counterpartyId` (counterparty-specific > default; date-driven label)
- [x] CRUD: `/v1/role-catalog`, `/v1/rate-card-templates`, `/v1/rate-cards` — company-scoped; manager+ to edit, any member reads
- [x] Shared Zod contracts (`rates.ts`) incl. mode-required-rate + effective-date `superRefine`
- [x] **Verified end-to-end** vs live Postgres: register→role→PAY/BILL cards→resolve (Fri-night ⇒ FRI_SAT_NIGHT + default OT, weekday BILL, 404 when unmatched, 422 on invalid card). 70 tests green, type-check clean.
- [x] Web console (`apps/web`, Next.js 14 app-router) to manage roles, rate cards & templates + a resolve tester — auth/company-switcher, typed API client, `packages/ui` neutral design system
- [x] **Milestone:** rates resolve for a date+shift with correct margins ✅

> **Note on `FRI_SAT_NIGHT` (owner decision #4, §17):** a NIGHT shift on a Friday/Saturday resolves to `FRI_SAT_NIGHT`; all other labels are date-independent. This override was **reconstructed from the plan spec**, not v1 `rates.ts` (unavailable in this workspace). Verify against v1 before relying on it for real billing — it's isolated in `resolveRateLabel` and its tests, so a correction is a one-function change.
>
> **BILL-visibility scope:** `/v1/rate-cards` only ever returns the active company's *own* cards (PAY and BILL), so nothing leaks here. The provider-never-reads-client-BILL rule (§4) bites when reading an engagement's *counterparty* cards — that's a Phase 3 (projects/engagements) concern.

## Phase 3 — The core loop (mobile-first) — plan §3.2, §3.4

- [ ] Migrations: `engagements`, `projects`, `project_assignments`, `time_logs`, `expenses`, `project_submissions`, `invites`
- [ ] Providers + members + invite accept flow (public token endpoints)
- [ ] Work workflow: `DRAFT → SUBMITTED → APPROVED/REJECTED` (provider submits, client approves)
- [ ] `GET /v1/projects/:id/summary` (server-computed costs/margins)
- [ ] Mobile: log time → submit; approvals inbox (swipe approve/reject); push notifications
- [ ] **Milestone:** a subcontractor logs time on a phone and an admin approves it

## Phase 4 — Client portal + exports + audit — plan §3.6

- [ ] Migrations: `line_item_notes`, `audit_logs`, `audit_settings`
- [ ] Client portal (client-side of engagements; `projects.client_visible`)
- [ ] Audit logging (append-only) + nightly `expires_at` cleanup job
- [ ] Server-side PDF/XLSX exports (`jspdf`/`xlsx` in the API)
- [ ] Placeholder → linked company **merge flow**
- [ ] **Milestone:** a client logs in, sees only granted projects + visible audit trail, downloads an export

## Phase 5 — Billing, invoicing, notifications, polish — plan §3.5, §5B

- [ ] Migrations: `invoices`, `invoice_items`
- [ ] Merchant-of-Record billing (Lemon Squeezy / Paddle): checkout, webhooks, trial→paid, entitlement snapshots
- [ ] Super-admin price editor + subscription management
- [ ] Push + email notifications (Resend)
- [ ] Reports; EAS store submission
- [ ] Public marketing + legal pages (pricing/terms/privacy/refunds)

## Phase 6 — Deferred

- [ ] Offline draft capture (mobile)
- [ ] Real-time updates
- [ ] Optional v1 → v2 per-customer data importer (§12)

---

## ⚠️ Decisions still needed from the owner (plan §17)

Ask before building the affected phase — do not guess:

- [ ] **Real per-currency pricing numbers** (USD anchors exist; confirm values + which currencies) — Phase 1/5
- [ ] **Placeholder→linked merge policy** (auto vs manual; re-pointing engagements) — Phase 4
- [ ] **Final MoR choice** (Lemon Squeezy vs Paddle) + confirmed PH payout method — Phase 5
- [ ] **`FRI_SAT_NIGHT` rate-label date logic** — verify against v1 `rates.ts` when porting — Phase 2
- [~] **Visual design system** (brand colors/typography for `packages/ui`) — a neutral placeholder ships in `packages/ui` (system font, neutral grays + one accent, light/dark). Swap the `:root` tokens in `packages/ui/src/styles.css` to rebrand. Confirm the real brand before external-facing UI (Phase 4 client portal / Phase 5 marketing).
