# CrewQuo v2 — Progress & To-Do

Living checklist for the build. Full detail for every item is in **[CREWQUO_V2_PLAN.md](./CREWQUO_V2_PLAN.md)** (section references below). Phases are shipped one at a time — do not batch.

**Legend:** `[x]` done · `[~]` in progress · `[ ]` not started

Last updated: 2026-08-17 · Current phase: **Phase 4 (audit + portal landed; exports & web screens next)** · Phase 3 shipped

> **Scope expanded 2026-08-17.** Phases 7–12 (project evidence, site diary, locations, asset & material tracking, the sustainability/carbon engine, reporting, variations, scheduling, compliance) are now specified in **Part II of the plan (§19–§47)**. Everything below Phase 6 is new work; Phases 0–4 are unaffected and must not regress.
>
> **Web-first reorder 2026-08-17 (owner decision — plan decision #21).** **Phases 6W–12 are web-only. No new mobile screen until Phase 13.** Phase 6W is a new gate that closes the web parity backlog (plan §9.1) — Phases 1–3 were built mobile-first, so `apps/web` currently has only a landing page, login, a dashboard home and the 4 rate screens, while projects, approvals, providers, members, portal and the admin console have **no web UI at all**. Shipped mobile screens are **maintained, not deleted**: they keep working and stay green in CI. A phase is not done until its web surface is complete — every state, not a happy path.

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
- [x] `render.yaml`: Render blueprint (API + Postgres) — at the repo root, which is the only place Render reads it (moved from `infra/` 2026-08-17)
- [x] CI workflow (`.github/workflows/ci.yml`): type-check + test
- [x] `README.md`
- [x] **Verified:** `pnpm install`, `pnpm type-check`, `pnpm test` (3 passing), API boots on :4000
- [x] Initial git commit in a fresh repo
- [x] Pushed to GitHub — `origin` = `git@github.com:nobledev89/CrewQuoV2.git`, tracking `main`

**Deferred within Phase 0 (small, non-blocking):**
- [ ] ESLint config (skipped for now; type-check + test are the CI gates)
- [ ] Bundled production build for `apps/api` (currently runs via `tsx`)

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

> **Local env note (resolved 2026-08-17):** native Postgres instances occupy host ports 5432, 5433 **and 5434** on this machine, and none accepts the `crewquo` role. `infra/docker-compose.yml` now binds explicitly to IPv4 loopback and takes the host port from `POSTGRES_HOST_PORT` (default 5432, so nothing changes for other machines); this repo's `.env` sets it to **15432** and points `DATABASE_URL` at `127.0.0.1:15432`. Bring the DB up with `docker compose --env-file .env -f infra/docker-compose.yml up -d`. This removes the port-shadowing footgun that dogged Phases 1–3.

## ✅ Phase 2 — Rate engine + catalog (DONE) — plan §3.3, §6

- [x] Rate engine in `packages/shared/src/rate-engine/` (pure TS): `shiftTypeToRateLabel`, `resolveRateLabel` (FRI_SAT_NIGHT date logic), `selectEffectiveCard`, `extractRate`, `resolveRate`, `applyMinHours`, `getHolidayInfo`, `calculateCost`, `calculateMargin` — 37 vitest cases pinning every branch
- [x] Migration `0003_rates.sql`: `role_catalog`, `rate_card_templates` (holiday/timeframe defs), `rate_cards` (PAY/BILL)
- [x] `GET /v1/rates/resolve?roleId&shiftType&date&kind&counterpartyId` (counterparty-specific > default; date-driven label)
- [x] CRUD: `/v1/role-catalog`, `/v1/rate-card-templates`, `/v1/rate-cards` — company-scoped; manager+ to edit, any member reads
- [x] Shared Zod contracts (`rates.ts`) incl. mode-required-rate + effective-date `superRefine`
- [x] **Verified end-to-end** vs live Postgres: register→role→PAY/BILL cards→resolve (Fri-night ⇒ FRI_SAT_NIGHT + default OT, weekday BILL, 404 when unmatched, 422 on invalid card). 70 tests green, type-check clean.
- [x] Web console (`apps/web`, Next.js 14 app-router) to manage roles, rate cards & templates + a resolve tester — auth/company-switcher, typed API client, `packages/ui` neutral design system
- [x] **Milestone:** rates resolve for a date+shift with correct margins ✅

**Phase 2 follow-up — de-hardcode the rate-label rules (owner decision, 2026-08-17):**

- [ ] Move the `FRI_SAT_NIGHT` override out of `resolveRateLabel` ([engine.ts:45-52](packages/shared/src/rate-engine/engine.ts#L45-L52)) into per-company `rate_card_templates` data — which days/times map to which label is a company setting, not product logic
- [ ] Migration: default `companies.currency` to `'USD'` (currently `'GBP'`, `0001_init.sql:21`) + a settings endpoint to change it. **Two** places hardcode GBP — the column default and `auth/service.ts:74`, which stamps it on every company created at registration
- [ ] Web UI for editing the label rules; keep existing cards working (labels are stored per card, so shipped data is unaffected)

> **Superseded note on `FRI_SAT_NIGHT`:** a NIGHT shift on a Friday/Saturday resolves to `FRI_SAT_NIGHT`; all other labels are date-independent. This was **reconstructed from the plan spec**, not v1 `rates.ts`. It is no longer a "verify against v1" item — per the owner, no rate rule may be hardcoded at all, so the branch gets replaced by company config rather than corrected.
>
> **BILL-visibility scope:** `/v1/rate-cards` only ever returns the active company's *own* cards (PAY and BILL), so nothing leaks here. The provider-never-reads-client-BILL rule (§4) is realised in Phase 3: a project summary computes BILL/margin only for the *owner* (client) side; the provider only ever sees its frozen PAY snapshot.

## ✅ Phase 3 — The core loop (mobile-first) (DONE) — plan §3.2, §3.4

- [x] Migration `0004_core_loop.sql`: `engagements`, `projects`, `project_assignments`, `time_logs`, `expenses`, `project_submissions`, `invites`, `push_tokens`
- [x] Engagements: `GET/POST/PATCH /v1/engagements` (create-as-client needs `operates_downstream` + `withinLimit active_subcontractors`); one-hop visibility enforced
- [x] Providers + members + invites: `GET/POST /v1/providers` (placeholder company + engagement + invite, atomic), `GET /v1/members` + `POST /v1/members/invite`, public `GET /v1/invites/:token` + authed `POST /v1/invites/:token/accept` (MEMBER joins; ENGAGEMENT → OWNER of placeholder + edge goes ACTIVE)
- [x] Projects + assignments: CRUD `/v1/projects`, `POST /v1/projects/:id/assignments` (engagement derived), `GET /v1/projects/:id/summary` (server-computed labor cost from rate snapshots + best-effort BILL/margin)
- [x] Work workflow: `time_logs` / `expenses` / `project_submissions` — `DRAFT → SUBMITTED → APPROVED/REJECTED`, provider edits DRAFT/REJECTED & drives DRAFT→SUBMITTED, client reviews (reuses Phase 1 `policies.ts`). PAY rate snapshot frozen at submit (§6). `GET /v1/work-context` feeds the mobile log-time screen.
- [x] Live usage meters wired: `active_subcontractors`, `clients`
- [x] Mobile (Expo): **Log time** screen (assigned project → client role → shift/date/hours → submit) and **Approvals** inbox (approve/reject); home nav
- [x] Push: `apps/mobile` bound to EAS project `f8344de3-…`, `expo-notifications` device-token registration → `POST /v1/push/tokens`; API sends Expo push on submit (→ client managers) and approve/reject (→ the logger)
- [x] **Verified end-to-end** vs live Postgres: two companies via invite accept → role + PAY card → project + assignment → provider logs time → submit (snapshot **40000¢ = 8h×5000**) → client approves; workflow guards (provider-approve 403, re-submit 409), one-hop (outsider sees 0), and summary margin (bill **64000¢**, margin **24000¢**, **37.5%**) all correct. 70 tests green, all 5 packages type-check.
- [x] **Milestone:** a subcontractor logs time on a phone and an admin approves it ✅

> **Deferred (non-blocking):** expense **receipt upload** (`receipt_url` stays null — needs R2/object storage); `CLIENT_PORTAL` invite kind (arrives with the Phase 4 portal). **One-time human step for push:** run `eas login` locally then a dev/prod build — `eas`/`getExpoPushTokenAsync` need your Expo account and a physical device (simulator is a no-op). Expo push tokens can't be minted from CI here.

## Phase 4 — Client portal + exports + audit (in progress) — plan §3.6

- [x] Migration `0005_portal_audit.sql`: `line_item_notes`, `audit_logs`, `audit_settings`
- [x] Audit logging (append-only): `recordAudit` writes at every Phase 3 mutation site (work submit/approve/reject, project CRUD, assignments, engagements, invites) + `GET /v1/audit-logs` (own trail, or a counterparty's client-visible slice via `?engagementId=`)
- [x] Per-engagement portal settings: `GET/PUT /v1/audit-settings/:engagementId` (`client_can_comment`, `show_audit_trail`) — provider side manages, either side reads
- [x] Retention: `expires_at` stamped from `audit_retention_days` (`'infinity'` when unlimited; retention 0 ⇒ nothing written) + nightly purge (in-process daily timer, or `pnpm --filter @crewquo/api purge-audit`)
- [x] 78 tests green (8 new: retention mapping + portal-visibility policies), all 5 packages type-check
- [x] **Verified end-to-end** vs live Postgres (30 checks): invite→accept→role→PAY card→project→assignment→submit→approve, then submit/approve both recorded on the right side of the edge, `expires_at` = 90d on `pro`, internal events never client-visible, counterparty read **403 until the provider flips `show_audit_trail`** then returns only its client-visible rows, client side can't change portal settings (403), outsider 404s on the engagement, Crew plan refused the trail (403) and writes **zero** rows, purge deletes expired rows and keeps `'infinity'` ones
- [x] Client portal: `GET /v1/portal/projects[/:id]` — client side of the edge, `projects.client_visible`, gated on the **owner's** `client_portal` feature (a free-plan client can still be shown a portal by a provider who pays for one). Line items are priced **BILL-side** via the new shared `projects/billing.ts` (also now used by the owner's summary, so the two can't disagree)
- [x] `line_item_notes` CRUD (`/v1/line-item-notes`) — write gated on the owner's `client_portal_notes` + that engagement's `client_can_comment`; body edits are the author's alone, `resolved` is shared. Anchors validated against the engagement so a note can't be pinned to another edge's line item
- [x] `CLIENT_PORTAL` invite kind + `GET/POST /v1/clients` (placeholder client company + engagement + invite, atomic) — the mirror of `/v1/providers` and the only origin of a CLIENT_PORTAL invite; meters against `clients`
- [x] Placeholder → linked company **merge flow**: **auto-merge** on accept, no prompt (owner decision 2026-08-17). Re-points engagement, assignments, time logs, expenses, submissions and rate-card counterparties, then leaves the placeholder as a tombstone (`claimed_by_company_id`) so old ids still resolve
- [x] 89 tests green (11 new: portal read, note-write matrix, merge decision), all 5 packages type-check
- [x] **Verified end-to-end** vs live Postgres (**55 checks**): client invited → claims placeholder → work logged/approved by the owner → portal shows the line at **BILL 64000¢** while the PAY snapshot stays **40000¢**, with no PAY figure, rate snapshot, or subcontractor identity anywhere in the payload; notes honour `client_can_comment` (client 403s, owner unaffected); outsider/owner/unpublished all 404; Crew plan can't add a portal client (403); auto-merge re-points the edge and creates **no** placeholder membership; a colliding second merge **declines** and claims instead, leaving the first merge untouched
- [ ] Server-side PDF/XLSX exports (`jspdf`/`xlsx` in the API)
- [ ] Web portal screens in `apps/web` (Codex's redesign covers the Phase 2 console only — no `/portal` route yet)
- [ ] **Milestone:** a client logs in, sees only granted projects + visible audit trail, downloads an export

> **Audit design notes.** `audit_logs.company_id` is *whose activity* it is (the actor's active company) and `visible_to_client` says whether the company that hired them may see the row — so exposure is opt-in three times over: the row's flag, the provider's `audit_visibility` feature, and that engagement's `show_audit_trail`. Descriptions never name a counterparty, so a visible row can't leak who a subcontractor is. `recordAudit` never throws: a broken trail must not fail an approval, so failures are logged instead. Starter plans retain 30 days but can't *read* the trail until Pro — that's the seed's intent (§5B), not a bug.

## Phase 5 — Billing, invoicing, notifications, polish — plan §3.5, §5B

- [ ] Migrations: `invoices`, `invoice_items`
- [ ] Merchant-of-Record billing via **Gumroad** (decided 2026-08-17): checkout, webhooks, trial→paid, entitlement snapshots
- [ ] Super-admin price editor + subscription management
- [ ] Push + email notifications (Resend)
- [ ] Reports *(EAS store submission moved to Phase 13.9)*
- [ ] Public marketing + legal pages (pricing/terms/privacy/refunds)

## Phase 6 — Deferred

- [ ] Offline draft capture (mobile) — *now decided inside Phase 13.8 rather than here*
- [ ] Real-time updates
- [ ] Optional v1 → v2 per-customer data importer (§12)

---

# v2.1 — Field Operations, Evidence & Sustainability (plan Part II, §19–§47)

Not started. Sequencing: finish Phase 4's **export engine** first (§29 builds on it), then **Phase 6W**; Phase 5 billing is independent and can land whenever revenue requires it. Full roadmap in plan §42.

## Phase 6W — Web parity *(new gate — must clear before Phase 7)* — plan §9.1

**No new backend work.** Every endpoint below already exists, is tested and is verified end-to-end against live Postgres. This is UI only — the bill for building Phases 1–3 mobile-first.

- [ ] Auth completion: register, forgot/reset password, verify email, profile, company switcher
- [ ] Entitlements: plan + live usage, limit-reached and feature-locked states
- [ ] Engagements: list (both sides), create, pause/end
- [ ] Providers & clients: list, add provider (placeholder + invite), add portal client
- [ ] Members + invites, incl. the **public invite-accept page**
- [ ] Projects: list, detail, create/edit, provider assignment, summary with cost/bill/margin
- [ ] Time & expenses: entry + **bulk review/approve at scale** (filters, multi-select, reject-with-reason) — the clearest web-over-mobile win
- [ ] Client portal: client-side project list + detail, line items, notes thread
- [ ] Audit trail viewer + per-engagement visibility settings
- [ ] Super-admin console: plans/prices/features/limits CRUD, companies + overrides
- [ ] Playwright E2E: register → company → provider invite → project → log time → approve → portal → audit
- [ ] **Milestone:** every workflow CrewQuo already supports is doable on the web app — no phone required

**Non-negotiable throughout:** the ten calculation principles (§41), `record_revisions` + `recordAudit` on every new mutation (§36), entitlement keys registered (§43), tests written with the code (§44), and the Phase 0–4 end-to-end scripts re-run green at the end of every phase.

## Phase 7 — Evidence foundations — plan §21–§24, §37

- [ ] **7.0 Storage service** (§22.1): `stored_files`, R2 presign → PUT → complete, `sharp` WEB/THUMB derivatives, originals retained, authorized presigned downloads, `storage_gb` metering. **Retro-fits the Phase 3 deferred expense receipt upload.**
- [ ] **7.1 Capability layer** (§37): `capabilities`, bundles, per-membership overrides, `resolveCapabilities`, `hasCapability`. Null bundle derives from the existing role — zero behaviour change for existing companies
- [ ] **7.2 Project locations** (§21): tree, depth cap 4, cycle rejection
- [ ] **7.3 Project evidence** (§22): 14 categories, batch upload + camera + drag-drop, batch metadata, three distinct timestamps, gallery/timeline/filters, sticky report selection
- [ ] **7.4 Project documents** (§24): 16 categories, versioning via `supersedes_id`, expiry
- [ ] **7.5 Site diary** (§23): structured attendance, Close Day, post-close revisions with required reason + "amended N times" everywhere it appears
- [ ] **7.6 Web UI:** project section shell (§20) — evidence gallery/timeline/filters with drag-and-drop batch upload, document manager, diary editor with Close Day *(camera capture is Phase 13)*
- [ ] **Milestone:** a full day's evidence — photos, documents, closed diary entry — captured and organised on the project from a desktop

## Phase 8 — Assets & materials — plan §25

- [ ] `asset_types` seeded (**no invented default weights** — §41.1) + custom types
- [ ] `project_assets`: bulk lines by default, item-level opt-in, weight basis UNIT/TOTAL with derived counterpart
- [ ] Weight provenance: 7 sources → 4 confidence levels; `VERIFIED`/`DOCUMENTED` require a document
- [ ] `destination_types` seeded with the 11 destinations, hierarchy tiers and counts-as flags (**storage is not a final outcome**)
- [ ] `destination_organisations`; `asset_movements` with partial splits, derived `outcome_state`, evidence/document links
- [ ] Mass roll-ups with the allocated/pending split (§28.2) — mass only, no carbon yet
- [ ] Web asset table: inline edit, bulk entry/paste-import, movement recording, destination assignment
- [ ] **Milestone:** 42 chairs in, 30 donated / 12 recycled out, tonnage split reported correctly

## Phase 9 — Sustainability engine — plan §26–§28, §39

- [ ] `emission_factor_sets` + `emission_factors` + **importer** (column mapping, dry-run diff, validation) and admin UI — ships **zero fabricated rows** (§26.2)
- [ ] `product_carbon_factors` + preferred-source resolver (EPD → sector → org → generic); no factor ⇒ no claim (§26.3)
- [ ] `packages/shared/src/carbon-engine/` — pure functions, exhaustive tests **before** anything renders a number (§27.1, §44)
- [ ] `project_activities` (vehicle/fuel/electricity/freight); `carbon_calculations` with buckets + supersession; `avoided_emissions_claims` (§27)
- [ ] Project Sustainability section: mass balance, rates over allocated mass with pending shown, two separate carbon headlines, data completeness with named gaps (§28)
- [ ] Organisation sustainability dashboard (§38.1) — every figure click-through to its records
- [ ] `sustainability_settings` (§39)
- [ ] **Milestone:** 3.84 tCO₂e emissions and 27.42 tCO₂e avoided, side by side, every number traceable to a factor + version

## Phase 10 — Reporting & sign-off — plan §29, §34, §38.2

- [ ] Sustainability & Completion report, 12 sections (§29.1)
- [ ] `generated_reports` snapshots + `content_hash`; **re-render reads the snapshot, never recalculates** (§29.4)
- [ ] Evidence pack with section toggles (§29.2)
- [ ] Configurable disclaimer + claim guards — no "verified"/"certified" language (§29.3)
- [ ] Client sign-off: signature capture, evidence snapshot, append-only supersession (§34)
- [ ] `CLIENT_PERIOD` report kind + aggregation query shipped now, UI in Phase 12 (§38.2)
- [ ] **Milestone:** a client-ready PDF from real data, regenerable byte-identical a year later

## Phase 11 — Commercial & operations — plan §30, §31, §35

- [ ] Variations + lines, `DRAFT→…→INVOICED`, labour priced off the rate engine, approved variations feed `computeProjectSummary` (§30.1)
- [ ] `project_budgets` + **computed** actuals + per-category variance (§30.2)
- [ ] `vehicles`, `schedule_assignments`, day/week/month, drag-and-drop, conflicts as warnings, availability + role requirements (§31)
- [ ] Project timeline read model (§35)
- [ ] **Milestone:** budget vs actual including approved variations; a week's crew scheduled with conflicts surfaced

## Phase 12 — Compliance & analytics — plan §33, §38.2

- [ ] `compliance_documents` + statuses + 90/60/30/14/7 alert ladder on the existing nightly job; **never auto-blocks unless `enforce_compliance`** (§33)
- [ ] Client aggregated reporting UI, quarterly + annual, mixed factor years disclosed (§38.2)
- [ ] Advanced analytics / cross-project comparison
- [ ] **Milestone:** a year of one client's projects aggregated into a single sustainability report

## Phase 13 — Mobile *(the port — starts only when web is 100%)* — plan §8, §32, §42

Everything mobile in one phase, against a finished and proven domain. Every endpoint live, every calculation pinned by tests, every screen with a working web reference — UI and device integration, not product design under uncertainty.

- [ ] **13.1** Catch the existing app up to the current API (contract drift from Phases 6W–12)
- [ ] **13.2** Supervisor site experience — `(app)/site/` and its 11 actions (§32)
- [ ] **13.3** Evidence capture — direct camera, multi-shot, pre-fill, background upload with retry (§22.3)
- [ ] **13.4** Site diary on mobile — write, attendance confirm, Close Day + missing-data prompts (§23)
- [ ] **13.5** Assets & waste — Assets Removed, Waste/Reuse, destination assignment on site (§25)
- [ ] **13.6** Read-and-confirm surfaces — schedule (not drag), phone-appropriate project sections, timeline, compliance flags
- [ ] **13.7** Sign-off capture — signature on glass (§34)
- [ ] **13.8** Offline capture — draft queue for diary/evidence/assets. **Decide in-scope or deferred here** (§45)
- [ ] **13.9** EAS store submission — dev-client, production builds, OTA channels, listings *(moved from Phase 5)*
- [ ] **13.10** Maestro E2E: start shift → photo → diary → assets → complete day
- [ ] **Milestone:** a supervisor runs an entire site day from a phone, on functionality already proven on web

> **Sections that reach mobile:** Overview · Schedule (read) · Crew · Site Diary · Photos & Evidence · Assets & Materials · Variations (create) · Documents (read) · Client Sign-Off. **Web only:** Time & Costs beyond own entry · Sustainability · Reports · full commercial view.

---

## ✅ Owner decisions — answered 2026-08-17 (plan §17)

- [x] **Placeholder→linked merge policy → AUTO-MERGE.** On invite accept, if the invitee already owns a real company, the placeholder is claimed automatically (`companies.claimed_by_company_id`) and the engagement re-points to the real company — no confirmation prompt on either side. *Owner chose auto over the manual/two-sided-confirm recommendation; proceed as decided.* Open implementation assumption: if the accepting user owns **several** companies, merge into the one they're acting as (active company), falling back to their sole company when there's only one.
- [x] **Rate rules are per-company — nothing about rates may be hardcoded.** Rate *amounts* were already user-owned (`rate_cards`), but the **`FRI_SAT_NIGHT` label rule is a hardcoded branch** in `resolveRateLabel` and must become company-configurable data (`rate_card_templates` already exists as its home). See the Phase 2 follow-up item below. This supersedes the old "verify against v1" decision — the rule doesn't get verified, it gets removed.
- [x] **Currency → USD default, user-changeable.** `companies.currency` currently defaults to **`'GBP'`** (`0001_init.sql:21`) — must change to `'USD'`. Per-rate-card currency is **open**, see the question below.
- [x] **MoR → Gumroad** (replaces the Lemon Squeezy vs Paddle choice) — Phase 5. Confirm PH payout method and verify Gumroad's subscription-webhook coverage before building against it.
- [x] **Visual design system → not needed from Claude.** Owner has frontend work done via Codex; skip brand-token selection. *Blocked on locating that codebase — see below.*

### Still open

- [ ] **Per-rate-card currency?** Company-level currency can't express "pay crew in PHP, bill a US client in USD" — but mixing currencies inside one company means `calculateMargin` (BILL − PAY) is subtracting different units, so it needs a stored FX rate per project. Company-level is what ships today. Decide before multi-currency clients are real.
- [ ] **Where is the Codex frontend?** Not in this repo — `apps/web` contains only the Phase 2 console (login + rates screens), last touched by commit `02579c8`. Note that plan §40 now sets design constraints that apply to that work too.
- [ ] **Real per-currency pricing numbers** (USD anchors exist; confirm the actual amounts) — Phase 5

### Open for v2.1 (full detail in plan §45)

- [ ] **Emission factor dataset redistribution terms** — confirm licensing before bundling UK Gov GHG (or WRAP/Defra) factors; until then orgs import their own — Phase 9
- [ ] **Feature packaging** for the new modules — the §43 tier table is a proposal, not a decision — Phase 7
- [ ] **Enabling-emissions policy** — always deduct refurb/transport/storage from avoided claims, or only when the methodology requires it? Changes headline numbers — Phase 9
- [ ] **Default displacement assumption** — 100% (industry-common, more flattering) or "unknown, ask"? — Phase 9
- [ ] **Offline capture in or out of Phase 13?** — basements and loading bays have no signal and §32 is the flagship mobile screen (Phase 13.8)
- [ ] **Client-visibility default for evidence** — everything defaults to `client_visible = false`; confirm that's right for photos — Phase 7
- [ ] **GPS on evidence** — off by default; it's worker-location data — Phase 7
- [ ] **Retention/lifecycle for photo originals** — currently they never expire — Phase 7
- [ ] **Client logo source** for report branding — per client company or per project? — Phase 10
