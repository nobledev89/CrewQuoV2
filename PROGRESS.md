# CrewQuo v2 — Progress & To-Do

Living checklist for the build. Full detail for every item is in **[CREWQUO_V2_PLAN.md](./CREWQUO_V2_PLAN.md)** (section references below). Phases are shipped one at a time — do not batch.

**Legend:** `[x]` done · `[~]` in progress · `[ ]` not started

Last updated: 2026-08-18 · Current phase: **Phase 6 — commercial readiness** (invoices, commercial agreements, the three-view workspace and the CrewQuo Platform admin workspace complete; company-creation safeguards, money boundary, billing, durable delivery, notifications and launch readiness remain) · Phases 0–5 built and verified. **Phase 5's coherence judgement was answered on 2026-08-18** by a measured audit of all 31 screens, and the information-architecture and density work it produced shipped as Phase 5.5

> **Re-run the end-to-end verification any time:** `pnpm --filter @crewquo/api verify:e2e` (needs the DB up, migrations + seed applied, and the API running). **318 checks** covering currency, label rules, the Phase 3/4 core-loop numbers, the export engine, malformed identifiers, both migration backfills, the portal, the placeholder/meter rules, the super-admin companies console, member management, the profile endpoint, invoices, and the whole commercial-agreement domain (the acceptance script in §12 of its operating-model packet). Previous phases' scripts were ad-hoc and lost; this one is checked in at [apps/api/scripts/verify-e2e.ts](apps/api/scripts/verify-e2e.ts).
>
> **And the browser suite:** `pnpm --filter @crewquo/web test:e2e` — **22 Playwright tests** walking the whole loop through the real UI (free account setup → paid Operations → rates → subcontractor and client invites + accepts → view-specific navigation → project → assign → log time → submit → bulk approve → summary → portal → audit → exports → a subcontractor proposes a rate rise → the hirer sees what changes and returns it with a reason → payment terms and a PO → assignment acceptance → profile edit → member re-role/suspend/remove → the super-admin console → a comped trial appearing on the customer's own plan screen). Same prerequisites, plus a production build (`pnpm --filter @crewquo/web build`); Playwright starts the web server itself. Checked in at [apps/web/e2e/](apps/web/e2e/).
>
> **If a run fails at the very first step, check for a stale server first — including the API.** Playwright manages only the *web* server, so an `apps/api` process started before your change keeps serving the old code through a whole green-looking suite. This cost two full browser runs on 2026-08-18. `playwright.config.ts` sets `reuseExistingServer`, and rebuilding `.next` under a running `next start` leaves it serving HTML that references chunk hashes which no longer exist — a blank page and a timeout, with nothing wrong in the code. Same for an `apps/api` process left over from an earlier session: it answers `/healthz` perfectly while 404ing every route added since it booted. Kill the listeners on :3000 and :4000 before concluding anything.

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
- [x] `GET /v1/me`, `/v1/me/memberships`, `POST /v1/me/companies`; `GET /v1/entitlements` (resolved + live usage). **Known safeguard gap, accepted 2026-08-18:** the original company-creation endpoint is unrestricted; the Phase 6 §3.1.1 item replaces that policy without removing multi-company memberships.
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
- [x] Super-admin console: a separate **CrewQuo Platform / Super Admin** context with platform dashboard, users, companies, plans/pricing, operations, reporting, platform audit, settings and access administration. Plans and companies retain their subject-company controls; user access and sessions require a reason and protect the current/last admin. Full inventory: [docs/product/platform-admin.md](docs/product/platform-admin.md)
- [x] **Super-admin companies endpoints** (new, 2026-08-17): `GET /v1/admin/companies` (search by name or member email, plan filter, keyset cursor on `(created_at, id)`), `GET /v1/admin/companies/:id`, `POST|DELETE …/overrides[/:id]`, `POST …/comp-trial`, `POST …/subscription`. Every write **invalidates that company's entitlement cache** — the resolver memoises for 60s, so without it a support action appears not to have worked and gets performed twice; `verify:e2e` asserts a raised limit is live on the very next request. Each write is audited against the **subject** company, never the operator's, because the trail a customer reads is their own. The detail view reads `resolveEntitlements` and `getAllUsage` — the same resolver and meters every gate enforces — rather than re-deriving allowances in SQL, so the console cannot show an allowance the product would refuse
- [x] Role-aware [dashboard](apps/web/src/app/(workspace)/app/page.tsx) — panels driven by what the company *is* on its engagements (hirer / subcontractor / somebody's client), never by a user role, plus a first-run setup checklist
- [x] Playwright E2E ([parity.spec.ts](apps/web/e2e/parity.spec.ts)): register → paid plan → rates → subcontractor invite + accept → client invite + accept → project → assign → log time → submit → bulk approve → summary → portal → audit → exports → profile edit → member re-role/suspend/remove → super-admin console → a comped trial landing on the customer's own plan screen. **17 tests, all passing**, real Chromium against the real API against real Postgres. Three companies and three users for the core loop, because that is the smallest cast that proves the same data reads differently per side of an engagement, plus two staff accounts that own nothing
- [x] Empty, loading, error, locked, limit-reached and permission-denied states written deliberately on every screen — including the ones that are *absences*: unpriced lines marked rather than blank, provisional portal totals labelled as partial, and missing endpoints stated instead of mocked
- [x] 150 unit tests green (14 new: the two membership lock-out invariants), all 5 packages type-check, production build clean, **163 live-Postgres checks** and **17 browser tests** green
- [x] **Milestone (owner judgement) — answered 2026-08-18 by audit, then closed by Phase 5.5 below.** All 31 screens were walked at 1440×900 across the four positions a company can hold (operator, subcontractor, portal client, platform staff) against a loaded fixture, and measured rather than eyeballed. **Verdict: the design *system* was already right; the information architecture was not.** §40's avoid-list is genuinely avoided — flat single-elevation panels, 6–8px radii, no gradients, tabular figures, semantic colour only — and `/audit` proved the system could produce a dense screen. Phase 5.5 fixed the project rail, grouping and density; the later owner decision in §9.2 deliberately reopens only customer-audience navigation as a three-view Phase 6 refinement.

### ✅ Phase 5.5 — information architecture & density (DONE 2026-08-18) — plan §20, §40

A measured audit closed Phase 5's milestone; these are the fixes it produced. **No API change, no migration, no contract change** — every endpoint, route URL and permission is untouched. Density was measured before and after by an instrumented browser walk, not judged by eye.

- [x] **Project record gets its section rail** (§20's binding layout rule). The detail page was a vertical stack of full-width panels; it is now a persistent left rail — Overview · Crew · Time & costs · Expenses · Reports · Settings — beside a dense identity/figures strip that stays put across sections. The rail marks which sections hold anything (§20's progressive disclosure), and the active section is in the URL so it stays linkable. **This is the container Phases 7–12 add into:** Locations, Evidence, Documents, Site Diary, Assets, Sustainability, Variations, Schedule and Sign-Off become rail entries, not ten more panels on an ever-longer page
- [x] **Navigation is entitlement-aware** (§5B). [`Shell`](apps/web/src/components/Shell.tsx) filtered on `isSuperAdmin` and nothing else, so a Crew-plan subcontractor was offered Subcontractors, Clients, Rate cards, Templates and Invoices — every one a refusal — and platform staff, who own no company by design, got fifteen links that all landed on "create a company". Items now declare a `feature` or `requiresDownstream`, staff with no company get the platform group alone, and the seven groups collapse to four that fit a 900px viewport without scrolling. It reads the same resolver every gate enforces, so the menu and the API cannot disagree
- [x] **Create-forms moved into side panels** (§40: "put filters and detail in side panels"). `/rates/roles`, `/rates/cards`, `/rates/templates` and `/work` each pinned an always-open form above the table it adds to. New `Drawer` primitive in `packages/ui`; the trigger sits in the page header as `New role` / `New rate card` / `New template`, matching what `/projects` and `/invoices` already did right. A panel that stays open across repeated saves dismisses with **Done**, one that closes on save with **Cancel**
- [x] **Density measured, before → after** (chrome px before the first data row / rows visible on a 1440×900 laptop): `/rates/cards` **766 → 302, 2 → 14 of 30 rows**; `/work` **759 → 323, 2 → 9 of 18**; `/rates/templates` **971 → 378, 0 → 2** (it previously required scrolling before *any* data was visible); `/admin/companies` **653 → 313, 3 → 7 of 25**. Compact 34px row variant for register screens; the toolbar replaces the second-level panel header
- [x] **Figures are right-aligned** (§40: "Tabular figures, right-aligned"). `align="right"` appeared **0 times across 141 column headers** while `.cq-numeric` was applied 48 times — tabular figures that never lined up. `.cq-numeric` inside a table now sets the alignment too, and the matching headers are marked
- [x] **Sortable columns** (§40 density) — new `SortableTh` + `useSort`, with `aria-sort` as both the accessible state and the styling hook so the caret and the announcement cannot disagree. **`null` sorts last in both directions**: an unpriced line ranked as zero would read as the cheapest work on the project
- [x] **§40's two direct contradictions fixed** — the nested panel on `/rates/templates` (a bordered "Label rules" panel inside a bordered "Add template" panel, holding a bordered card per rule) is now a labelled `cq-fieldset` group; the page-top advisory banner on `/admin/companies` moved onto the two actions it actually qualifies ("warnings are inline and specific, not a banner at the top of the page")
- [x] **The dashboard leads with what the company *is*.** A Crew-plan subcontractor opened on four zeroes describing capabilities its plan forbids, with an "Add a subcontractor" link to a refusal, while its actual business — 4 assigned projects, 4 awaiting a decision — was one line in a side panel. The metric row is chosen by engagement position now, and the setup checklist stops nagging a company to configure roles it has no feature to use
- [x] **Layout defect on all 31 screens.** The sidebar read "Dana Whitfield**Owner**" and every dashboard panel "5 items to review**Approve or reject many at once…**". One root cause: `.cq-account__copy` was declared *only* inside the ≤980px media query as `display: none`, so above 980px it had no rule and defaulted to `inline`; and `.cq-object-list__title`/`__meta` were sibling inline `<span>`s, which also made `__meta`'s `margin-top` a no-op. Two CSS rules. **Nothing caught it** — a type-check and a unit test cannot see layout, which is the argument for the walk harness below
- [x] **Smaller fixes:** the empty `Section` body on `/work` (a bordered panel containing nothing but 36px of padding); a returned-work reason overflowing its `nowrap` row and colliding with the row beneath (`cq-table__note` wraps inside its own cell); and the portal's Date column, which silently mixed **work** dates for time with **entry** dates for expenses, so a client saw materials dated a month after the labour they belonged to — expense rows now say "raised" and the owner-side tables name their own column
- [x] **Verified:** 155 unit tests green (107 in `@crewquo/api`, 48 in `@crewquo/shared` — this line originally quoted the API package alone), all 5 packages type-check, production build clean, **183 live-Postgres checks** green (no API change, so this is a pure regression gate) and **17 browser tests** green. Four parity tests needed updating because the UI deliberately changed — the create-in-a-drawer flow, assignment now under Crew, exports now under Reports — which is the suite doing its job
- [x] **Design-walk harness checked in** at [apps/web/walk/](apps/web/walk/) + [playwright.walk.config.ts](apps/web/playwright.walk.config.ts), run with `pnpm --filter @crewquo/web design:walk`. Deliberately **not** part of `test:e2e`: it provisions a heavy fixture and writes 31 screenshots plus `density.json` to `.tmp/walk/`. It exists because §40's density rule is quantitative and was being assessed by opinion

> **The rejected second route group stays rejected; the navigation conclusion is superseded by the three-view decision (2026-08-18).** The audit correctly found that a portal client saw the operator's full sidebar, but a `(portal)` route group cannot model a company that is Client on one edge and Subcontractor on another. Phase 5.5's entitlement filtering reduced the immediate noise, but it still leaves one flat shell serving different jobs. Plan §9.2 now resolves this with runtime Operations/Subcontractor/Client navigation lenses inside the same routes, records and authorization model.
>
> **The marketing page is real, off-plan, and now recorded.** [apps/web/src/app/page.tsx](apps/web/src/app/page.tsx) + `landing.module.css` ship a landing page with a full brand voice and a product mockup that *is* §20's section rail — Overview, Schedule, Crew, Time & costs, Site diary, Evidence, Assets, Sustainability, Reports. It was the design target for the rail above. Phase 6 lists "Public marketing + legal pages" as unstarted, which is no longer accurate for the landing page itself; pricing/terms/privacy/refunds are still missing. **Its figures are in £ against a USD product default** — fix before it is public.
>
> **§40's literal "20+ rows on a laptop" is still not met, and cannot be by chrome alone.** 20 rows at the compact 34px row plus a table header is ~726px, against ~836px of usable height below the topbar — so it needs chrome under ~110px, which would mean dropping the page header entirely. The best screen now shows 14 of 30 rate cards (was 2). Stated rather than quietly declared done: reaching a literal 20 needs a ~29px row, and that starts to cost legibility.

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

## Product operating-model packet — plan §19.5

These artifacts are now required planning inputs before each new domain hardens. **The reusable packet was written on 2026-08-18** and lives in [docs/operating-model/](docs/operating-model/) — `TEMPLATE.md` is the packet, `README.md` records which domains have one. It is completed per domain, not once: the twelve headings below are the template's, and the checkboxes track whether the template exists rather than whether every domain has answered it.

- [x] Persona/job and device/connectivity context
- [x] Resource responsibility map: creator, owner, reader, reviewer, publisher, corrector, exporter and retention owner
- [x] State machine with actor/transition/concurrency rules
- [x] Capability + company/project/resource-scope matrix
- [x] Domain-event and notification matrices, including the durable Action Centre projection
- [x] Data classification, visibility, retention, legal-hold and export/deletion rules
- [x] Offline/conflict contract and user-visible recovery behavior
- [x] Failure matrix, operator repair path and threat model
- [x] Analytics contract with sensitive-payload exclusions
- [x] End-to-end persona acceptance script covering empty, denied, rejected, offline/retry and correction paths

**Completed per domain:**

| Domain | Packet | Phase |
|---|---|---|
| Commercial agreements — PAY proposals, engagement terms, acceptance | [commercial-agreements.md](docs/operating-model/commercial-agreements.md) | 6 |

**Next required packet:** company ownership/creation safeguards reopen the identity domain, so `docs/operating-model/company-creation.md` must be written before its migration or route changes. It must settle request states, first-allowance concurrency, checkout/admin approval, trial eligibility, backfill ambiguity, duplicate/recovery handling and support repair.

**Completed workspace artifact:** [workspace-views.md](docs/product/workspace-views.md) inventories the route/action ownership, eligibility, landing and deep-link rules, navigation limits and the seven-case §9.2 acceptance matrix. It remains a product/IA artifact, not a new authorization layer.

> **Domains built before the decision was adopted get no retro-fitted packet.** Identity, rates, the delivery loop, portal/audit and invoices all shipped before 2026-08-18. A packet earns its keep when it can still change the design; writing one for a shipped domain produces documentation nobody reads. Each gets one the next time it is reopened.
>
> **Writing it first paid for itself.** The packet's §3 is what settled delete-vs-withdraw, the one-open-per-edge index and the concurrency rule; its §4 is where "proposing must be free" was worked out rather than discovered later by a Crew-plan subcontractor who could not ask for a raise; and its §9 is what stopped assignment acceptance becoming a gate on work capture. All three would have been expensive to change after the migration.

## Phase 6 — Commercial readiness — plan §3.1.1, §3.3.1, §3.5, §5B, §9.2, §19.5, §42

- [x] **Invoice foundation** (2026-08-17): migration `0008_invoices.sql`; shared Zod contracts and deterministic amount/total rules; `/v1/invoices` + item CRUD + issue/paid/void transitions; owner/provider-side management and issued-only client visibility; audit + portal-note anchoring; and a unified `/invoices` web workspace. Creating from a project snapshots every approved, not-yet-invoiced time log through the same BILL-rate resolver used by summaries/portal/exports and passes approved expenses through at cost. Missing BILL rates block the draft, work-backed amounts cannot be supplied by the caller, project advisory locks prevent concurrent double-invoicing, totals are recomputed server-side, issue assigns a serialized annual number and makes the document immutable, and voided sources become eligible again. **Phase 11 hook:** approved variation lines join this same source builder when the variations domain exists; no variation table or calculation exists yet to duplicate here.
- [x] **Commercial agreement hardening** (2026-08-18): migration `0009_commercial_agreements.sql`; `rate_proposals` + immutable `rate_proposal_lines`; approved PAY versions on `rate_cards` (`currency`, `version`, `locked`, `source_proposal_id`, `supersedes_rate_card_id`); `/v1/rate-proposals` with the full draft → submit → approve/reject/withdraw workflow; `/v1/commercial-agreements/:engagementId` (terms + live schedule + proposal history in one read) and its hiring-side direct-entry path; engagement payment terms, PO reference and PO ceiling; engagement and assignment acceptance; `record_revisions` (§36); and a `/commercial` web workspace that serves both sides of a negotiation from one screen. **Approval is one transaction:** revalidate the whole schedule, close superseded windows the day *before* the successor opens, insert immutable versions, record the decision. Detail and the decisions behind every refusal are in the operating-model packet, [docs/operating-model/commercial-agreements.md](docs/operating-model/commercial-agreements.md).

  **The rules worth restating, because they are decisions rather than implementation:**
  - **Proposing is free; approving is gated.** The Crew plan has no features and exists so a subcontractor can work for nothing (§5B) — gating proposals on the proposer's plan would mean a free subcontractor could never ask for a raise. `rate_cards` is resolved on the **hiring** company instead, which is whose cards approval writes. The mirror of the portal rule already in force, with the sides swapped.
  - **Immutability is the database's rule, not the route's.** A trigger allows an `UPDATE` on a locked card to touch `effective_to`/`active`/`updated_*` and nothing else, and refuses `DELETE` outright — so a later `PATCH` path added in good faith cannot quietly rewrite an agreed rate. The route refuses first with an explanation, because a trigger violation reaches a caller as a 500.
  - **Submission freezes the payload, for both sides.** The reviewer has no edit path at all; its only lever is reject-with-a-reason, and a rejection without one is a 422. A corrected schedule is a successor row carrying `predecessor_proposal_id`, never an edit.
  - **A draft is deleted, a submitted schedule is withdrawn.** Different verbs because they have different audiences: nobody has seen a draft, so there is nothing to explain; a submitted schedule sits in someone else's queue, so pulling it back leaves a terminal row. This is why no state but `DRAFT` has a null `submitted_at`, and the DB check says so.
  - **Retroactive activation is refused by default** and needs an `OWNER` plus a reason on the record. Approved time keeps its PAY snapshot frozen at submit (§6), so a back-dated rate disagrees with money already owed. Asserted both ways: a manager gets 403, an owner without a reason gets 422, and an owner with one gets the reason stored.
  - **One open negotiation per edge** (partial unique index on `DRAFT|SUBMITTED`). Two open proposals would make "what are we arguing about" ambiguous, and whichever approved second would silently win.
  - **Currency is carried but unlike currency is refused.** The agreement records its own unit so the money-boundary bullet below is a change of behaviour rather than a migration; until then §3.3's rule holds and the refusal names the FX snapshot that is missing.
  - **Payment terms and the PO ceiling are enforced, not recorded.** Terms default a new invoice's `due_at`; the ceiling is checked at **issue** — the point the amount becomes a claim on the PO — under an advisory lock so two invoices cannot each read a committed total that excludes the other. `DRAFT` and `VOID` are excluded from the committed figure on purpose.
  - **Engagement acceptance closes a real hole.** `POST /v1/engagements` used to create an `ACTIVE` edge, so a hiring company could bind another company to a commercial relationship it had never agreed to. It now lands `PENDING` and the provider accepts or declines — which is what the placeholder/invite path already did, so the two paths agree instead of contradicting each other.
  - **Assignment acceptance deliberately does *not* gate work capture.** Gating it would stop a crew logging hours they had already worked, hours after a decision taken by a different company, with the repair sitting in a third place. It is recorded and surfaced; whether it becomes a hard gate is left as an explicit later decision rather than smuggled in here. Proven: a time log is accepted while the assignment is still `PENDING`.
  - **`accepted_at` means accepted.** A declined assignment has none — `updated_at` and the audit row carry when a decline happened. The first version of the check constraint said `(acceptance = 'PENDING') = (accepted_at is null)`, which made every decline a constraint violation; it keys on `ACCEPTED` now, matching what the column name claims.
  - [x] **Verified:** 209 unit tests green (**54 new** — the state machine, money boundary, schedule validation, the six new authorization rules and the revision differ), all 5 packages type-check, production build clean, **318 live-Postgres checks** green (**135 new**, implementing the packet's §12 acceptance script) and **21 browser tests** green (**4 new**, walking a rate rise from proposal to return to terms to assignment acceptance).

> **A company-*default* PAY rate is agreed on an engagement too — found by the browser suite, on 2026-08-18.** The first read model only returned counterparty-specific PAY cards, so the agreement screen said "no agreed rates yet" for an engagement the rate engine was already pricing at the company default. `pickEffectiveCard` falls back to a null-counterparty card (§6), so that was the screen and the engine disagreeing about money — the one thing the reviewer's "now" column exists to prevent. Both reads now apply the resolver's own precedence (counterparty-specific beats default, latest `effective_from` within that) and carry a `scope` of `ENGAGEMENT` or `COMPANY_DEFAULT`. **A default is never offered as a REPLACE target:** closing its window would reprice every other provider on that role at once, so overriding it is a `CREATE` line that wins on precedence instead. Nothing but a browser could have caught this — the unit tests and the API script both used counterparty-specific fixtures.

> **A provider on the free plan gets no record of its own negotiation.** `rate_proposal.*` rows are written against the company whose record moved, which is correct — but a subcontractor is usually on Crew, and Crew has `audit_retention_days: 0` and no `audit_visibility`. So `recordAudit` writes nothing for it and it cannot read a trail either. This is pre-existing behaviour that the domain inherits rather than a new bug (work submissions have had the same hole since Phase 3), and both halves are now asserted so it stays visible. **It is the notification and Action Centre bullets' problem to solve** — those are the durable per-recipient projection the trail is standing in for, and they should not assume the audit row exists.

> **The `§40` label gotcha, recorded because it cost a test cycle.** `Field` renders a *wrapping* `<label>`, so a control's accessible label text is the caption **plus the control's own rendered text** — for a `<select>`, every option. `getByLabel('Role', { exact: true })` therefore matches nothing on any select in this design system, and does so as a 60s timeout rather than a clear failure. Match loosely on selects, as the older log-time test already did.

- [x] **Three-view workspace (§9.2)** (2026-08-18, shell corrected after owner review): shared pure eligibility/selection rules plus `GET /v1/me/workspaces`; a top-right Contractor/Subcontractor/Client dropdown containing only eligible views; a separate multi-company selector; every page retained in grouped sidebar navigation; per-company device memory; eligible deep-link selection and invalid-view fallback; Account setup for an unentitled/unassigned free company; client-aware invoice controls; and the separate companyless Platform console. Existing project rails and decision queues are isolated by their Contractor/Subcontractor/Client route surfaces; the future Universal Action Centre must consume the same view read model. Route/action inventory and seven-case acceptance matrix: [workspace-views.md](docs/product/workspace-views.md). **Verified:** 218 unit tests, all five packages type-checking, clean production build, 318 unchanged live-Postgres checks and 22 browser workflows green; the browser suite directly proves paid Contractor, free Subcontractor, free Client, Account setup and Platform, while pure tests prove dual/mixed selection.
- [x] **CrewQuo Platform admin workspace** (2026-08-18): `0010_platform_admin.sql` adds immutable platform audit and typed settings; platform APIs provide dashboard, users, access/session controls, reporting, operational queues, audit and settings; every existing plan/company mutation now also records platform attribution. The top-right company selector exposes synthetic `CrewQuo Platform`, the adjacent view is `Super Admin`, and all admin pages remain in the sidebar. `dpnh1989@gmail.com` was promoted through the verified-user bootstrap command. Detail: [platform-admin.md](docs/product/platform-admin.md).
- [ ] **Company ownership/creation safeguard (§3.1.1):** preserve unlimited invitation-based memberships but ledger one automatic first-company creation per verified customer identity; require a single-use fresh-checkout or audited-admin approval for every additional distinct business; give each company an independent subscription/data boundary; prevent trial resets; add duplicate/recovery handling, safe legacy-owner backfill, support controls and the onboarding/profile UI
- [ ] **Money boundary:** currency on new commercial agreements/documents, project reporting currency and frozen FX snapshots before unlike PAY/BILL currencies are allowed; tax identity/address, line-tax, credit-note and payment-allocation requirements before calling project invoices tax-compliant
- [ ] Merchant-of-Record billing via **Gumroad** (decided 2026-08-17): checkout, signed/deduplicated webhooks, trial→paid, entitlement snapshots and real seller-account lifecycle rehearsal
- [ ] Super-admin price editor + subscription management
- [ ] **Durable delivery foundation:** transactional outbox, webhook inbox, durable jobs, retry/dead-letter/replay controls and enforced idempotency on create/submit/approve; move audit purge and derivatives off process-local timers
- [ ] Push + email notifications (Resend) with preferences, quiet hours/digests, delivery history and retry-safe delivery
- [ ] **Universal Action Centre foundation** for approvals, exceptions and failed operations
- [ ] Company/project IANA time zones, locale-safe formatting and WCAG 2.2 AA accessibility gate
- [ ] Security hardening: MFA/recovery for privileged accounts, session/device controls, rate limits, secret rotation, support-access controls and tenant-boundary threat model
- [ ] Production observability with tenant/request/job correlation, support tooling, data export/deletion workflow, documented RPO/RTO, backup **and restore** rehearsal and launch/incident runbooks
- [ ] Public marketing + legal pages (pricing/terms/privacy/refunds)

**Non-negotiable throughout:** the ten calculation principles (§41), `record_revisions` + `recordAudit` on every new mutation (§36), entitlement keys registered (§43), tests written with the code (§44), and the Phase 0–4 end-to-end scripts re-run green at the end of every phase.

## Phase 7 — Evidence foundations — plan §21–§24, §37

- [ ] **7.0 Storage service** (§22.1): `stored_files`, R2 presign → PUT → complete, `sharp` WEB/THUMB derivatives, originals retained, authorized presigned downloads, `storage_gb` metering. **Retro-fits the Phase 3 deferred expense receipt upload.**
- [ ] **7.1 Capability layer** (§37): `capabilities`, bundles, per-membership overrides, `resolveCapabilities`, `hasCapability`. Null bundle derives from the existing role — zero behaviour change for existing companies
- [ ] **7.2 Project locations** (§21): tree, depth cap 4, cycle rejection
- [ ] **7.3 Project evidence** (§22): 14 categories, batch upload + camera + drag-drop, batch metadata, three distinct timestamps, gallery/timeline/filters, sticky report selection
- [ ] **7.4 Project documents** (§24): 16 categories, versioning via `supersedes_id`, expiry
- [ ] **7.5 Site diary** (§23): structured attendance, Close Day, post-close revisions with required reason + "amended N times" everywhere it appears
- [ ] **7.6 Web UI:** project section shell (§20) — evidence gallery/timeline/filters with drag-and-drop batch upload, document manager and diary editor with Close Day
- [ ] **7.7 Thin mobile field validation:** mobile shell/project context, direct photo capture, basic diary entry, background upload retry, offline draft queue and field/low-connectivity acceptance test
- [ ] **Privacy/lifecycle defaults:** evidence private by default with project default + batch publish; GPS/EXIF location off unless explicitly governed; upload validation/malware controls; artifact-class lifecycle, legal hold and report/sign-off snapshot preservation
- [ ] **Milestone:** a full day's evidence — photos, documents and closed diary — captured on desktop and through the thin phone flow, surviving offline/retry and deliberate client publication

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

Complete and productionize the field workspace against supervisor and crew jobs. Phase 7.7 has already proved the shell, evidence/diary slice and offline contract; this phase expands them across the complete mobile workflow.

- [ ] **13.1** Complete the mobile product shell: production navigation, auth, company/project context, design system, accessibility and resilient API state, building on the Phase 7.7 proof
- [ ] **13.2** Supervisor site experience — `(app)/site/` and its 11 actions (§32)
- [ ] **13.3** Complete evidence capture — multi-shot, batch metadata, project/date/location pre-fill and production background upload/recovery (§22.3)
- [ ] **13.4** Site diary on mobile — write, attendance confirm, Close Day + missing-data prompts (§23)
- [ ] **13.5** Assets & waste — Assets Removed, Waste/Reuse, destination assignment on site (§25)
- [ ] **13.6** Read-and-confirm surfaces — schedule (not drag), phone-appropriate project sections, timeline, compliance flags
- [ ] **13.7** Sign-off capture — signature on glass (§34)
- [ ] **13.8** Complete offline capture — extend the Phase 7.7 draft queue and conflict UX across diary/evidence/assets; prove recovery after app/process/device interruption
- [ ] **13.9** EAS store submission — dev-client, production builds, OTA channels and listings for the complete field app
- [ ] **13.10** Maestro E2E: start shift → photo → diary → assets → complete day
- [ ] **Milestone:** a supervisor runs an entire site day from a phone through a coherent field product sharing the same data and rules as web

> **Sections that reach mobile:** Overview · Schedule (read) · Crew · Site Diary · Photos & Evidence · Assets & Materials · Variations (create) · Documents (read) · Client Sign-Off. **Web only:** Time & Costs beyond own entry · Sustainability · Reports · full commercial view.

## Future backlog (not part of the numbered build)

- [ ] Real-time updates
- [ ] Any v1 customer-data onboarding/importer requires a separate specification (§12)

---

## ✅ Owner decisions — answered 2026-08-17 and 2026-08-18 (plan §17)

- [x] **Placeholder→linked merge policy → AUTO-MERGE.** On invite accept, if the invitee already owns a real company, the placeholder is claimed automatically (`companies.claimed_by_company_id`) and the engagement re-points to the real company — no confirmation prompt on either side. *Owner chose auto over the manual/two-sided-confirm recommendation; proceed as decided.* Open implementation assumption: if the accepting user owns **several** companies, merge into the one they're acting as (active company), falling back to their sole company when there's only one.
- [x] **Rate rules are per-company — nothing about rates may be hardcoded.** ✅ **Implemented 2026-08-17.** The `FRI_SAT_NIGHT` branch is gone from `resolveRateLabel`; label rules live in `rate_card_templates.timeframe_definitions` as `label_rule` entries, with one template per company elected as the default the engine reads. Migration 0007 backfilled the old behaviour for anyone who was relying on it. This superseded the old "verify against v1" decision — the rule wasn't verified, it was removed.
- [x] **Currency → USD default, user-changeable.** ✅ **Company default implemented 2026-08-17.** Migration 0006 moves the column default to `'USD'` and backfills existing `'GBP'` rows; `PATCH /v1/companies/:id` (OWNER/ADMIN) makes it changeable. **Planned 2026-08-18:** new commercial agreements/documents carry currency; unlike PAY/BILL currencies require a project reporting currency and frozen FX snapshot so margin never subtracts unlike units.
- [x] **MoR → Gumroad** (replaces the Lemon Squeezy vs Paddle choice) — Phase 6. Confirm PH payout method and verify Gumroad's subscription-webhook coverage before building against it.
- [x] **Application direction → one totally new v2 app.** Existing web/mobile screens are prototypes and reusable code only; they do not define the target information architecture, workflows or visual system.

### Still open

- [ ] **Real per-currency pricing numbers** (USD anchors exist; confirm the actual amounts) — Phase 6
- [ ] **Gumroad production verification:** complete seller KYC/payout setup and prove purchase, renewal, failed payment, cancellation, refund and replay-safe reconciliation with a real test membership — Phase 6

### Product-foundation decisions adopted 2026-08-18

- [x] **Commercial rates:** subcontractors/providers may propose PAY schedules for an assigned main company; the main company approves or rejects, and every submitted change creates a new immutable effective version. Main-company direct entry remains available; BILL rates stay private.
- [x] **Reliability:** transactional outbox, webhook inbox, durable jobs, idempotency, retries, dead-letter visibility and replay are product foundations, not launch polish.
- [x] **Decision evidence:** rate approval, invoice issue, report generation and sign-off evidence commit transactionally with the business action; the audit feed may be a projection but is never the only record.
- [x] **Authorization:** a capability is necessary but insufficient; company edge and project/resource assignment must also authorize access.
- [x] **Field/offline:** offline capture is in scope; design the contract before Phase 7 APIs harden, prove a thin phone slice in Phase 7.7 and complete it in Phase 13.
- [x] **Privacy/lifecycle:** evidence is private by default; GPS/EXIF location is off by default; retention is artifact-specific with legal hold and immutable report/sign-off references.
- [x] **Sustainability:** displacement defaults to `UNKNOWN`; enabling emissions follow and disclose a selected methodology.
- [x] **Global/accessibility:** company/project IANA time zones and WCAG 2.2 AA are baseline requirements.
- [x] **Branding:** client-company logo is the default, project override is allowed and generated reports freeze the selected asset.
- [x] **Operating model:** every domain gets the §19.5 responsibility/state/permission/event/failure/privacy/offline/analytics/acceptance packet, and approvals/exceptions converge in a Universal Action Centre.
- [x] **Company creation:** users may hold unlimited invited memberships, but a verified customer identity receives only one permanently ledgered automatic first-company creation. Every additional distinct business requires a single-use fresh-subscription checkout or audited super-admin approval, owns a separate subscription/data boundary and cannot reset trial eligibility (§3.1.1).
- [x] **Workspace views:** the customer product has exactly three runtime perspectives—Contractor/Operations, Subcontractor and Client. Nonpaying assigned companies see only their eligible Client/Subcontractor controls; mixed-position companies can switch; roles/capabilities refine a view; mobile Field sits inside Operations/Subcontractor; Platform Admin remains the separate internal console (§9.2).

### Domain decisions for the unified v2 build (full detail in plan §45)

- [ ] **Emission factor dataset redistribution terms** — confirm licensing before bundling UK Gov GHG (or WRAP/Defra) factors; until then orgs import their own — Phase 9
- [ ] **Feature packaging** for the new modules — the §43 tier table is a proposal, not a decision — Phase 7
- [x] **Enabling-emissions policy** — methodology-configurable and disclosed; no silent universal rule — Phase 9
- [x] **Default displacement assumption** — `UNKNOWN`; require an explicit attributable assumption for a claim — Phase 9
- [x] **Offline capture** — in scope; Phase 7.7 proof then Phase 13 completion
- [x] **Client-visibility default for evidence** — private by default, configurable per project with deliberate batch publish — Phase 7
- [x] **GPS/EXIF location on evidence** — off by default; enable only with purpose, notice, access and retention rules — Phase 7
- [x] **Retention/lifecycle for evidence originals** — artifact-class lifecycle + legal hold; issued report/sign-off references preserved — Phase 7
- [x] **Client logo source** — client-company default, optional project override, frozen into report snapshot — Phase 10
