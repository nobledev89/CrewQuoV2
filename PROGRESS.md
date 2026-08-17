# CrewQuo v2 — Progress & To-Do

Living checklist for the build. Full detail for every item is in **[CREWQUO_V2_PLAN.md](./CREWQUO_V2_PLAN.md)** (section references below). Phases are shipped one at a time — do not batch.

**Legend:** `[x]` done · `[~]` in progress · `[ ]` not started

Last updated: 2026-08-17 · Current phase: **Phase 5 — unified v2 web application** (every item built and verified; the closing milestone is an owner judgement) · Phases 0–4 complete

> **Re-run the end-to-end verification any time:** `pnpm --filter @crewquo/api verify:e2e` (needs the DB up, migrations + seed applied, and the API running). **163 checks** covering currency, label rules, the Phase 3/4 core-loop numbers, the export engine, malformed identifiers, both migration backfills, the portal, the placeholder/meter rules, the super-admin companies console, member management and the profile endpoint. Previous phases' scripts were ad-hoc and lost; this one is checked in at [apps/api/scripts/verify-e2e.ts](apps/api/scripts/verify-e2e.ts).
>
> **And the browser suite:** `pnpm --filter @crewquo/web test:e2e` — **17 Playwright tests** walking the whole loop through the real UI (register → paid plan → rates → subcontractor and client invites + accepts → project → assign → log time → submit → bulk approve → summary → portal → audit → exports → profile edit → member re-role/suspend/remove → the super-admin console → a comped trial appearing on the customer's own plan screen). Same prerequisites, plus a production build (`pnpm --filter @crewquo/web build`); Playwright starts the web server itself. Checked in at [apps/web/e2e/](apps/web/e2e/).
>
> **If a run fails at the very first step, check for a stale server first.** `playwright.config.ts` sets `reuseExistingServer`, and rebuilding `.next` under a running `next start` leaves it serving HTML that references chunk hashes which no longer exist — a blank page and a timeout, with nothing wrong in the code. Same for an `apps/api` process left over from an earlier session: it answers `/healthz` perfectly while 404ing every route added since it booted. Kill the listeners on :3000 and :4000 before concluding anything.

> **Unified product scope — owner decision 2026-08-17.** The commercial core, field operations, project evidence, site diary, assets and materials, sustainability, reporting, variations, scheduling, compliance, web and mobile are all CrewQuo v2. There is no later extension inside this plan. Phases describe delivery order, not product importance.
>
> **New-app direction — owner decision 2026-08-17.** Phase 5 designs and builds a coherent web product; it does not copy the prototype mobile app or create one page per existing endpoint. Existing clients and APIs are reusable implementation inventory, not UX constraints. Phases 5–12 prove the web workspace and shared domain; Phase 13 delivers a purpose-built mobile field workspace, not a port.

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
- [ ] Email delivery (Resend) for verify/reset links — currently logged in dev (arrives Phase 6, §5)
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

**✅ Phase 2 follow-up — de-hardcode the rate-label rules (owner decision, 2026-08-17) — DONE**

- [x] The `FRI_SAT_NIGHT` override is **out of the engine**. `resolveRateLabel(shiftType, isoDate, rules)` now takes the company's `label_rule` timeframe definitions as a **required** third argument — no default, so every call site had to declare what rules it is resolving under. With no matching rule the baseline shift-type→label mapping applies; nothing about a weekend is assumed
- [x] Migration `0007_rate_label_rules.sql`: `rate_card_templates.is_default` (partial unique index — one per company) + a **behaviour-preserving backfill** that writes `{"type":"label_rule","shiftType":"NIGHT","daysOfWeek":[5,6],"label":"FRI_SAT_NIGHT"}` for every company that had a FRI_SAT_NIGHT card. Companies that never used the branch get **no invented rule**
- [x] Overlapping rules are rejected at the edge (two rules claiming the same shift type on the same weekday would let array order silently decide a price)
- [x] Load-once discipline: `getEffectiveTimeframeDefinitions` is called once per request by the summary, portal and export paths and passed down — `resolveBillCentsForLog` takes `labelRules` as a required argument so a per-line query can't creep back in
- [x] Migration `0006_currency_usd_default.sql`: `companies.currency` defaults to `'USD'`, existing `'GBP'` rows backfilled, and `DEFAULT_CURRENCY` in [me.ts](packages/shared/src/me.ts) is now the single place the value lives in code (the two hardcoded GBP literals and four `?? 'USD'` fallbacks all import it)
- [x] `GET /v1/companies/:id` + `PATCH /v1/companies/:id` (OWNER/ADMIN, audited both-sides-of-the-change) — currency is user-changeable, as decided
- [x] Web UI, [/rates/templates](apps/web/src/app/rates/templates/page.tsx): create **any number** of label rules (shift type → weekday picker → label), add and remove rules on an existing template, and elect the default — with a warning banner when a company has templates but no default, since its rules would then be silently ignored. Rule order is shown as the precedence list it is
- [x] Web UI, [/settings](apps/web/src/app/settings/page.tsx): company name + currency, OWNER/ADMIN only, with an explicit warning that changing currency re-labels every figure and converts nothing. A setting only an API caller can change isn't "user-changeable", which is what the decision asked for

> **The 0006 backfill is deliberately narrow (resolved 2026-08-17).** Currency is the *unit* on every stored minor-unit amount and CrewQuo holds no exchange rate anywhere (decision #5), so rewriting it restates real figures rather than converting them — £50.00 becomes $50.00. A schema migration does not get to do that silently to a company that has already priced work, even pre-launch. So the backfill only touches companies with **no rate cards, no projects, no time logs and no expenses**, where the flip is provably inert; that clears the stale default from every account that never got as far as entering money. Anyone else keeps GBP until an owner or admin changes it through `PATCH /v1/companies/:id`, which is audited. Both halves are asserted in `verify:e2e`, because a later "tidy-up" widening that `where` clause would be silent and irreversible.
>
> **BILL-visibility scope:** `/v1/rate-cards` only ever returns the active company's *own* cards (PAY and BILL), so nothing leaks here. The provider-never-reads-client-BILL rule (§4) is realised in Phase 3: a project summary computes BILL/margin only for the *owner* (client) side; the provider only ever sees its frozen PAY snapshot.

## ✅ Phase 3 — Delivery loop domain + mobile proof (DONE) — plan §3.2, §3.4

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

## ✅ Phase 4 — Client collaboration + exports + audit domain (DONE; experience → Phase 5) — plan §3.6

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
- [x] **Server-side PDF/XLSX export engine** — `GET /v1/projects/:id/export.pdf|.xlsx`, gated on the `exports` feature, owner side only, audited as `project.exported` (internal, never client-visible). `modules/exports/` splits into `data.ts` (SQL assembly, totals taken from `computeProjectSummary` so the file and the screen cannot disagree), `model.ts` (**the only place a figure is formatted** — the seam §29's report engine builds on), `pdf.ts` and `xlsx.ts` (layout only, no computation). XLSX carries money as *numbers* with a currency `numFmt` so a recipient can sum it; nulls stay empty cells, never zeros
- [x] Client collaboration experience in `apps/web` — built with the unified Phase 5 application (§9.1): [client-side list](apps/web/src/app/(workspace)/portal/page.tsx) and [detail](apps/web/src/app/(workspace)/portal/[id]/page.tsx) with line items, notes thread and the shared activity trail
- [x] **Milestone (backend):** a client logs in, sees only granted projects + visible audit trail; an owner downloads a PDF or XLSX whose numbers match the summary endpoint cell-for-cell. The *client-side* download moves to Phase 10 — see below
- [x] 136 tests green (47 new: the export model incl. an ASCII-output guard, plus the Postgres error mapping) + **93 live-Postgres checks**

> **Client-facing export → Phase 10 (owner decision, 2026-08-17).** The client's own download is **not** in Phase 4. It lands with §29's report engine, where it renders from a stored `generated_reports` snapshot with a `content_hash` rather than from a live recalculation — so a client re-opening last quarter's document gets the same numbers they were shown then, which is the whole point of §29.4. Phase 4 ships the owner-side engine those reports are built on.
>
> **Library deviation:** the plan named `jspdf`/`xlsx`; this ships `jspdf@4` + **`exceljs@4`**. SheetJS's public-npm `xlsx@0.18.5` is its last registry release and carries CVE-2023-30533 and CVE-2024-22363; current builds ship only from the vendor's own CDN, which pnpm lockfiles and CI resolve badly. `exceljs` is maintained, write-oriented and has no equivalent advisory. §2's "one server-side rendering path" is unchanged.
>
> **jsPDF encodes Latin-1, not Unicode.** An em dash, an ellipsis and an arrow are *silently dropped from the page* — no substitution, no error. An unpriced line was rendering as a blank cell (reads as "not applicable") instead of a marker (reads as "not known yet"), and truncated values read as complete. Every string `model.ts` emits is now ASCII (`n/a`, `to`, `...`) and a test enforces it.
>
> **Pre-existing bug found and fixed (Phase 3 code, outside this scope).** `transitionExpense` and `transitionSubmission` interpolated `$3` only inside `case when $3 is null`, where Postgres has no column to infer a type from and refuses to parse the statement at all: *"could not determine data type of parameter $3"*. **Every expense and project-submission transition — submit, approve, reject — had been 500ing since Phase 3**, which is why `expenseCostCents` was always 0. Time logs were unaffected (different query shape), and Phase 3's verification only exercised time logs, so nothing caught it. Fixed with an explicit `$3::uuid`; the e2e script now asserts the whole expense workflow.

> **Audit design notes.** `audit_logs.company_id` is *whose activity* it is (the actor's active company) and `visible_to_client` says whether the company that hired them may see the row — so exposure is opt-in three times over: the row's flag, the provider's `audit_visibility` feature, and that engagement's `show_audit_trail`. Descriptions never name a counterparty, so a visible row can't leak who a subcontractor is. `recordAudit` never throws: a broken trail must not fail an approval, so failures are logged instead. Starter plans retain 30 days but can't *read* the trail until Pro — that's the seed's intent (§5B), not a bug.

> **API hardening found while verifying (2026-08-17).** No route validated that an `:id` path parameter was a UUID, and nothing mapped Postgres error codes — so `GET /v1/projects/not-a-uuid` reached a `uuid` column, raised SQLSTATE `22P02`, and came back as **`500 Internal server error`**. That was true of *every* `:id` route in the app, and it is a lie: nothing internal went wrong, the request was malformed. Fixed in two places rather than forty handlers — [`http/pgErrors.ts`](apps/api/src/http/pgErrors.ts) maps the caller-provokable SQLSTATEs (`22P02`/`22003`/`22007`/`22008` → 422, `23505` → 409, `23503`/`23502`/`23514` → 422) while still logging every one, and [`uuidParam`](apps/api/src/http/params.ts) rejects at the edge with a 404 so a malformed id and someone else's id give the same answer. Genuine faults (`42P08`, `08006`, `53300`) stay 500s on purpose. 11 unit tests pin the mapping; `verify:e2e` asserts 8 routes never 500.

# Remaining unified v2 build — plan §19–§47

The capabilities below are part of the same v2 application. Full sequencing and acceptance criteria are in plan §42.

## Phase 5 — Unified v2 web application — plan §9.1, §20, §42

Build the new information architecture, navigation, workspace shell and end-to-end core workflows. Existing endpoints may accelerate this work, but contracts and backend orchestration may change when the intended experience requires it.

**Functional surface: built 2026-08-17, every workflow reachable and proven in a real browser.** The first pass was built against the existing contracts, so nothing shipped regressed; a second pass then **added the endpoints the phase itself had found missing** (the super-admin companies console, member management, `PATCH /v1/me`) rather than leaving three screens saying "not available". The IA/visual-design pass remains a separate judgement (see the note under the list).

- [x] **Workspace shell + route groups first.** Phases 1–2 gave each section its own `AuthProvider` layout, so moving from `/rates/cards` to `/settings` unmounted the provider, dropped the in-memory session and re-ran refresh-on-mount — a token round trip plus a "Loading workspace…" flash on *every* section change. Replaced by two route groups, [`(workspace)`](apps/web/src/app/(workspace)/layout.tsx) and [`(auth)`](apps/web/src/app/(auth)/layout.tsx), one provider each. **Every URL is unchanged** — a parenthesised directory is a grouping only, confirmed against the build's route list. Navigation regrouped into Workspace / Delivery / Network / Client portal / Rates / Company / Platform, with the platform group visible only to `isSuperAdmin`
- [x] Auth completion: [register](apps/web/src/app/(auth)/register/page.tsx), [forgot-password](apps/web/src/app/(auth)/forgot-password/page.tsx), [reset-password](apps/web/src/app/(auth)/reset-password/page.tsx), [verify-email](apps/web/src/app/(auth)/verify-email/page.tsx), [profile](apps/web/src/app/(workspace)/profile/page.tsx). The reset/verify routes match the paths the API's links already build (`APP_BASE_URL/reset-password?token=…`), so no server change was needed. Added the **no-company state** the shell never had: registration allows skipping the company name, and that user previously landed on "Select a company to continue" with nothing to select
- [x] Entitlements: [plan & usage](apps/web/src/app/(workspace)/plan/page.tsx) listing the **whole** catalog, so what you lack is as visible as what you have; `null` renders as *unlimited* and `0` as *none* (opposite meanings on one column, and the seed ships both). [Feature-locked / limit-reached components](apps/web/src/components/FeatureLock.tsx) name the missing key rather than saying "Forbidden"
- [x] Engagements: [both sides of every edge](apps/web/src/app/(workspace)/network/engagements/page.tsx) in one table with a side column — they are the same object, and splitting them into two screens hides that — plus pause/resume/end
- [x] Providers & clients: [add subcontractor](apps/web/src/app/(workspace)/network/providers/page.tsx) (gated on `operates_downstream`, metered on `active_subcontractors`) and [add portal client](apps/web/src/app/(workspace)/network/clients/page.tsx) (gated on `client_portal`, metered on `clients`), each showing the allowance beside the button instead of letting people find the cap by hitting it
- [x] Members + invites: [member list, invite, role change, suspend/restore and removal](apps/web/src/app/(workspace)/company/members/page.tsx) and the **public [invite-accept page](apps/web/src/app/(auth)/invite/[token]/page.tsx)**, which reports the auto-merge outcome — including spelling out `SKIPPED` (nothing re-pointed, placeholder claimed instead, with the reason) rather than dressing it as success
- [x] **Member management endpoints** (new, 2026-08-17): `PATCH /v1/members/:membershipId` and `DELETE /v1/members/:membershipId`, OWNER/ADMIN, both audited. Addressed by **membership** id, not user id — the same person may be a MEMBER of one company and OWNER of another, and §46's later `/v1/members/:membershipId/capabilities` keys on the same thing. Two lock-out invariants are pure functions in `policies.ts` with 14 unit tests: an admin may neither change an owner nor mint one (otherwise ADMIN and OWNER are one role with two names), and a company always keeps **at least one active owner** (nothing else can change currency, invite an admin back or hold the subscription, and a company with no owner cannot be repaired from inside the product). Self-demotion is allowed once a second active owner exists — that is how an owner hands over
- [x] **`PATCH /v1/me`** (new, 2026-08-17): name + avatar, with [an editable profile screen](apps/web/src/app/(workspace)/profile/page.tsx). Email stays read-only on purpose — it is the address an invite is bound to and where a reset link goes, so changing it is a re-verification flow, not a text field. A rename is audited in **every** company the user belongs to, because that name is what appears on their approvals and audit rows; a silent rename would make an old row read as somebody else's
- [x] Projects: [list](apps/web/src/app/(workspace)/projects/page.tsx) with search + status filters, [detail](apps/web/src/app/(workspace)/projects/[id]/page.tsx) with server-computed cost/bill/margin, per-subcontractor rollup, assignment, edit/delete and PDF/XLSX download. No money is recomputed client-side — the screen, the export and the portal all read `computeProjectSummary`
- [x] Time & expenses: [provider entry](apps/web/src/app/(workspace)/work/page.tsx) (drafts, submit-all, returned-with-reason) and **[bulk review at scale](apps/web/src/app/(workspace)/review/page.tsx)** — filters by subcontractor/project/date, multi-select, batch approve, batch reject with one reason for the batch
- [x] Client portal: [client-side list](apps/web/src/app/(workspace)/portal/page.tsx) and [detail](apps/web/src/app/(workspace)/portal/[id]/page.tsx) with line items, notes thread and the shared activity trail
- [x] Audit trail [viewer with keyset paging + per-engagement visibility settings](apps/web/src/app/(workspace)/audit/page.tsx), which reports the *plan* state next to the share switch — exposure is opt-in three times over and flipping one switch alone shares nothing
- [x] Super-admin console: [plans, prices, feature matrix, limit matrix](apps/web/src/app/(workspace)/admin/plans/page.tsx) **plus the [companies console](apps/web/src/app/(workspace)/admin/companies/page.tsx)** — the §5B item that could not be closed without backend work, now closed
- [x] **Super-admin companies endpoints** (new, 2026-08-17): `GET /v1/admin/companies` (search by name or member email, plan filter, keyset cursor on `(created_at, id)`), `GET /v1/admin/companies/:id`, `POST|DELETE …/overrides[/:id]`, `POST …/comp-trial`, `POST …/subscription`. Every write **invalidates that company's entitlement cache** — the resolver memoises for 60s, so without it a support action appears not to have worked and gets performed twice; `verify:e2e` asserts a raised limit is live on the very next request. Each write is audited against the **subject** company, never the operator's, because the trail a customer reads is their own. The detail view reads `resolveEntitlements` and `getAllUsage` — the same resolver and meters every gate enforces — rather than re-deriving allowances in SQL, so the console cannot show an allowance the product would refuse
- [x] Role-aware [dashboard](apps/web/src/app/(workspace)/app/page.tsx) — panels driven by what the company *is* on its engagements (hirer / subcontractor / somebody's client), never by a user role, plus a first-run setup checklist
- [x] Playwright E2E ([parity.spec.ts](apps/web/e2e/parity.spec.ts)): register → paid plan → rates → subcontractor invite + accept → client invite + accept → project → assign → log time → submit → bulk approve → summary → portal → audit → exports → profile edit → member re-role/suspend/remove → super-admin console → a comped trial landing on the customer's own plan screen. **17 tests, all passing**, real Chromium against the real API against real Postgres. Three companies and three users for the core loop, because that is the smallest cast that proves the same data reads differently per side of an engagement, plus two staff accounts that own nothing
- [x] Empty, loading, error, locked, limit-reached and permission-denied states written deliberately on every screen — including the ones that are *absences*: unpriced lines marked rather than blank, provisional portal totals labelled as partial, and missing endpoints stated instead of mocked
- [x] 150 unit tests green (14 new: the two membership lock-out invariants), all 5 packages type-check, production build clean, **163 live-Postgres checks** and **17 browser tests** green
- [ ] **Milestone (owner judgement):** whether onboarding → project → delivery → approval → client collaboration now *feels like one new, coherent product* — every workflow is reachable, proven and no longer blocked on a missing endpoint, but the IA and visual design were not redesigned from scratch. **This is the only Phase 5 item left, and it is yours to make:** walk the app and decide what to redesign before Phase 6 starts adding commerce on top of it

> **The three gaps the first pass could only describe are now built (2026-08-17).** `GET /v1/admin/companies` + `/overrides` + `/comp-trial` (§7) and a `/subscription` route for §5B's "force plan change"; `PATCH`/`DELETE /v1/members/:membershipId`; `PATCH /v1/me`. Nothing in the UI says "not available yet" any more, and no screen ships a button that 404s.
>
> **Platform staff own no company, and the console must not require one.** Every workspace screen is gated on an active membership, which is correct — they all read company-scoped data. The platform console is the exception: it sends no `X-Company-Id` and operates *on* companies rather than from inside one. Gating it the same way made support unreachable by exactly the people it belongs to, so [`Shell`](apps/web/src/components/Shell.tsx) renders `/admin/*` for a super-admin with no membership and keeps the gate everywhere else. A Playwright test asserts both halves: `/projects` still asks a staff account to create a company, `/admin/companies` does not.
>
> **A reload must not blank a panel that holds its own state.** Two screens used `loading ? spinner : content`, so a post-save `reload()` unmounted the form and discarded the success notice it had just set — the change had landed and the screen said nothing. Both now branch on `loading && !data`. The companies console had a second version of the same bug: a `useEffect` re-seeding the plan/status form fired on the very fields the form changes, clearing the confirmation; it keys on `company.id` alone now. Neither was visible in a type-check or a unit test — the browser suite caught both.
>
> **Invite links are surfaced in the UI on purpose.** Email delivery is Phase 6, so the token returned by `POST /v1/providers` / `/clients` / `/members/invite` is the *only* copy that reaches a human — nothing re-reads it. [`InviteLink`](apps/web/src/components/InviteLink.tsx) shows it with an explicit "send this yourself, it is not shown again" warning. Dropping it would leave invites in the database that nobody can accept.
>
> **✅ `is_placeholder` staleness and the `clients` meter — fixed 2026-08-17.** `applyMerge` tombstones the placeholder on the MERGED path, but the CLAIMED path only inserted a membership, so a subcontractor who joined without already owning a company kept `is_placeholder = true` on what was now their real company. `markCompanyClaimed` clears it there, which is what the flag means: *"a stub for a party not yet on CrewQuo"* stops being true the moment somebody signs in and owns it. (The MERGED path is untouched — there the stub really does stay a stub, tombstoned via `claimed_by_company_id`.)
>
> That unblocked the second half. `countClients` now excludes engagements whose client side is still a stub, which is §5B as written — *"placeholder clients are free/unlimited (only real portal logins count toward `clients`)"*. **This loosens a cap**: a company that invited ten portal clients and had two accept now meters 2, not 10. That is the specified behaviour and it is asserted live, both halves — the claimed companies lose the flag, an un-accepted stub keeps it, and the meter reports 1 where two client edges exist.
>
> `countActiveSubcontractors` deliberately keeps counting `PENDING`. The spec's exemption names *clients* only, and the asymmetry is load-bearing: if a pending subcontractor edge were free, the `active_subcontractors` cap could be walked straight past by inviting, and the meter would bite only on the people who actually turned up.
>
> **Entitlements are eventually consistent for up to 60s.** `resolveEntitlements` memoises in process (`cache.ts`, `TTL_MS = 60_000`). Only writes that go through the super-admin console clear it — plan edits clear the whole cache, and the per-company routes invalidate that one company. Anything else that changes a company's *plan* out of band (a direct DB write, and from Phase 6 an MoR webhook) is invisible for up to a minute. Invisible in normal use, but it dictates the E2E fixture: a company registered *through the UI* has its free `crew` entitlements cached the moment the dashboard mounts, so subscribing it afterwards has no effect for a minute — which reads as "the paid feature is broken" when nothing is wrong. The fixture registers the paid company over HTTP and subscribes it **before anything reads it**, and proves the register *screen* in a separate test. Worth knowing before Phase 6 wires real plan changes to live customers.
>
> **`useSearchParams` needs a Suspense boundary.** The four auth pages reading `?token=`/`?next=` failed the production build (`missing-suspense-with-csr-bailout`) until each was split into an exported page wrapping the query-reading half in `<Suspense>`. Type-check does not catch this — only `next build` does, which is why the build is part of this phase's verification and not just the type-check.
>
> **Refresh tokens rotate, so a hard navigation immediately after sign-in can sign you back out.** `/login` and `/app` sit in different route groups, so arriving at `/app` mounts a second `AuthProvider`, which refreshes on mount and rotates the stored token. A full page load inside that window reads the token that has just been revoked, the refresh fails, and the visitor lands back on sign-in. A real user is not exposed — in-app links stay inside one route group and never remount the provider — but Playwright's `goto` is a hard load, so `signIn` now waits for the sidebar (which only renders once the rotated token is persisted). Worth remembering if server-side rendering or cookie auth is revisited, because both would widen that window.
>
> **Playwright talks to `127.0.0.1`, never `localhost`.** `next start` with no `-H` binds `::`, and here the health poll against `localhost` never connects: the run hangs for its full timeout against a perfectly healthy server. Same port-shadowing footgun the repo already pinned down for Postgres (Phase 1 local-env note), same answer — name the address explicitly on both ends. `playwright.config.ts` sets host and port, and `pnpm --filter @crewquo/web test:e2e` runs the suite (needs the DB up, migrations + seed applied, and the API on :4000).

## Phase 6 — Commercial readiness — plan §3.5, §5B, §42

- [ ] Migrations: `invoices`, `invoice_items`
- [ ] Merchant-of-Record billing via **Gumroad** (decided 2026-08-17): checkout, webhooks, trial→paid, entitlement snapshots
- [ ] Super-admin price editor + subscription management
- [ ] Push + email notifications (Resend)
- [ ] Production observability, support tooling, backup/restore rehearsal and launch runbook
- [ ] Public marketing + legal pages (pricing/terms/privacy/refunds)

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
- [ ] **Client-facing project export** (moved here from Phase 4 by owner decision, 2026-08-17): BILL-side line items only — no PAY figure, no rate snapshot, no subcontractor identity. Renders from the report snapshot, not a live recalculation, so a client re-opening a document a year later sees the numbers they were shown. Reuse the `PortalLineItem`/`PortalProjectView` types in `packages/shared` as the renderer's input so the exclusions are structural rather than a filter someone can forget
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

## Phase 13 — Complete mobile field experience — plan §8, §32, §42

Build and validate the field workspace against supervisor and crew jobs. The shared domain is proven by this point, but navigation and interactions are designed for mobile, device capabilities and intermittent connectivity.

- [ ] **13.1** Establish the mobile product shell: navigation, auth, company/project context, design system, accessibility and resilient API state; reuse prototype code only where it fits
- [ ] **13.2** Supervisor site experience — `(app)/site/` and its 11 actions (§32)
- [ ] **13.3** Evidence capture — direct camera, multi-shot, pre-fill, background upload with retry (§22.3)
- [ ] **13.4** Site diary on mobile — write, attendance confirm, Close Day + missing-data prompts (§23)
- [ ] **13.5** Assets & waste — Assets Removed, Waste/Reuse, destination assignment on site (§25)
- [ ] **13.6** Read-and-confirm surfaces — schedule (not drag), phone-appropriate project sections, timeline, compliance flags
- [ ] **13.7** Sign-off capture — signature on glass (§34)
- [ ] **13.8** Offline capture — draft queue for diary/evidence/assets. **Decide in-scope or deferred here** (§45)
- [ ] **13.9** EAS store submission — dev-client, production builds, OTA channels and listings for the complete field app
- [ ] **13.10** Maestro E2E: start shift → photo → diary → assets → complete day
- [ ] **Milestone:** a supervisor runs an entire site day from a phone through a coherent field product sharing the same data and rules as web

> **Sections that reach mobile:** Overview · Schedule (read) · Crew · Site Diary · Photos & Evidence · Assets & Materials · Variations (create) · Documents (read) · Client Sign-Off. **Web only:** Time & Costs beyond own entry · Sustainability · Reports · full commercial view.

## Future backlog (not part of the numbered build)

- [ ] Real-time updates
- [ ] Any v1 customer-data onboarding/importer requires a separate specification (§12)

---

## ✅ Owner decisions — answered 2026-08-17 (plan §17)

- [x] **Placeholder→linked merge policy → AUTO-MERGE.** On invite accept, if the invitee already owns a real company, the placeholder is claimed automatically (`companies.claimed_by_company_id`) and the engagement re-points to the real company — no confirmation prompt on either side. *Owner chose auto over the manual/two-sided-confirm recommendation; proceed as decided.* Open implementation assumption: if the accepting user owns **several** companies, merge into the one they're acting as (active company), falling back to their sole company when there's only one.
- [x] **Rate rules are per-company — nothing about rates may be hardcoded.** ✅ **Implemented 2026-08-17.** The `FRI_SAT_NIGHT` branch is gone from `resolveRateLabel`; label rules live in `rate_card_templates.timeframe_definitions` as `label_rule` entries, with one template per company elected as the default the engine reads. Migration 0007 backfilled the old behaviour for anyone who was relying on it. This superseded the old "verify against v1" decision — the rule wasn't verified, it was removed.
- [x] **Currency → USD default, user-changeable.** ✅ **Implemented 2026-08-17.** Migration 0006 moves the column default to `'USD'` and backfills existing `'GBP'` rows; `PATCH /v1/companies/:id` (OWNER/ADMIN) makes it changeable. Per-rate-card currency is still **open**, see the question below.
- [x] **MoR → Gumroad** (replaces the Lemon Squeezy vs Paddle choice) — Phase 6. Confirm PH payout method and verify Gumroad's subscription-webhook coverage before building against it.
- [x] **Application direction → one totally new v2 app.** Existing web/mobile screens are prototypes and reusable code only; they do not define the target information architecture, workflows or visual system.

### Still open

- [ ] **Per-rate-card currency?** Company-level currency can't express "pay crew in PHP, bill a US client in USD" — but mixing currencies inside one company means `calculateMargin` (BILL − PAY) is subtracting different units, so it needs a stored FX rate per project. Company-level is what ships today. Decide before multi-currency clients are real.
- [ ] **Real per-currency pricing numbers** (USD anchors exist; confirm the actual amounts) — Phase 6

### Domain decisions for the unified v2 build (full detail in plan §45)

- [ ] **Emission factor dataset redistribution terms** — confirm licensing before bundling UK Gov GHG (or WRAP/Defra) factors; until then orgs import their own — Phase 9
- [ ] **Feature packaging** for the new modules — the §43 tier table is a proposal, not a decision — Phase 7
- [ ] **Enabling-emissions policy** — always deduct refurb/transport/storage from avoided claims, or only when the methodology requires it? Changes headline numbers — Phase 9
- [ ] **Default displacement assumption** — 100% (industry-common, more flattering) or "unknown, ask"? — Phase 9
- [ ] **Offline capture in or out of Phase 13?** — basements and loading bays have no signal and §32 is the flagship mobile screen (Phase 13.8)
- [ ] **Client-visibility default for evidence** — everything defaults to `client_visible = false`; confirm that's right for photos — Phase 7
- [ ] **GPS on evidence** — off by default; it's worker-location data — Phase 7
- [ ] **Retention/lifecycle for photo originals** — currently they never expire — Phase 7
- [ ] **Client logo source** for report branding — per client company or per project? — Phase 10
