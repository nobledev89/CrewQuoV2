# CrewQuo v2 — Unified Build Specification

> **Product decision:** CrewQuo v2 is one new, independent application. Its scope includes the commercial core, field operations, project evidence, asset and material tracking, sustainability, reporting, scheduling, compliance, the client experience, web and mobile. Together they define v2.
> **Implementation status:** Phases 0–4 have produced reusable backend, shared-domain and prototype client code (see `PROGRESS.md`). That code is implementation progress, not a product or UX constraint. Keep correct, tested domain behavior; replace or reshape APIs, navigation, screens and workflows when the unified product requires it.
> **Relationship to v1:** v2 has no runtime connection to v1. v1 (Next.js + Firebase) may stay live while v2 is built, but it supplies neither the information architecture nor the acceptance criteria. There is no shared database, shared auth, dual-write, synchronization, parity requirement, or production-data migration in scope.

---

## 0. For the implementing agent — read this first

**This is one plan (§1–§47).** Earlier section numbers describe the platform core and later section numbers describe the wider operational product, but they are one app, one architecture and one release direction. `PROGRESS.md` records what happens to exist today; unchecked work anywhere in this document remains part of the unified v2 build.

Before changing a module, inspect the implementation that already exists, then judge it against this specification. Reuse is earned by fit and correctness—not by age. The existing rate engine, authorization policies, tenancy model and export model are valuable tested components, but no existing route, schema or screen is protected merely because it shipped during an earlier phase.

Rules that hold across the whole build:

1. **Build phase-by-phase (§42). Do not batch phases.** Each phase is independently demoable and testable. Ship and verify one before starting the next — that is how Phases 0–4 were built, and it worked.
2. **Database changes are forward-only.** Use numbered SQL files in `infra/migrations/`. Because this application has not launched, a cleaner unified model may replace an early pre-launch shape when necessary; make the change explicitly, update every caller, and prove it with tests. “Backward compatibility” with prototype data or prototype APIs is not a product goal.
3. **Treat the DDL and API contracts in this document as canonical.** They are fully specified — do not invent alternative shapes.
4. **Domain logic goes in `packages/shared` as pure functions** (no DB imports), the way the rate engine does. The API loads rows and passes them in. This is what makes it exhaustively testable, and the sustainability numbers *must* be exhaustively tested.
5. **The calculation principles in §41 are non-negotiable.** They outrank convenience, UI polish and schedule. Read them before writing a single carbon-related line.
6. **When a genuine product decision is unspecified, stop and ask the user** rather than guessing. The open items are listed in §17 and §45; everything else is decided.
7. **Design the application as one coherent product.** The screen inventory, purpose, data and actions are specified (§8/§9, §20, §32), while §40 sets the experience constraints. Existing web and mobile screens are references only; do not reproduce their navigation or layout by default.

Conventions used in the DDL: every table has `id uuid primary key default gen_random_uuid()`, `created_at timestamptz not null default now()`, and `updated_at timestamptz not null default now()` unless stated otherwise. Enumerated values are `text` columns with `CHECK` constraints (easier to migrate than native enums); allowed values are listed inline. Money is stored as integer minor units (`*_cents`) unless noted. **Physical quantities are `numeric`, never integer minor units** — mass in kilograms, distance in kilometres, energy in kWh, emissions in kgCO₂e (§25.3, §41). All foreign keys are `not null` unless marked `nullable`.

---

## 1. Why we are doing this

CrewQuo v2 is the operating system for companies that deliver projects through their own teams, subcontractors, suppliers and clients. It connects commercial control with what happens on site: scope and rates, crew and time, evidence and documents, assets and material outcomes, carbon calculations, client reporting and sign-off.

The product is new. It is not a reskin of v1, a screen-for-screen replacement, or a migration utility. The architecture is relational because the domain is relational; authorization lives in the API because company and project boundaries must be explicit and testable. Those are product foundations, not a mandate to preserve an older application's structure.

### Goals
- **One product, purpose-built surfaces.** Web is the operational and administrative workspace; mobile is the field workspace. They share the same domain and design language, but each is designed around its context instead of copying the other.
- **Straight to the point.** Fewer screens, fewer taps, opinionated default flows.
- **Complete project lifecycle.** A team can win, plan, staff, deliver, evidence, cost, report and close a project without leaving CrewQuo.
- **Trustworthy records.** Commercial, audit and sustainability outputs are reproducible and traceable to their source records.
- Own the backend: Postgres + a TypeScript API on Render, deployable and debuggable end to end.
- Preserve only proven domain ideas that still fit, particularly the **rate/margin engine** and **PAY vs BILL** model.

### Non-goals
- Reproducing v1's screens, navigation, data model or feature boundaries.
- Migrating or synchronizing v1 production data.
- Treating the current prototype clients as the target user experience.
- Real-time collaboration / live sync.
- General-purpose ERP/accounting, payroll, fleet telematics or carbon-accounting certification.

### Definition of v2 complete

The unified build is complete only when Phases 0–13 are complete: a company can onboard and subscribe; plan, staff and commercially control a project; capture time, cost, evidence, diary, assets and material outcomes; calculate traceable sustainability results; manage variations, scheduling and compliance; produce reproducible client reports and sign-off; and run the appropriate workflows through the finished web and mobile experiences. Completing the old core loop or the web shell alone is not “v2 complete.”

---

## 2. Target architecture

Single Turborepo monorepo, pnpm workspaces.

```
crewquo-v2/
├─ apps/
│  ├─ mobile/        Expo + expo-router (purpose-built field workspace)
│  ├─ web/           Next.js on Vercel (operations, commercial, client and admin workspaces)
│  └─ api/           Express 5 + node-postgres on Render
├─ packages/
│  ├─ shared/        Zod schemas, domain types, the rate engine (pure TS, no I/O)
│  ├─ api-client/    Typed fetch client built from shared Zod schemas (web + mobile)
│  └─ ui/            Design tokens + RN-first primitives (shared where practical)
├─ infra/            migration runner, seed scripts, docker-compose (local pg)
├─ package.json      workspaces + turbo tasks
├─ turbo.json
└─ pnpm-workspace.yaml
```

**Stack (all decided — see §16)**

| Concern | Choice | Notes |
|---|---|---|
| DB | **Render Postgres** | Relational fit. |
| API | **Express 5 + `pg`** (raw SQL) | Lightweight; adopt Drizzle later only if queries get painful. |
| Validation | **Zod** (in `packages/shared`) | One schema → API validation + client types. |
| Auth | **JWT (access+refresh) + bcrypt + Google sign-in** | Replaces Firebase Auth/claims. §5. |
| Cache | **Render Redis** (Phase 2+) | Refresh-token store, entitlement cache, rate-limit buckets. |
| File storage | **Cloudflare R2** (S3-compatible) | Exports, attachments, avatars; presigned uploads. |
| Email | **Resend** | Invites, approvals, password reset. |
| Web host | **Vercel** | Next.js. |
| Mobile | **Expo + EAS** | OTA updates, managed builds. |
| Billing | **Merchant of Record — Lemon Squeezy (primary), Paddle (alt)** | §5B. |
| Exports | **Server-side `jspdf` + `exceljs` in `apps/api`** | Identical files for web + mobile. `exceljs` replaced `xlsx`: SheetJS's last public-npm release (0.18.5) carries CVE-2023-30533/CVE-2024-22363 and current builds ship only from its own CDN. |
| Monitoring | **Sentry** (api/web/mobile) | + structured logs + `/healthz`. |

---

## 3. Domain model & full DDL

**The canonical model.** Every party (contractor, subcontractor, client) is a `companies` row. Relationships are **directed edges** in `engagements`. "Client" and "subcontractor/provider" are *positions on an edge*, relative and reversible — **not** user roles and **not** separate tables. This replaces v1's separate `clients`, `subcontractors`, `clientOrganizations`, `clientUsers`, `contractorClientRelationships`, and `clientProjectAccess` collections.

### 3.1 Identity & tenancy

```sql
create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text,                          -- null when Google-only
  google_sub    text unique,                   -- Google subject id, null if not linked
  name          text not null,
  avatar_url    text,
  is_super_admin boolean not null default false, -- platform staff, not a company role
  email_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table companies (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  currency      text not null default 'GBP',   -- ISO 4217; set ONCE per company, rate cards inherit
  is_placeholder boolean not null default false, -- stub for a party not yet on CrewQuo (e.g. "PwC")
  claimed_by_company_id uuid references companies(id), -- when a placeholder is merged into a real co.
  settings      jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- user ↔ company. Replaces ALL of v1's ownCompany/activeCompany/subcontractorRoles claims.
create table memberships (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  role       text not null check (role in ('OWNER','ADMIN','MANAGER','MEMBER')),
  status     text not null default 'ACTIVE' check (status in ('ACTIVE','INVITED','SUSPENDED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, company_id)
);
create index on memberships (company_id);
create index on memberships (user_id);
```

> **The single most important design decision:** v1's `activeCompanyId` context-switching (a user working across multiple companies) is now a plain `memberships` join table. "Switch active company" = pick a different membership row. Every access check is `WHERE company_id = $activeCompanyId AND EXISTS (a membership for this user)`. There are no claims to refresh, ever.
>
> **Role semantics:** a membership role governs what a user can do *inside their own company* (OWNER/ADMIN/MANAGER can manage; MEMBER = worker who logs time). Whether that company is a *client* or *provider* on a given piece of work is derived from the **engagement**, never from the role. There is no `CLIENT` or `SUBCONTRACTOR` user role in v2.

### 3.2 Engagements (the relationship graph)

```sql
create table engagements (
  id                  uuid primary key default gen_random_uuid(),
  client_company_id   uuid not null references companies(id),  -- the hirer (pays, approves timesheets)
  provider_company_id uuid not null references companies(id),  -- the subcontractor (delivers, submits up)
  status  text not null default 'ACTIVE' check (status in ('PENDING','ACTIVE','PAUSED','ENDED')),
  created_by_company_id uuid not null references companies(id), -- who initiated (must have operates_downstream)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (client_company_id <> provider_company_id),
  unique (client_company_id, provider_company_id)
);
create index on engagements (client_company_id);
create index on engagements (provider_company_id);
```

Examples: `client=PwC, provider=CSL`; `client=CSL, provider=Pashe`; `client=Hanmore, provider=CSL` (reversed — fine). **Creating an engagement where you are the client requires your company's plan to have `operates_downstream = true`** (§5B). **One-hop rule:** a company sees an engagement only if it is one of the two endpoints — visibility never traverses past a direct edge, at any depth. CSL cannot see who Pashe hires below.

### 3.3 Rate engine tables

```sql
create table role_catalog (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name       text not null,                    -- e.g. "Rigger", "Camera Op"
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, name)
);

create table rate_card_templates (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name       text not null,
  timeframe_definitions jsonb not null default '[]', -- holiday/timeframe defs (see §6); shape from v1
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table rate_cards (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade, -- the card owner
  kind         text not null check (kind in ('PAY','BILL')),  -- PAY=paid to a provider; BILL=charged to a client
  counterparty_company_id uuid references companies(id),       -- specific provider(PAY)/client(BILL); null=default
  role_id      uuid not null references role_catalog(id),
  rate_mode    text not null check (rate_mode in ('HOURLY','SHIFT','DAILY')),
  rate_label   text not null check (rate_label in
                 ('MON_FRI_DAY','FRI_SAT_NIGHT','MON_THU_NIGHT','SUNDAY','SHIFT','DAILY')),
  hourly_rate_cents    integer,
  ot_hourly_rate_cents integer,
  shift_rate_cents     integer,
  daily_rate_cents     integer,
  min_hours            numeric(6,2),
  weekend_multiplier   numeric(6,3),
  night_multiplier     numeric(6,3),
  effective_from date not null,
  effective_to   date,                          -- null = open-ended
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on rate_cards (company_id, kind, role_id, rate_label, effective_from desc);
```

- **PAY** = what the owner pays a provider; **BILL** = what the owner charges a client. Margin = BILL − PAY. **Currency is inherited from `companies.currency` — never stored per card** (decision #5).
- **Security-critical:** a provider must never read the client-side BILL card of an engagement (it reveals margin). Enforced in the API (§4), not the DB.
- `rate_label` stores stable codes; the display strings ("Mon–Fri Day", etc.) live in the rate engine (§6). The v1→v2 code mapping is in §6.

### 3.4 Projects & work capture

```sql
create table projects (
  id                uuid primary key default gen_random_uuid(),
  owner_company_id  uuid not null references companies(id) on delete cascade, -- runs it / its own books
  client_company_id uuid references companies(id),         -- who it's for (may be placeholder or null)
  engagement_id     uuid references engagements(id),       -- the client-side edge, if any
  name    text not null,
  status  text not null default 'ACTIVE' check (status in ('PLANNED','ACTIVE','COMPLETED','ARCHIVED')),
  client_visible boolean not null default false,           -- exposes it in the client's portal
  starts_on date, ends_on date, notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on projects (owner_company_id);
create index on projects (client_company_id) where client_company_id is not null;

-- which providers are engaged on a project (their workers log time under this)
create table project_assignments (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  provider_company_id uuid not null references companies(id),
  engagement_id uuid not null references engagements(id),   -- owner(client) ⇄ provider edge
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, provider_company_id)
);

create table time_logs (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id),   -- flows UP this edge for approval
  project_id    uuid not null references projects(id),
  provider_company_id uuid not null references companies(id),
  logged_by_user_id   uuid not null references users(id),
  role_id       uuid not null references role_catalog(id),
  shift_type    text not null check (shift_type in ('WEEKDAY_DAY','NIGHT','SUNDAY','SHIFT','DAILY')),
  work_date     date not null,
  hours_regular numeric(6,2) not null default 0,
  hours_ot      numeric(6,2) not null default 0,
  status        text not null default 'DRAFT'
                  check (status in ('DRAFT','SUBMITTED','APPROVED','REJECTED')),
  resolved_rate jsonb,                          -- rate snapshot at submit time (PriceCalculation, §6)
  reviewed_by_user_id uuid references users(id),
  reviewed_at   timestamptz,
  reject_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on time_logs (engagement_id, status);
create index on time_logs (project_id);
create index on time_logs (provider_company_id, status);

create table expenses (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id),
  project_id    uuid not null references projects(id),
  provider_company_id uuid not null references companies(id),
  logged_by_user_id   uuid not null references users(id),
  amount_cents  integer not null,
  category      text,
  description   text,
  receipt_url   text,                           -- R2 object
  status        text not null default 'DRAFT'
                  check (status in ('DRAFT','SUBMITTED','APPROVED','REJECTED')),
  reviewed_by_user_id uuid references users(id),
  reviewed_at   timestamptz,
  reject_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on expenses (engagement_id, status);

-- a provider's submission package (a period of work handed up to the client)
create table project_submissions (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id),
  project_id    uuid not null references projects(id),
  provider_company_id uuid not null references companies(id),
  period_start date, period_end date,
  status text not null default 'DRAFT'
           check (status in ('DRAFT','SUBMITTED','APPROVED','REJECTED')),
  submitted_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

**Workflow invariant (preserve exactly from v1):** the *provider side* may create/edit a `time_log`/`expense`/`submission` only while `DRAFT`/`REJECTED`, and the only transition they may drive is `DRAFT → SUBMITTED`. The *client side* (owner of the engagement's client company) ADMIN/MANAGER approves/rejects. See `firestore.rules` `timeLogs`/`expenses`/`projectSubmissions` for the exact conditions.

### 3.5 Invoices

```sql
create table invoices (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id),
  issuer_company_id      uuid not null references companies(id), -- who bills
  counterparty_company_id uuid not null references companies(id), -- who is billed
  project_id    uuid references projects(id),
  number        text,
  status text not null default 'DRAFT' check (status in ('DRAFT','ISSUED','PAID','VOID')),
  currency      text not null,
  subtotal_cents integer not null default 0,
  tax_cents      integer not null default 0,
  total_cents    integer not null default 0,
  issued_at timestamptz, due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table invoice_items (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references invoices(id) on delete cascade,
  description text not null,
  quantity    numeric(10,2) not null default 1,
  unit_amount_cents integer not null,
  amount_cents      integer not null,
  source_type text check (source_type in ('TIME_LOG','EXPENSE','MANUAL')),
  source_id   uuid,
  created_at timestamptz not null default now()
);
```

### 3.6 Portal notes, audit, invites

```sql
-- comments on a project / line item; either side of an engagement may add per audit_settings
create table line_item_notes (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id),
  entity_type   text not null check (entity_type in ('PROJECT','TIME_LOG','EXPENSE','INVOICE')),
  entity_id     uuid not null,
  author_company_id uuid not null references companies(id),
  author_user_id    uuid not null references users(id),
  body          text not null,
  resolved      boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on line_item_notes (entity_type, entity_id);

-- append-only. No update/delete via app. Cleaned nightly by expires_at (Postgres has no TTL).
create table audit_logs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id),   -- whose activity
  actor_user_id uuid references users(id),
  action      text not null,                            -- e.g. 'time_log.approved'
  entity_type text not null,
  entity_id   uuid,
  changes     jsonb,
  description text,
  visible_to_client boolean not null default false,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null                      -- created_at + retention (from entitlements)
);
create index on audit_logs (company_id, created_at desc);
create index on audit_logs (expires_at);

-- per-engagement settings for what the client sees / can do in the portal
create table audit_settings (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) unique,
  client_can_comment boolean not null default true,
  show_audit_trail   boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- unified invite table (replaces v1's invites, subcontractor invite tokens, clientUserInvites)
create table invites (
  id            uuid primary key default gen_random_uuid(),
  invite_token  text not null unique,                   -- opaque capability, used in public endpoints
  kind          text not null check (kind in ('MEMBER','ENGAGEMENT','CLIENT_PORTAL')),
  target_company_id uuid not null references companies(id), -- company the invitee joins/links to
  email         text not null,
  role          text check (role in ('OWNER','ADMIN','MANAGER','MEMBER')), -- for MEMBER invites
  engagement_id uuid references engagements(id),         -- for ENGAGEMENT/CLIENT_PORTAL invites
  status        text not null default 'PENDING' check (status in ('PENDING','ACCEPTED','REVOKED','EXPIRED')),
  invited_by_user_id uuid references users(id),
  expires_at    timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### 3.7 Plans, entitlements, billing — see §5B for the full table set

`features`, `limits`, `plans`, `plan_prices`, `plan_features`, `plan_limits`, `company_subscriptions`, `company_entitlement_overrides`, plus `refresh_tokens` (auth, §5) and `system_settings (key pk, value jsonb)`.

---

## 4. Authorization

Every authenticated request resolves an **auth context** once, in middleware:

```ts
type Ctx = {
  userId: string;
  companyId: string;                          // active company (from X-Company-Id, validated vs memberships)
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER';
  isSuperAdmin: boolean;
};
```

There is **no CLIENT/SUBCONTRACTOR role** — those are engagement positions, resolved per-resource. Authorization = ordinary code + SQL, centralized in `apps/api/src/authorization/policies.ts`:

- **Company scoping:** every query filters by the active `companyId`. Cross-tenant rows are never selected.
- **Engagement one-hop:** a company may read an engagement/project/time_log/invoice only if its `companyId` is the `client_company_id` **or** `provider_company_id` of the relevant engagement. Never deeper. This is the privacy guarantee at any chain depth.
- **Provider vs client actions:** on an engagement, the **provider** side creates/edits work while `DRAFT`/`REJECTED` and drives `DRAFT→SUBMITTED`; the **client** side (OWNER/ADMIN/MANAGER of the client company) approves/rejects.
- **PAY/BILL guard:** the provider side of an engagement can never read the client side's BILL rate cards or computed margin.
- **Entitlement gates (§5B):** creating a downstream engagement requires `operates_downstream`; metered actions call `withinLimit(companyId, key, projected)`; feature-gated routes call `hasFeature(companyId, key)`.
- **Role gates:** `requireRole('OWNER','ADMIN','MANAGER')` on management mutations.
- **Super admin:** `isSuperAdmin` bypasses company scoping for the super-admin console only (§5B).

**Parity requirement:** for every rule in v1's `firestore.rules`, write one API-authorization test asserting the same allow/deny outcome (§13).

---

## 5. Authentication

- **Passwords:** bcrypt (cost 12). **Tokens:** short-lived JWT access token (15 min) + rotating refresh token persisted in `refresh_tokens (id, user_id, token_hash, expires_at, revoked_at)`. Mobile stores tokens in `expo-secure-store`; web uses httpOnly, Secure, SameSite=Lax cookies.
- **Google sign-in:** `google-auth-library` `verifyIdToken` → upsert `users.google_sub`. Offered beside email/password on both clients.
- **Password reset / email verification:** Resend + signed, single-use, expiring tokens.
- **Token payload holds only `userId`** (plus optionally the active `companyId`). Everything else is resolved from `memberships` per request — no stale-claims problem, no refresh scripts.
- **Endpoints:** `POST /v1/auth/register | login | google | refresh | logout | request-password-reset | reset-password | verify-email`.

---

## 5B. Plans & entitlements (super-admin configurable)

Plans are **data, not code.** The super-admin edits plans/prices/features/limits from a console — no deploy. One resolver enforces everything.

### Schema
```sql
create table features (key text primary key, name text not null, description text, category text);
create table limits   (key text primary key, name text not null, description text,
                       unit text not null default 'count', unlimited_allowed boolean not null default true);

create table plans (
  id text primary key,                         -- slug, e.g. 'pro'
  name text not null, description text,
  status text not null default 'DRAFT' check (status in ('DRAFT','ACTIVE','ARCHIVED')),
  is_public boolean not null default true,
  operates_downstream boolean not null default false,  -- can add own subcontractors?
  sort_order int not null default 0,
  trial_days int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table plan_prices (
  id uuid primary key default gen_random_uuid(),
  plan_id text not null references plans(id) on delete cascade,
  currency text not null, interval text not null check (interval in ('MONTH','YEAR')),
  amount_cents int not null, provider_price_id text, active boolean not null default true
);
create table plan_features (plan_id text references plans(id) on delete cascade,
                            feature_key text references features(key),
                            primary key (plan_id, feature_key));
create table plan_limits   (plan_id text references plans(id) on delete cascade,
                            limit_key text references limits(key),
                            value int,           -- null = unlimited
                            primary key (plan_id, limit_key));

create table company_subscriptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  plan_id text not null references plans(id),
  status text not null check (status in ('TRIALING','ACTIVE','PAST_DUE','CANCELED')),
  currency text, interval text,
  current_period_end timestamptz, trial_end timestamptz,
  provider_subscription_id text,               -- MoR subscription id
  entitlements_snapshot jsonb,                 -- grandfathering (see below)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id)
);
create table company_entitlement_overrides (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  feature_key text references features(key),   feature_enabled boolean,
  limit_key text references limits(key),        limit_value int,   -- null value = unlimited
  note text, expires_at timestamptz,
  created_at timestamptz not null default now()
);
```

### Catalog (the initial `features` / `limits` keys the code enforces)
- **features:** `rate_cards`, `holiday_rates`, `exports`, `client_portal`, `client_portal_notes`, `invoicing`, `audit_visibility`, `api_access`, `sso`, `white_label`.
- **limits:** `active_subcontractors`, `internal_seats`, `clients`, `audit_retention_days`.

Adding a *new* key requires a one-line enforcement hook the first time; after that it's fully admin-driven. This is the only non-config boundary.

### Enforcement — one resolver
`resolveEntitlements(companyId)` = `plan_features`/`plan_limits` ⊕ `company_entitlement_overrides` → `{ features: Set<string>, limits: Record<string, number|null> }`. Cached in Redis, invalidated on any plan/override/subscription change.
- `hasFeature(companyId, key)` guards routes and hides UI.
- `withinLimit(companyId, key, projected)` checked at mutation time; surfaced in UI as "23 / 30".
- `operates_downstream` is read straight from the active plan.

### Super-admin console (`apps/web`, `isSuperAdmin` only)
Plans CRUD (create/edit/reorder/publish/archive; trial days; `operates_downstream`) · price editor per currency+interval (syncs to MoR) · feature matrix · limit matrix · companies view (live usage vs limits, apply overrides, comp/extend trials, force plan change) — every change written to `audit_logs`.

**Implemented 2026-08-17** across two screens: `/admin/plans` (the catalog everyone resolves against) and `/admin/companies` (one account at a time). Two rules the console follows rather than re-deriving: it reads `resolveEntitlements` and `getAllUsage`, so it can never display an allowance the product would refuse; and platform staff usually own **no company**, so the `/admin/*` area is the one part of the workspace that renders without an active membership. Placeholder companies are hidden from the list by default — every invite creates one (§3.6).

### Seed plans (editable rows, not constants)

| Plan | Price (USD/mo, billed yearly) | operates_downstream | active_subcontractors | internal_seats | audit_retention_days | features |
|---|---|---|---|---|---|---|
| **Crew** | 0 | false | 0 | 1 | 0 | (provider-only: log & submit up) |
| **Starter** | 39 | true | 5 | 2 | 30 | rate_cards, holiday_rates, exports, client_portal |
| **Pro** ⭐ | 119 | true | 30 | 8 | 90 | + client_portal_notes, invoicing, audit_visibility |
| **Business** | 349 | true | 150 | 25 | 365 | + api_access, sso, white_label |
| **Enterprise** | custom | true | unlimited | unlimited | unlimited | all |

Monthly (no annual commit) ≈ +20%. Trial: 14 days on paid plans, no card. Metering axis = **active subcontractors** only; client portal is a feature gate, not a second meter. "Be a subcontractor" (Crew) is free forever — the growth funnel. Placeholder clients are free/unlimited (only real portal logins count toward `clients`).

> **The placeholder-client exemption is live as of 2026-08-17.** `countClients` excludes engagements whose client side is still `is_placeholder`, which required first clearing that flag when an invitee *claims* a stub (§3.6 CLAIMED path) — until then the flag stayed true for companies that had genuinely joined, and filtering on it would have excluded real customers instead of stubs. `countActiveSubcontractors` deliberately does **not** get the same exemption and still counts `PENDING` edges: the exemption above names clients only, and a free pending subcontractor edge would let the `active_subcontractors` cap be walked past by inviting.

### Billing — Merchant of Record (required: PH-based seller, no local business permit)
Stripe-direct (PH unsupported) and local PH gateways (need DTI/SEC) are ruled out. Use an **MoR** — the provider is the legal seller, so no permit is needed and they handle global VAT/GST.
- **Lemon Squeezy — primary** (SaaS-native, Stripe-owned as of 2026, bank/PayPal payouts, easy onboarding).
- **Paddle — alternative at scale** (needs live pricing + ToS + Privacy + Refund pages to verify).
- Backups: Polar, Dodo Payments.

CrewQuo plans are the source of truth; mirror each `plan_price` to a provider product (`provider_price_id`), use hosted checkout, consume webhooks to sync `company_subscriptions.status`. **Caveats:** MoR still needs KYC + W-8BEN + a payout method (bank/PayPal/Wise/Payoneer — verify PH is listed); fees ≈ 5%; launch with **hard caps** (MoR handles metered billing poorly); the seller's personal PH (BIR) income tax is separate — advise an accountant.

### Grandfathering
On purchase/renewal, snapshot effective entitlements into `company_subscriptions.entitlements_snapshot`. A plan edit affects only new subscribers unless the super admin explicitly "apply to existing."

---

## 6. Rate engine

Implement the validated rate behavior in `packages/shared/src/rate-engine/` as **pure functions over plain data** (no DB imports). The API loads rate cards from Postgres and passes them in. v1's `functions/src/rates.ts` may be used as a behavioral test source, but it is not the target architecture. Preserve the approved commercial rules:

- **`shiftTypeToRateLabel`** mapping — and the DB code equivalence:
  `WEEKDAY_DAY→MON_FRI_DAY`, `NIGHT→MON_THU_NIGHT`, `SUNDAY→SUNDAY`, `SHIFT→SHIFT`, `DAILY→DAILY`. (The `FRI_SAT_NIGHT` label exists for rate cards but is selected by date logic, matching v1's display labels.)
- **`RateResolver.resolveRate`** → SQL query for candidate cards (`company_id, kind, role_id, rate_label, effective_from <= date` ordered `effective_from desc`) + the effective-date selection loop (pick most recent where `effective_to` is null or `>= date`).
- **`extractRate`** per `rate_mode` — HOURLY: `otRate = ot_hourly_rate ?? base*1.5`; SHIFT/DAILY: no OT.
- **`PriceCalculator.calculate`** — SHIFT/DAILY treated as units; `margin = clientBill − subCost`; `marginPct`; round to cents.
- **`applyMinHours`**.
- **`getHolidayInfo`** + holiday multipliers, reading `rate_card_templates.timeframe_definitions` (`type:'holiday'`, `holidayDates:string[]`, `holidayMultiplier`).

Add a Vitest suite pinning **every branch**. Rates are financially sensitive, so inherited behavior is retained only when a named test proves it is still intended.

---

## 7. API contract

REST + Zod, resource-oriented, versioned under `/v1`. All bodies validated by shared Zod schemas that also type `packages/api-client`.

**Conventions.** Auth: `Authorization: Bearer <access>` + `X-Company-Id: <uuid>` (validated vs memberships; ignored for `/auth` and public invite routes). List responses: `{ data: T[], nextCursor: string | null }` (cursor = opaque, keyset on `created_at,id`). Errors: `{ error: { code: string, message: string, details?: unknown } }` with HTTP status; codes: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION`, `LIMIT_EXCEEDED`, `CONFLICT`, `RATE_LIMITED`. Mutations that create/submit/approve accept an `Idempotency-Key` header.

```
# Auth (no X-Company-Id)
POST   /v1/auth/register | login | google | refresh | logout
POST   /v1/auth/request-password-reset | reset-password | verify-email

# Me / context
GET    /v1/me                                  -- profile
PATCH  /v1/me                                   -- own name + avatar (email is not editable here)
GET    /v1/me/memberships                       -- company switcher source
POST   /v1/me/companies                          -- create a new company (become OWNER)

# Companies & engagements
GET    /v1/companies/:id
PATCH  /v1/companies/:id                          (OWNER/ADMIN)
GET    /v1/engagements                            -- where active company is client or provider
POST   /v1/engagements                            (client side; requires operates_downstream + withinLimit active_subcontractors)
PATCH  /v1/engagements/:id                         -- status (pause/end)

# Providers (subcontractors) & members
GET    /v1/providers                              -- companies I engage (client side of my engagements)
POST   /v1/providers                              -- create provider (+ placeholder company + engagement + invite)
GET    /v1/members                                -- memberships in active company
POST   /v1/members/invite                         (OWNER/ADMIN; MEMBER invite; withinLimit internal_seats)
PATCH  /v1/members/:membershipId                  (OWNER/ADMIN; role + status. An admin may not change or
                                                   mint an OWNER; a company keeps >=1 active owner)
DELETE /v1/members/:membershipId                  (OWNER/ADMIN; frees a seat. Same two invariants)

# Rate engine
CRUD   /v1/role-catalog
CRUD   /v1/rate-card-templates
CRUD   /v1/rate-cards                              -- BILL cards never returned to provider side
GET    /v1/rates/resolve?roleId&shiftType&date&counterpartyId&kind   -- resolved rate (uses §6)

# Projects & work
CRUD   /v1/projects
POST   /v1/projects/:id/assignments               -- assign a provider (+engagement)
GET    /v1/projects/:id/summary                   -- server-computed costs, margins, totals
GET    /v1/projects/:id/export.(pdf|xlsx)         -- server-rendered file (feature: exports); owner side only
                                                  -- the CLIENT-side export is Phase 10 (§29.5), from a report snapshot
POST   /v1/time-logs                              (provider MEMBER; status DRAFT)
PATCH  /v1/time-logs/:id                          (owner draft edit)
POST   /v1/time-logs/:id/submit                   (provider: DRAFT→SUBMITTED)
POST   /v1/time-logs/:id/approve | /reject        (client OWNER/ADMIN/MANAGER)
# expenses and project-submissions mirror the same 5 verbs

# Client portal (active company is the CLIENT on the engagement)
GET    /v1/portal/projects                         -- projects where client_company_id = me AND client_visible
GET    /v1/portal/projects/:id                     -- line items, notes, summary
CRUD   /v1/line-item-notes                          (feature: client_portal_notes for write)
GET    /v1/audit-logs                               (visible_to_client filter for client side; feature: audit_visibility)

# Invoices (feature: invoicing)
CRUD   /v1/invoices  /v1/invoices/:id/items
POST   /v1/invoices/:id/issue

# Invites (PUBLIC — token is the capability, no auth)
GET    /v1/invites/:token
POST   /v1/invites/:token/accept

# Billing & entitlements
GET    /v1/billing/plans                            -- public plan catalog
POST   /v1/billing/checkout                         -- returns MoR hosted-checkout URL for a plan_price
POST   /v1/billing/webhook                          -- MoR webhook (no auth; signature-verified)
GET    /v1/entitlements                             -- resolved entitlements + live usage for active company

# Super-admin (isSuperAdmin only). No X-Company-Id — these operate ON companies, not from inside one.
CRUD   /v1/admin/plans  /v1/admin/plans/:id/prices  /v1/admin/features  /v1/admin/limits
GET    /v1/admin/companies            -- ?search (name or member email) &planId &includePlaceholders
                                         &limit &cursor (keyset on created_at,id). Placeholders excluded
                                         by default: every invite creates one, so they outnumber real accounts
GET    /v1/admin/companies/:id        -- resolved entitlements + live usage + every override
POST   /v1/admin/companies/:id/overrides          -- exactly one of the feature pair or the limit pair
DELETE /v1/admin/companies/:id/overrides/:overrideId
POST   /v1/admin/companies/:id/comp-trial         -- { planId, days }; extends a live trial, restarts a lapsed one
POST   /v1/admin/companies/:id/subscription       -- { planId, status, … }: §5B's "force plan change"
```

Every super-admin write that can change what a company may do **invalidates that company's entitlement cache** and is **audited against the subject company**, not the operator's — the trail a customer reads is their own. The `/subscription` route is the one addition to §7's original list; §5B named the capability ("force plan change") without naming a route.

---

### 7.1 Error envelope & identifiers

Every failure returns `{ error: { code, message, details? } }` with the §7 status mapping. Two rules make that hold in practice:

- **A path `:id` that is not a UUID is a 404, not a 500.** `uuidParam` (`http/params.ts`) rejects at the edge, so a malformed id and an id belonging to someone else give the same answer — nothing is learned from the difference.
- **Postgres errors a caller can provoke are 4xx.** `http/pgErrors.ts` maps `22P02`/`22003`/`22007`/`22008` → `VALIDATION`, `23505` → `CONFLICT`, `23503`/`23502`/`23514` → `VALIDATION`, and logs each one. Everything else — a bad query (`42P08`), a connection failure (`08006`) — stays a 500, because it *is* our fault and must not be dressed up as the caller's.

Driver messages never reach the client; the envelope carries a fixed message per code.

---

## 8. Mobile app (Expo — field workspace)

> Mobile is a first-class surface of the unified v2 product. Its target is the supervisor and crew member working on site, often one-handed and under time pressure. The screens currently in `apps/mobile` are an implementation prototype, not the target information architecture.
> Web-led sequencing may be used to stabilize shared domain behavior, but mobile is not a port or a reduced web app. Phase 13 designs and validates the complete field experience against the jobs in this section and §32.

`expo-router`, file-based, bottom-tab layout, **one primary action per screen**. Dependencies: `@tanstack/react-query`, `react-hook-form` + `zod`, `expo-secure-store`, `expo-notifications`, `@sentry/react-native`, `expo-updates` (OTA). Data layer: react-query against `packages/api-client`; optimistic updates on submit/approve.

**Screen inventory** (route → purpose → key data → primary action):
- `(_auth)/login`, `register`, `forgot-password` → auth → — → sign in / Google.
- `(app)/switcher` (modal, header) → pick active company → `/me/memberships` → set X-Company-Id.
- `(app)/index` (Home) → role-aware dashboard → `/entitlements`, counts → contextual CTA.
- `(app)/work/index` → my assigned projects (provider) → `/projects` → open project.
- `(app)/work/[projectId]` → log time / expense → project + rates → **Log time** (shift, date, hours → submit).
- `(app)/approvals/index` → pending SUBMITTED items (client side) → `/time-logs?status=SUBMITTED` → swipe **approve/reject**.
- `(app)/projects/index` + `[projectId]` → project list + summary w/ live margin → `/projects/:id/summary`.
- `(app)/company/providers` → my subcontractors → `/providers` → add provider (gated).
- `(app)/settings` → profile, plan/usage, sign out → `/me`, `/entitlements`.

Notifications: push on submit / approve / reject. Resilient offline draft capture is decided and implemented in Phase 13.

---

## 9. Web app (Vercel) — operations and administration workspace

Next.js (App Router). This is the full workspace for project operations, commercial control, clients, reporting and administration. It shares `packages/shared` + `packages/api-client` with mobile—**no business logic duplicated.** Auth via httpOnly cookies (SSR-friendly).

**Areas:** Auth pages · Dashboard · **Rate cards & templates** (the big tables) · Projects + assignments + summaries · Time/expense review at scale · **Client portal** (line items, notes, audit trail, exports) · **Invoices** · Reports · Company & members admin · **Super-admin console** (§5B) · **Public marketing + legal pages** (pricing, terms, privacy, refunds) for MoR verification · every project workspace section in §20.

### 9.1 Unified v2 application foundation

`apps/web` currently contains a small set of prototype screens, while the API already implements several useful capabilities. Neither determines the final app. Phase 5 turns the unified product model into a new navigation system, workspace shell and end-to-end experience. Existing endpoints may accelerate the work, but they may be combined, changed or replaced to support the intended workflows.

The table is a **capability inventory**, not a parity checklist or a prescribed set of screens:

| Product area | Available backend capability | Experience to design |
|---|---|---|
| Auth & context | `/v1/auth/*`, `/v1/me/*`, `/v1/companies/:id` | register, forgot/reset password, verify email, company switcher, profile *(company name + currency done: `/settings`)* |
| Entitlements | `/v1/entitlements` | plan + live usage display, limit-reached states |
| Engagements | `/v1/engagements` | list (both sides of the edge), create, pause/end |
| Providers & clients | `/v1/providers`, `/v1/clients` | list, add provider (placeholder + invite), add portal client |
| Members & invites | `/v1/members`, `/v1/members/invite`, `/v1/invites/:token` | member list, invite flow, **public invite-accept page** |
| Projects | `/v1/projects`, `/v1/projects/:id/summary`, `/assignments` | list, detail, create/edit, assign provider, summary with margin |
| Time & expenses | `/v1/time-logs`, `/v1/expenses`, `/v1/project-submissions` | entry, **bulk review/approve at scale** (the thing a phone is bad at), reject with reason |
| Client portal | `/v1/portal/*`, `/v1/line-item-notes` | client-side project list + detail, line items, notes thread |
| Audit | `/v1/audit-logs`, `/v1/audit-settings` | trail viewer, per-engagement visibility settings |
| Super-admin | `/v1/admin/*` | plans/prices/features/limits CRUD, companies + overrides |

**Bulk review at scale is a defining web workflow:** approving 200 time logs across 12 providers needs filters, grouping, exception handling and multi-select. Its acceptance test is that the job is fast and safe—not that every existing endpoint has acquired a page.

---

## 10. Infrastructure & environments

- **Render:** `render.yaml` (repo root — Render reads it nowhere else) declares the API web service + Postgres + Redis (Phase 2+). Auto-deploy from `main`.
- **Vercel:** web app; preview deploy per PR.
- **EAS:** mobile dev-client + store builds + OTA channels (`preview`, `production`).
- **Environments:** `local` (docker-compose Postgres in `infra/`) → `staging` → `production`.
- **Migrations:** `infra/migrations/run.ts` — a forward-only, numbered plain-SQL runner (`NNNN_name.sql`), applied in order, tracked in a `schema_migrations` table. `pnpm db:migrate` / `pnpm db:seed`.
- **Secrets (env):** `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `GOOGLE_CLIENT_ID`, `RESEND_API_KEY`, `R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET`, `MOR_API_KEY`/`MOR_WEBHOOK_SECRET`, `SENTRY_DSN`, `APP_BASE_URL`, `API_BASE_URL`. Client-side: `EXPO_PUBLIC_API_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`. Never commit secrets.
- **Observability:** Sentry across all three apps; structured request logging; `/healthz` (DB ping).

---

## 11. Delivery roadmap (phased, shippable — do not batch)

**Phase 0 — Foundations.** Monorepo, turbo, pnpm workspaces. `apps/api` hello-world on Render + Postgres + migration runner + `/healthz`. `packages/shared` first Zod schemas. CI (lint, type-check, test). docker-compose Postgres for local.

**Phase 1 — Identity, tenancy & entitlements.** `users`, `companies`, `memberships`, `refresh_tokens`. Auth (register/login/google/refresh/logout, reset). Auth-context middleware + `authorization/policies.ts` + tests. `/me/*`. **Entitlements engine** (`features`/`limits`/`plans`/…, `resolveEntitlements`, `hasFeature`/`withinLimit`) + super-admin plan CRUD, seeded with §5B defaults. Minimal Expo login + company switcher. *Milestone: log in, pick a company, gates read from configurable plans.*

**Phase 2 — Rate engine + catalog.** Implement the validated rate rules in `packages/shared` with full Vitest coverage. `role_catalog`, `rate_card_templates`, `rate_cards` (PAY/BILL, no per-card currency), holiday timeframes, `/v1/rates/resolve`. Web tools to manage them. *Milestone: rates resolve for a date+shift with correct margins.*

**Phase 3 — Delivery loop domain.** `engagements`, `providers`, `projects`, `project_assignments`, `invites` (create provider + accept). `time_logs` + `expenses` with `DRAFT→SUBMITTED→APPROVED/REJECTED`. Prototype mobile flows prove log time → submit → approve; `/projects/:id/summary` proves the commercial result. *Milestone: the product's central delivery transaction works end to end.*

**Phase 4 — Client collaboration, exports + audit domain.** Client-side project access via engagements + `projects.client_visible`; `line_item_notes`, `audit_logs` (+ nightly `expires_at` cleanup job), `audit_settings`. Server-side PDF/XLSX exports. Placeholder→linked company **merge flow**. *Milestone: the client boundary, audit visibility and export calculations work end to end.* **Backend complete 2026-08-17**; the actual client experience is designed with the unified app in Phase 5, and snapshot-based client reports arrive in Phase 10.

**Phase 5 — Unified v2 web application.** Design and build the new information architecture, navigation, workspace shell and complete core workflows described in §9.1: onboarding, company context, dashboard, projects, counterparties, members, time and expense review, rate management, client collaboration, audit and administration. Existing screens may be replaced. *Milestone: a user can run the v2 core lifecycle through one coherent web product, with every empty/loading/error/locked/forbidden state designed.*

**Phase 6 — Commercial readiness.** `invoices`/`invoice_items`; Merchant-of-Record checkout, webhooks, trial→paid and entitlement snapshots; subscription management; push + email notifications; public marketing, pricing and legal pages; production observability and launch operations. *Milestone: a company can discover, subscribe to and operate the product without manual platform intervention.*

> **Phases 5–13 are detailed in §42.** They are all v2: the new web application, commercial readiness, evidence, site diary, assets and materials, sustainability, reporting, variations, scheduling, compliance and the complete mobile field experience. Phase boundaries control delivery risk; they do not divide the product into separate scopes.

---

## 12. Relationship to v1

v2 is a **new Firebase-free product** with its own database, auth, information architecture and applications. v1 may run untouched during development. There is **no live coupling**: no shared tokens, dual-writes, synchronization or compatibility layer. Production-data import is not in this plan; if it is ever commissioned, it gets a separate onboarding specification and cannot reshape the v2 product model.

---

## 13. Testing strategy

- **`packages/shared` (rate engine):** exhaustive Vitest unit tests — pin every branch before any UI depends on it.
- **API:** integration tests against a throwaway Postgres (Vitest + testcontainers, or a scratch Render DB). Authorization tests cover every v2 role, capability, company edge and client-visibility boundary. v1 rules may reveal cases worth testing, but parity is not the assertion.
- **Mobile/web:** component tests for core flows + E2E happy-paths (Playwright web, Maestro mobile) for login → log time → approve.
- **CI gate:** lint + type-check + unit + API integration on every PR; block merge on failure.

---

## 14. Key risks & mitigations

| Risk | Mitigation |
|---|---|
| Existing code quietly dictates the new product | Review every workflow against this unified specification; treat prototypes as replaceable and accept work by user outcome. |
| Rate-engine regressions | Keep the engine pure and pin every approved branch before building on it. |
| Authorization gaps | One policy module; explicit allow/deny tests for every role, capability, company edge and client boundary. |
| One-hop leak (a company sees past its edge) | Central engagement-scope check; explicit deny tests at depth ≥ 2. |
| `activeCompany` context bugs (v1's pain) | `memberships` rows + per-request context; nothing to go stale. |
| MoR payout/verification friction | Confirm PH payout method up front; keep Paddle as fallback to Lemon Squeezy. |
| Two apps during transition | v1 frozen (bug-fix only); no feature work on v1. |

---

## 15. Domain-model decisions

The unified model makes these choices: (a) clients, contractors and subcontractors are `companies` connected by `engagements`, not separate party systems; (b) `time_logs`/`expenses`/`invoices` carry `engagement_id` and company-graph foreign keys; (c) rate cards inherit company currency; (d) subscription entitlements and `operates_downstream` are separate from OWNER/ADMIN/MANAGER/MEMBER permissions; (e) this file is self-contained and does not require v1 context to implement the product.

---

## 16. Decisions (locked)

1. **DB code:** raw `pg`; adopt Drizzle later only if queries get painful.
2. **App ↔ server:** REST + Zod.
3. **File storage:** Cloudflare R2.
4. **Login:** email/password + Google sign-in.
5. **Currency:** one per company; rate cards inherit. Default **USD**, changeable via `PATCH /v1/companies/:id` (OWNER/ADMIN) — migration 0006, 2026-08-17. `DEFAULT_CURRENCY` in `packages/shared/src/me.ts` is the only place the default lives in code.
6. **Repo:** new `crewquo-v2`.
7. **Parties are a company graph** (`companies` + `engagements`); client/subcontractor are relative, reversible; no separate client/sub tables.
8. **One-hop visibility;** operate-downstream is a paid capability.
9. **Plans are super-admin-configurable data** (entitlements engine); metering axis = active subcontractors; portal is a feature gate.
10. **Billing via Merchant-of-Record** (Gumroad, decided 2026-08-17; Lemon Squeezy/Paddle were the earlier candidates); hard-cap tiers.
11. **Membership roles:** OWNER/ADMIN/MANAGER/MEMBER; positions (client/provider) come from engagements.

### Whole-product decisions

12. **One coherent system.** No parallel project model, second auth system, duplicate storage layer, alternate calculator or separate “sustainability app.” All capabilities share the project, company graph, authorization, entitlement, audit and file foundations defined here.
13. **Job functions are a capability layer over the existing four roles, not new roles** (§37). Project Manager / Supervisor / Worker / Finance / Sustainability are *bundles of capability keys* granted per membership. `memberships.role` keeps its current meaning and current behaviour. **Client stays an engagement position**, never a user role — decision #7 is unchanged.
14. **Physical units:** mass in **kilograms** (`numeric(14,3)`), distance in **kilometres** (`numeric(12,3)`), energy in **kWh**, emissions in **kgCO₂e** (`numeric(18,6)`). Stored at full precision, rounded only for display. Whatever unit the user typed is stored alongside the converted value.
15. **The carbon engine is to sustainability what the rate engine is to costing** — versioned reference data in the database, pure resolution/calculation functions in `packages/shared/src/carbon-engine/`, a frozen snapshot written at the moment of calculation. Same architecture, same testing bar (§26, §27).
16. **No emission factor is ever hard-coded.** Factors arrive by import into `emission_factor_sets`; the seed ships the importer and the schema, never invented numbers (§26).
17. **Avoided emissions are a separate table, separate bucket, separate headline figure** — there is no code path that nets them against Scope 1/2/3 (§27.3, §41).
18. **Storage is not an outcome.** An asset in storage stays `PENDING` and is excluded from reuse/recycling/diversion numerators *and* denominators until a final destination is recorded (§25.4).
19. **Every generated report stores a reproducible snapshot** of its numbers, factor-set versions and source record ids, plus the rendered file. Re-rendering reads the snapshot; it never recalculates (§29.4).
20. **Waste-hierarchy and destination semantics are configurable data, not code** — the `destination_types` table carries the tier and the counts-as flags, so an org can see and adjust its own assumptions (§25.4, §39).
21. **Web-led delivery order.** Shared domain capabilities are proven through the web workspace before the complete mobile field experience is built in Phase 13. This is sequencing, not product hierarchy: mobile is first-class, receives its own interaction design, and is accepted against field jobs rather than against web screens. Existing prototype screens may be replaced.

---

## 17. Open items (ask the user before building the affected phase)

- **Exact seed pricing per currency** — §5B has USD anchors; confirm real numbers + which currencies to localize (affects `plan_prices`, Phase 6).
- **MoR payout method** — confirm the PH payout route and Gumroad's subscription-webhook coverage before building against it (Phase 6).
- **Per-rate-card currency** — company-level currency can't express "pay crew in PHP, bill a US client in USD"; mixing currencies inside one company makes `calculateMargin` subtract different units. Decide before multi-currency clients are real.
- The domain-specific open items for evidence, carbon, offline capture and reports are listed in §45.

---

## 18. Where the build stands (2026-08-17)

`PROGRESS.md` is the living checklist; this is the one-paragraph version.

**Implemented:** the monorepo and database-change runner (Phase 0); users/companies/memberships, JWT + Google auth, the authorization policy module, and the super-admin-configurable entitlements engine (Phase 1); the rate engine in `packages/shared` with 37 pinned branches, the rate-card catalog and `/v1/rates/resolve` plus prototype web tools (Phase 2); engagements, providers/clients/invites with placeholder auto-merge, projects and assignments, the `DRAFT→SUBMITTED→APPROVED/REJECTED` work loop with a frozen PAY snapshot, project summaries with BILL/margin, and Expo push (Phase 3); the append-only audit trail with retention, per-engagement portal settings, client project reads, line-item notes and owner exports (Phase 4 domain/backend).

**Completed implementation work:** Phase 4's server-side PDF/XLSX **export engine**; the `FRI_SAT_NIGHT` label rule moved out of code into per-company `rate_card_templates` data (database change 0007, with a behaviour-preserving backfill); the `USD` currency default plus a settings endpoint to change it (database change 0006).

**The web workspace is built (Phase 5, 2026-08-17):** two route groups behind one auth provider, and every workflow reachable — auth and profile, plan and usage, engagements, providers and clients, members (invite, re-role, suspend, remove), projects with server-computed margin, work entry and bulk approval at scale, the client portal, the audit viewer, and the super-admin console over both plans and individual companies. `apps/mobile` remains a prototype proving parts of the core loop; Phase 13 designs the field product.

**Next: Phase 6 — commercial readiness** (§42), then the remaining operational capabilities. Phase 13 completes the purpose-built mobile field experience.

**Verification.** `pnpm --filter @crewquo/api verify:e2e` runs 163 live-Postgres checks over currency, label rules, the Phase 3/4 core-loop numbers (PAY 40000 / BILL 65550 / margin 24000 / 36.61%), the export engine (including the XLSX's own cells against `/summary`), malformed-identifier handling, both migration backfills, the portal's PAY-exclusion, the placeholder/meter rules, the super-admin console and member management. `pnpm --filter @crewquo/web test:e2e` runs 17 browser tests over the same loop through the real UI. Re-run both green at the end of every phase.

---

## 19. Complete product definition

### 19.1 The whole project lifecycle

CrewQuo v2 follows a job through its whole life. Crew costing is the commercial spine, while field delivery, evidence, assets, material outcomes, sustainability and client reporting are part of the same product:

```
Plan → Crew → Work → Evidence → Assets → Waste/Reuse → Costs → Sustainability → Client Report
```

Every stage uses the same projects, engagements, people, permissions and audit history. Evidence and sustainability are not a second product bolted onto a costing app.

### 19.2 Who it is for

Businesses running crews, subcontractors, assets and materials across commercial sites: office clearance · office relocation · commercial removals · furniture installation · furniture refurbishment · commercial fit-out · facilities management · IT decommissioning / ITAD · waste and recycling contractors · reuse organisations · property maintenance · and other subcontractor-heavy field operations.

What they share: the client increasingly wants proof — photographic evidence of the work, a defensible record of where every item went, and a carbon and diversion-from-landfill report they can put in their own ESG return. Today that is assembled by hand from phone photos, weighbridge tickets and spreadsheets. CrewQuo generates it from the data the crew already captured.

### 19.3 Shared foundations

| Foundation | How the complete product uses it |
|---|---|
| `companies` + `engagements` (§3.1–3.2) | Destination organisations, subcontractor compliance and client-level reporting all ride the same company graph. Reuse recipients that are also CrewQuo customers are just companies. |
| `projects` (§3.4) | Gains locations, evidence, diary, assets, activities, variations, budgets, sign-off. The table itself gains only a small number of nullable columns. |
| `time_logs` / `expenses` workflow (§3.4) | The `DRAFT→SUBMITTED→APPROVED/REJECTED` shape is reused verbatim for variations. The supervisor mobile screen (§32) is a new front end over the *same* endpoints. |
| Rate engine (`packages/shared/src/rate-engine/`, §6) | The model for the carbon engine (§26). Also supplies labour cost to planned-vs-actual (§30) and to variation pricing. |
| `computeProjectSummary` + `projects/billing.ts` | Extended in place with variation revenue and actuals — **not** duplicated by a second calculator, which is why the summary and the portal cannot disagree today. |
| `policies.ts` (§4) | Gains the capability checks (§37). One-hop visibility and the PAY/BILL guard apply unchanged to every new resource. |
| `audit_logs` + `recordAudit` (§3.6) | Every new mutation records to it. §36 adds a `record_revisions` table for before/after values on the records that need them. |
| Entitlements engine (§5B) | New feature and limit keys gate the new modules (§43). No new gating mechanism. |
| Invites, portal, notes (§3.6) | Client sign-off and client-visible evidence reuse the portal surface and its `client_visible` discipline. |

### 19.4 Product-boundary non-goals

- **Not a certified carbon accounting platform.** CrewQuo calculates and discloses; it does not verify. §27.5 and §41 govern what may and may not be claimed.
- **No bundled emission factor dataset** until redistribution terms are confirmed (§45).
- **No item-level tracking requirement.** Bulk lines are the default; item-level is opt-in per line (§25.2).
- **Offline capture is a deliberate Phase 13 decision**, not an assumption hidden inside early web work. It matters because supervisors work in basements and loading bays (§45).
- **Not a replacement for a client's own ESG reporting system.** CrewQuo produces a project/client report and the underlying data; integration/export to third-party ESG platforms is later.

---

## 20. Project structure & navigation

Every project opens into a fixed set of sections. This is the information architecture for both `apps/web` and (in reduced form) `apps/mobile`.

| Section | Contents | Spec |
|---|---|---|
| **Overview** | Status, client, site, dates, PM/supervisor, headline commercial + sustainability figures, recent activity | §20, §30, §28 |
| **Schedule** | Assigned crew, subcontractors, vehicles by day/week | §31 |
| **Crew** | Who is assigned, roles, supervisors, compliance flags | §31, §33 |
| **Time & Costs** | Time logs, approvals, labour cost, planned vs actual | §3.4, §30 |
| **Expenses** | Expense lines + receipts | §3.4 |
| **Site Diary** | Daily entries, open/closed | §23 |
| **Photos & Evidence** | Gallery / timeline / filters / report selection | §22 |
| **Assets & Materials** | Asset lines, weights, destinations, movements | §25 |
| **Sustainability** | Mass balance, rates, emissions, avoided, data quality | §28 |
| **Variations** | Extra works, pricing, approval | §30 |
| **Documents** | RAMS, WTNs, certificates, POs, drawings | §24 |
| **Client Sign-Off** | Signature capture, completion statement, history | §34 |
| **Reports** | Generate sustainability report / evidence pack, past reports | §29 |

A **Timeline** view (§35) cuts across all of them chronologically.

**Layout rule.** These are sections of one record, not thirteen dashboards. Do not wrap each in an oversized card. Use a persistent left section rail (web) with a dense header strip carrying the project identity and 4–6 key figures, and put filters and detail in side panels rather than nested cards. §40 is binding here.

**Progressive disclosure.** A project that has no assets, no diary and no evidence must not show twelve empty sections shouting for attention: sections with no data and no entitlement collapse to a single "not used on this project" line, and the section rail marks which sections have content.

---

## 21. Project locations

A commercial job is rarely one place. Locations are a per-project tree — floors within a building, zones within a warehouse — and they are the spatial key that evidence, assets, diary entries and schedule assignments hang off.

```sql
create table project_locations (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  parent_id  uuid references project_locations(id) on delete cascade,   -- nullable: top level
  kind  text not null check (kind in
          ('BUILDING','FLOOR','ROOM','DEPARTMENT','WAREHOUSE_ZONE','LOADING_BAY','SITE_AREA','OTHER')),
  name       text not null,          -- "Floor 3", "Loading Bay", "Storage Area"
  reference  text,                   -- client's own room/zone code
  notes      text,
  sort_order int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on project_locations (project_id, parent_id);
```

Example — *PwC London*: `Floor 1`, `Floor 2`, `Floor 3`, `Loading Bay`, `Storage Area`, with rooms nested under floors.

- **Depth is capped at 4** and cycles are rejected in the API (a parent must belong to the same project and must not be a descendant).
- Deleting a location with children or references is refused; `active = false` retires it while preserving history.
- Locations are optional everywhere. A single-area job never has to create one.
- **Templates:** a company may save a location tree (e.g. "5-floor office") and apply it to a new project — a `POST /v1/projects/:id/locations/apply-template` over `company.settings`-stored trees. Deferred to Phase 7b if time is short.

---

## 22. Project evidence (photos & files)

Not an image gallery — an evidence record. The value is in the metadata, because that is what makes a photo usable in a report and defensible in a dispute.

### 22.1 Storage layer (build first — Phase 7.0)

Cloudflare R2 is already the decided store (§2) but nothing uses it yet (expense receipt upload is still deferred). Phase 7 opens by building the storage service the whole expansion depends on.

```sql
create table stored_files (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  project_id    uuid references projects(id) on delete cascade,   -- nullable: company-level files
  bucket_key    text not null unique,
  original_filename text not null,
  content_type  text not null,
  byte_size     bigint not null,
  checksum_sha256 text,
  kind    text not null check (kind in ('IMAGE','DOCUMENT','SIGNATURE','EXPORT')),
  variant text not null default 'ORIGINAL' check (variant in ('ORIGINAL','WEB','THUMB')),
  derivative_of uuid references stored_files(id),      -- WEB/THUMB point at their ORIGINAL
  status  text not null default 'PENDING'
            check (status in ('PENDING','READY','FAILED','DELETED')),
  uploaded_by_user_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on stored_files (company_id, created_at desc);
create index on stored_files (project_id) where project_id is not null;
```

- **Key layout:** `co/{companyId}/proj/{projectId}/{kind}/{fileId}/{variant}.{ext}`. Company-scoped prefixes make per-tenant deletion and usage metering a prefix operation.
- **Upload flow:** `POST /v1/files/presign` (validates content type, size, entitlement `storage_gb`, returns a presigned PUT + a `PENDING` row) → client PUTs to R2 → `POST /v1/files/:id/complete` (verifies size/checksum, flips to `READY`, enqueues derivatives). Bytes never pass through the API.
- **Derivatives:** the API generates a `WEB` variant (long edge ~2000px, quality tuned for print at report size) and a `THUMB` (long edge 400px) with `sharp`, in an in-process job queue. **The `ORIGINAL` is retained** — a compressed-only pipeline destroys the one thing that makes a photo evidence. Originals may be lifecycle-tiered later; that is an R2 policy, not an app decision.
- **Client-side pre-compression** is applied *only* above a size threshold (mobile: `expo-image-manipulator`; web: canvas), and never below the quality the `WEB` variant would produce anyway.
- **Access:** downloads are served via short-lived presigned GETs minted by the API after the same authorization check as the owning record. R2 is never public.
- **Validation:** content type sniffed server-side on complete, not trusted from the client. Max sizes per kind. Rejected uploads are marked `FAILED` and their keys swept.

### 22.2 Evidence records

```sql
create table project_evidence (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  company_id uuid not null references companies(id),        -- the uploader's active company
  file_id       uuid not null references stored_files(id),  -- ORIGINAL
  web_file_id   uuid references stored_files(id),
  thumb_file_id uuid references stored_files(id),
  category text not null check (category in
    ('BEFORE','DURING','AFTER','COLLECTION','DELIVERY','INSTALLATION','REUSE','DONATION',
     'RECYCLING','WASTE','DAMAGE','INCIDENT','ASSET','OTHER')),
  caption text,
  notes   text,
  evidence_date date,                    -- the PROJECT date it depicts
  captured_at   timestamptz,             -- EXIF DateTimeOriginal when present
  location_id    uuid references project_locations(id),
  asset_id       uuid references project_assets(id) on delete set null,
  diary_entry_id uuid references site_diary_entries(id) on delete set null,
  variation_id   uuid references variations(id) on delete set null,
  incident_id    uuid references project_incidents(id) on delete set null,
  asset_movement_id uuid references asset_movements(id) on delete set null,
  gps_lat numeric(9,6), gps_lng numeric(9,6), gps_accuracy_m numeric(8,2),
  client_visible boolean not null default false,
  sort_order int not null default 0,
  uploaded_by_user_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on project_evidence (project_id, evidence_date desc, created_at desc);
create index on project_evidence (project_id, category);
create index on project_evidence (asset_id) where asset_id is not null;
```

> **Migration ordering note.** `project_evidence` references tables defined later in this document. The migration creates tables in dependency order and adds the back-references with `alter table … add constraint` at the end of the file. Same for the other cross-linked pairs.

**Three timestamps, deliberately.** `created_at` is when it was uploaded, `captured_at` is when the camera says the shutter fired, `evidence_date` is the project day it belongs to — a supervisor uploading Friday's photos on Monday sets `evidence_date` to Friday. Reports order by `evidence_date`; disputes rely on `created_at` and `captured_at`. Never conflate them.

### 22.3 Capture & upload

- **Multi-select and batch upload**, with per-file progress and resumable individual failures — a partial batch must not lose the successful files.
- **Direct camera capture on mobile**, with the current project, today's date and (if the supervisor is working in one) the current location pre-filled.
- **Drag-and-drop on desktop**, including folder drops.
- **Batch metadata:** category, date, location, caption and client-visible flag can be applied to a whole selection at once, then overridden per photo. Tagging 40 photos individually is the failure mode that kills evidence capture.
- **GPS is optional and org-configurable** (§39). Where enabled, coordinates come from the device at capture, not from EXIF alone.
- **Non-image evidence** (a short video, a PDF scan) is accepted and stored; the gallery shows a type badge instead of a thumbnail. Video transcoding is out of scope — store and link only.

### 22.4 Views

Gallery (dense grid, no cards), chronological timeline grouped by `evidence_date`, and a table view for bulk metadata editing. Filters: category · date range · uploader · location · asset · client-visible · "in report". Selection is sticky across filter changes so a user can build a report set from several passes, and the selection is what §29 consumes.

---

## 23. Site diary

A per-project, per-day record of what actually happened. It is the narrative backbone of the evidence pack and the first thing anyone reaches for in a dispute.

```sql
create table site_diary_entries (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  company_id uuid not null references companies(id),      -- author's company (provider or owner)
  entry_date date not null,
  start_time time, finish_time time,
  supervisor_user_id uuid references users(id),
  work_completed      text,
  areas_completed     text,
  activities          text,
  delays              text,
  client_instructions text,
  issues              text,
  deliveries          text,
  collections         text,
  vehicle_movements   text,
  waste_movements     text,
  hs_notes            text,          -- health & safety
  weather             text,
  notes               text,
  workers_present_count       int,   -- denormalized from attendance for quick display
  subcontractors_present_count int,
  status text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  closed_by_user_id uuid references users(id),
  closed_at timestamptz,
  created_by_user_id uuid not null references users(id),
  updated_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, company_id, entry_date)
);
create index on site_diary_entries (project_id, entry_date desc);

-- Structured attendance, so the diary agrees with the schedule and the timesheets.
create table site_diary_attendance (
  id uuid primary key default gen_random_uuid(),
  diary_entry_id uuid not null references site_diary_entries(id) on delete cascade,
  user_id             uuid references users(id),            -- an employee
  provider_company_id uuid references companies(id),         -- a subcontractor's crew
  name    text,                                              -- free text when neither is known
  role_id uuid references role_catalog(id),
  headcount numeric(6,2) not null default 1,
  hours     numeric(6,2),
  time_log_id uuid references time_logs(id),                 -- links the diary to the timesheet
  created_at timestamptz not null default now()
);

create table site_diary_locations (
  diary_entry_id uuid not null references site_diary_entries(id) on delete cascade,
  location_id    uuid not null references project_locations(id) on delete cascade,
  primary key (diary_entry_id, location_id)
);
```

**Behaviour**

- **One entry per project per day per company.** A subcontractor keeps its own diary for the same day; the owner sees both on the project (subject to the one-hop rule), each attributed.
- **Multiple updates during the day.** The entry is a live document while `OPEN`; edits do not create noise in the audit trail beyond a normal update record.
- **Close Day** is a supervisor action (`diary.close` capability). It stamps `closed_by`/`closed_at` and freezes the entry.
- **After close, edits are still possible but never silent.** Every post-close change writes a `record_revisions` row with before/after and a required reason, and the entry displays "amended N times — view history" wherever it appears, including in reports. This is the §30/§36 auditability requirement in its most-used form.
- **Photos and documents attach** via `project_evidence.diary_entry_id` and a `site_diary_documents` join.
- **Prefill:** opening today's entry pre-populates attendance from the schedule (§31) and approved/submitted time logs, and lists the day's asset movements, evidence uploads and expenses so the supervisor confirms rather than retypes.

---

## 24. Project documents

Files with a category, a version and (where it matters) an expiry.

```sql
create table project_documents (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  company_id uuid not null references companies(id),
  file_id    uuid not null references stored_files(id),
  category text not null check (category in
    ('RAMS','RISK_ASSESSMENT','METHOD_STATEMENT','INSURANCE','PURCHASE_ORDER','DRAWING',
     'SITE_INSTRUCTION','WASTE_TRANSFER_NOTE','WEIGHBRIDGE_TICKET','RECYCLING_CERTIFICATE',
     'DONATION_RECEIPT','DELIVERY_NOTE','COLLECTION_NOTE','CLIENT_SIGNOFF','INCIDENT','OTHER')),
  title     text not null,
  reference text,                                   -- WTN number, PO number, ticket number
  version   int not null default 1,
  supersedes_id uuid references project_documents(id),
  issued_on  date,
  expires_on date,
  provider_company_id uuid references companies(id), -- the subcontractor it belongs to, if any
  location_id uuid references project_locations(id),
  client_visible boolean not null default false,
  notes text,
  uploaded_by_user_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on project_documents (project_id, category);
create index on project_documents (expires_on) where expires_on is not null;
```

Uploading a new version links `supersedes_id` and hides the old one by default without deleting it. Waste transfer notes, weighbridge tickets, recycling certificates and donation receipts are the documents that back weights (§25.3) and destinations (§25.4) — those links are what turn an estimate into a *documented* figure, so the asset and movement records point at document rows directly.

---

## 25. Assets & materials

The heart of the expansion. Everything in §26–§29 is downstream of getting this record right.

### 25.1 Asset types

```sql
create table asset_types (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,   -- null = system catalog
  code text not null,
  name text not null,
  category text not null check (category in
    ('FURNITURE','IT','WEEE','APPLIANCE','TIMBER','METAL','PLASTIC','CARDBOARD',
     'MIXED_WASTE','TEXTILE','GLASS','OTHER')),
  default_unit_weight_kg numeric(14,3),        -- a starting estimate, always overridable
  default_material_composition jsonb,          -- [{ "material": "STEEL", "pct": 62 }, ...]
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index on asset_types (company_id, code) where company_id is not null;
create unique index on asset_types (code) where company_id is null;
```

Seeded system types: Operator Chair · Meeting Chair · Desk · Bench Desk · Pedestal · Cabinet · Locker · Table · Sofa · Monitor · Computer · Printer · Server · Networking Equipment · Appliance · Timber · Metal · Plastic · Cardboard · Mixed Waste · WEEE · Other. Companies add their own; a company row with the same `code` shadows the system one.

> `default_unit_weight_kg` on system types ships **empty**. A shipped default weight is an invented number that silently becomes a reported tonne — see §41.1. Orgs populate their own defaults from their own weighing, and anything derived from a default is flagged `SYSTEM_ESTIMATE`.

### 25.2 Asset lines

```sql
create table project_assets (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  company_id uuid not null references companies(id),
  asset_type_id uuid not null references asset_types(id),
  tracking_mode text not null default 'BULK' check (tracking_mode in ('BULK','ITEM')),
  description text,
  quantity    numeric(12,2) not null default 1,

  -- Weight (§25.3)
  weight_basis     text check (weight_basis in ('UNIT','TOTAL')),
  unit_weight_kg   numeric(14,3),
  total_weight_kg  numeric(14,3),
  weight_source    text check (weight_source in
     ('WEIGHED','WEIGHBRIDGE','TRANSFER_NOTE','SUPPLIER_DOC','PRODUCT_SPEC',
      'USER_ESTIMATE','SYSTEM_ESTIMATE')),
  weight_confidence text check (weight_confidence in
     ('VERIFIED','DOCUMENTED','ESTIMATED','APPROXIMATE')),
  weight_is_estimated boolean not null default true,
  weight_document_id  uuid references project_documents(id),

  -- Identity (mostly for ITEM mode / ITAD)
  manufacturer text, model text, serial_number text, asset_tag text,
  material_composition jsonb,
  condition text check (condition in ('NEW','GOOD','FAIR','POOR','DAMAGED','SCRAP')),

  origin_location_id uuid references project_locations(id),
  outcome_state text not null default 'PENDING'
                  check (outcome_state in ('PENDING','PARTIAL','IN_STORAGE','FINAL')),
  notes text,
  created_by_user_id uuid not null references users(id),
  updated_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on project_assets (project_id);
create index on project_assets (project_id, outcome_state);
create unique index on project_assets (company_id, serial_number)
  where serial_number is not null and tracking_mode = 'ITEM';
```

**Bulk is the default.** The common entry is one line:

```
42 × Operator Chair · unit weight 16.5 kg · total 693 kg
```

Nobody registers 42 chairs individually. `tracking_mode = 'ITEM'` opts a line into per-unit rows (quantity 1, serial/asset tag required) for ITAD and high-value items where the client needs a certificate per serial number.

**Weight entry:** the user enters *either* a unit weight or a total; `weight_basis` records which one they typed and the other is derived at write time. Editing quantity recomputes the derived side, never the entered side. A line with neither weight is valid — it just contributes nothing to mass metrics and drags down data completeness (§28.3), which is the correct incentive.

### 25.3 Weight provenance

Every weight carries where it came from and how much to trust it. Mass-based sustainability reporting is worthless without this, and it is what lets a report say "8.9 t recycled, of which 7.4 t is documented".

| `weight_source` | Meaning | Default `weight_confidence` |
|---|---|---|
| `WEIGHED` | Actually weighed on site | `VERIFIED` |
| `WEIGHBRIDGE` | Weighbridge ticket attached | `VERIFIED` |
| `TRANSFER_NOTE` | From the waste transfer note | `DOCUMENTED` |
| `SUPPLIER_DOC` | From a supplier/facility document | `DOCUMENTED` |
| `PRODUCT_SPEC` | Known manufacturer product weight | `DOCUMENTED` |
| `USER_ESTIMATE` | Someone on site estimated it | `ESTIMATED` |
| `SYSTEM_ESTIMATE` | Derived from an asset-type default | `APPROXIMATE` |

Defaults are suggestions, overridable downward but not upward: **`VERIFIED` and `DOCUMENTED` require an attached document** (`weight_document_id`) unless the source is `WEIGHED` with a recorded weigher. `weight_is_estimated` is derived (`ESTIMATED`/`APPROXIMATE` ⇒ true) and denormalized for fast filtering. Every change to a weight writes a `record_revisions` row (§36).

Display: `< 1000 kg` shows kg to 1dp, `≥ 1000 kg` shows tonnes to 2dp, unless the org pins a unit in §39. Stored value is always kg at full precision.

### 25.4 Destinations, the waste hierarchy, and movements

**Destination types are data.** The eleven lifecycle destinations, their hierarchy tier and what they count as, live in a table an admin can inspect — not in a `switch` statement.

```sql
create table destination_types (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,   -- null = system seed
  code text not null,
  name text not null,
  hierarchy_tier int not null check (hierarchy_tier between 1 and 5),   -- §25.5
  counts_as_retained_in_use boolean not null default false,
  counts_as_reuse      boolean not null default false,
  counts_as_recycling  boolean not null default false,
  counts_as_recovery   boolean not null default false,
  counts_as_landfill   boolean not null default false,
  counts_as_diverted   boolean not null default false,
  is_final_outcome     boolean not null default true,
  displaces_replacement boolean not null default false,   -- eligible for avoided-emissions (§27.3)
  ghg_treatment_key text,        -- maps to emission_factors.treatment for Scope 3 Cat 5
  sort_order int not null default 0,
  active boolean not null default true
);
```

Seed:

| # | code | Tier | retained | reuse | recycling | recovery | landfill | diverted | final | displaces |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `RETAINED` (Retained by Client) | 1 | ✔ | | | | | ✔ | ✔ | — |
| 2 | `RELOCATED` (Relocated / Redeployed) | 1 | ✔ | | | | | ✔ | ✔ | ✔ |
| 3 | `REUSE` (Direct Reuse) | 2 | ✔ | ✔ | | | | ✔ | ✔ | ✔ |
| 4 | `REFURBISHMENT` | 2 | ✔ | ✔ | | | | ✔ | ✔ | ✔ |
| 5 | `DONATION` | 2 | ✔ | ✔ | | | | ✔ | ✔ | ✔ |
| 6 | `RESALE` | 2 | ✔ | ✔ | | | | ✔ | ✔ | ✔ |
| 7 | `STORAGE` | — | | | | | | | **✘** | — |
| 8 | `RECYCLING` | 3 | | | ✔ | | | ✔ | ✔ | — |
| 9 | `ENERGY_RECOVERY` | 4 | | | | ✔ | | ✔ | ✔ | — |
| 10 | `LANDFILL` | 5 | | | | | ✔ | | ✔ | — |
| 11 | `OTHER_DISPOSAL` | 5 | | | | | ✔ | | ✔ | — |

**Storage has no tier and is not a final outcome.** That single row is the mechanism behind locked decision #18: an asset sitting in a warehouse is not a sustainability result, and CrewQuo will not report it as one until someone records where it actually went.

**Destination organisations** — the charity, recycler, storage facility, reseller, waste contractor or other client site the material went to:

```sql
create table destination_organisations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  linked_company_id uuid references companies(id),    -- when the recipient is a CrewQuo company
  name text not null,
  kind text not null check (kind in
    ('CHARITY','REUSE_ORG','RECYCLER','STORAGE','RESELLER','WASTE_CONTRACTOR',
     'CLIENT_SITE','MANUFACTURER','OTHER')),
  address text, contact_name text, contact_email text, contact_phone text,
  licence_number text,          -- e.g. waste carrier / permit number
  licence_expires_on date,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

**Movements are the ledger.** An asset line does not have "a destination" — it has a chain of transfers, and 42 chairs can split 30 donated / 12 recycled.

```sql
create table asset_movements (
  id       uuid primary key default gen_random_uuid(),
  asset_id uuid not null references project_assets(id) on delete cascade,
  sequence int not null,
  destination_type_id uuid not null references destination_types(id),
  destination_org_id  uuid references destination_organisations(id),
  destination_address text,                       -- when not a saved organisation
  from_location_id uuid references project_locations(id),
  quantity  numeric(12,2) not null,
  weight_kg numeric(14,3),                        -- derived from the asset unless overridden
  moved_on  date not null,
  vehicle_id  uuid references vehicles(id),
  distance_km numeric(12,3),
  document_id uuid references project_documents(id),   -- WTN / weighbridge / donation receipt
  notes text,
  recorded_by_user_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (asset_id, sequence)
);
create index on asset_movements (asset_id);
```

Rules, enforced in the API and pinned by tests:

1. `sum(movements.quantity) <= project_assets.quantity`. The remainder is **pending** and is reported as such.
2. `outcome_state` is derived, never typed: `FINAL` when the full quantity has reached final-outcome destinations; `IN_STORAGE` when the latest movement is a non-final destination; `PARTIAL` when some quantity is allocated and some is not; `PENDING` when nothing is.
3. **Metrics aggregate movements with `is_final_outcome = true`**, not asset lines. A storage movement contributes to no rate; when the material later leaves storage a *second* movement records the real outcome and the numbers move then.
4. Movements are append-only in spirit: corrections are edits that write `record_revisions` rows, never silent overwrites (§36).

### 25.5 Waste hierarchy

`hierarchy_tier` implements the recognised hierarchy, best first:

1. **Prevention / Retention** — the item never becomes waste (retained, redeployed)
2. **Preparing for reuse / Reuse** — reuse, refurbishment, donation, resale
3. **Recycling**
4. **Other recovery** — energy recovery
5. **Disposal** — landfill, other disposal

Reuse ranks above recycling everywhere it is shown: sort order in tables, order of the mass-balance bars, order of the report sections. **Reuse and recycling are never merged into one "diverted" figure as if equivalent** — diversion is reported separately and explicitly as a different metric (§41.8).

---

## 26. Emission factor architecture

The versioned reference-data layer. Built the way the rate engine was built, for the same reason: the numbers belong to the customer and to a point in time, not to a release of our code.

### 26.1 Factor sets

```sql
create table emission_factor_sets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,   -- null = platform-wide set
  name text not null,                       -- "UK Government GHG Conversion Factors 2027"
  source_organisation text not null,        -- "UK Department for Energy Security and Net Zero"
  source_document text,
  source_url text,
  reporting_year int not null,
  version text not null,                    -- publisher's version, e.g. "v1.1"
  published_on date,
  valid_from date not null,
  valid_to   date,                          -- null = open-ended
  methodology text,
  region text not null default 'GB',
  active boolean not null default true,
  imported_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, name, version)
);

create table emission_factors (
  id uuid primary key default gen_random_uuid(),
  factor_set_id uuid not null references emission_factor_sets(id) on delete cascade,
  category  text not null,           -- "Freighting goods", "Waste disposal", "Fuels"
  activity  text not null,           -- "HGV (all diesel) — rigid, >7.5t–17t"
  material  text,                    -- for waste factors: "Wood", "Plasterboard"
  treatment text,                    -- "Landfill", "Closed-loop", "Combustion", "Re-use"
  vehicle_type text, fuel_type text,
  unit text not null,                -- 'km' | 'mile' | 'litre' | 'kWh' | 'tonne' | 'tonne.km'
  kg_co2e_per_unit numeric(18,9) not null,
  kg_co2_per_unit  numeric(18,9),
  kg_ch4_per_unit  numeric(18,9),
  kg_n2o_per_unit  numeric(18,9),
  wtt_kg_co2e_per_unit numeric(18,9),      -- well-to-tank, where the publisher separates it
  scope text check (scope in ('SCOPE_1','SCOPE_2','SCOPE_3','OUT_OF_SCOPE')),
  scope3_category int,                     -- 5 = waste generated in operations
  source_reference text,                   -- sheet/row in the published workbook
  notes text,
  created_at timestamptz not null default now()
);
create index on emission_factors (factor_set_id, category, activity);
create index on emission_factors (factor_set_id, material, treatment);
```

### 26.2 Sourcing

- **UK projects default to the applicable annual *UK Government Greenhouse Gas Conversion Factors for Company Reporting*** for activity-based emissions: company vehicles, vans, HGVs, fuel, mileage, electricity, transport, freight, waste treatment and other operational activity.
- **Factor sets are imported, not shipped.** Phase 9 delivers a CSV/XLSX importer (column mapping UI, dry-run diff, row-count and unit validation, an import report) plus admin CRUD — and **zero fabricated rows**. Bundling a dataset waits on confirmed redistribution terms (§45).
- **Selection is by the project's reporting year**, resolved against `valid_from`/`valid_to` and `region`, defaulting from §39. A newer factor set is never applied retrospectively to a project that has already been calculated and reported (§41.3).
- Multiple sets coexist. An org can hold 2025, 2026 and 2027 sets simultaneously, which is exactly what multi-year client reporting requires.

### 26.3 Product carbon factors (embodied carbon)

For reused furniture and IT, avoided-emissions maths needs the embodied carbon of the item that did *not* have to be manufactured. That is a different kind of number from an activity factor, so it gets its own admin-managed library.

```sql
create table product_carbon_factors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,   -- null = platform library
  item_category text not null,               -- maps to asset_types.category or a type code
  asset_type_id uuid references asset_types(id),
  manufacturer text, product_model text,
  kg_co2e_per_item numeric(18,6),
  kg_co2e_per_kg   numeric(18,6),
  lifecycle_boundary text not null check (lifecycle_boundary in
    ('A1_A3','A1_A5','CRADLE_TO_GATE','CRADLE_TO_GRAVE','OTHER')),
  source text not null, source_url text, publication_year int, region text,
  verification_status text not null check (verification_status in
    ('EPD_VERIFIED','MANUFACTURER','SECTOR_DATASET','ORG_SPECIFIC','GENERIC_ESTIMATE')),
  is_estimate boolean not null default true,
  notes text,
  active boolean not null default true,
  created_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (num_nonnulls(kg_co2e_per_item, kg_co2e_per_kg) = 1)
);
```

**Preferred source order**, and the resolver walks it in this order:

1. Product-specific verified EPD or manufacturer carbon data (`EPD_VERIFIED`, `MANUFACTURER`)
2. Recognised sector or lifecycle dataset (`SECTOR_DATASET`)
3. Approved organisation-specific factor (`ORG_SPECIFIC`)
4. Approved generic estimate (`GENERIC_ESTIMATE`) — **only** when `sustainability_settings.allow_generic_product_factors` is on, and always surfaced as an estimate in the report

**If no factor exists at any tier, no avoided-emissions figure is produced for that line.** The report says so, by name and quantity. Nothing is invented (§41.1).

### 26.4 Recycling & resource datasets

Admins may optionally maintain recognised lifecycle/resource treatment datasets (WRAP/Defra CarbonWARM-type) as an additional factor set with `category = 'RESOURCE_LIFECYCLE'`. Results from these are labelled **comparative lifecycle impact** and kept out of the formal Scope 1/2/3 inventory where the methodology requires separate reporting. The four labels are distinct everywhere and never mixed:

- **Project emissions** (Scope 1/2/3 inventory)
- **Waste treatment emissions** (Scope 3 Cat 5, part of the inventory)
- **Comparative lifecycle impact** (outside the inventory)
- **Avoided emissions** (outside the inventory)

---

## 27. Calculation service

### 27.1 Shape

`packages/shared/src/carbon-engine/` — pure functions over plain data, no DB imports, mirroring `rate-engine/`:

```
selectFactorSet(sets, { date, region, reportingYear })       → EmissionFactorSet | null
resolveFactor(factors, query)                                 → EmissionFactor | null
calculateActivityEmissions(activity, factor)                  → CarbonResult
calculateWasteTreatmentEmissions(movement, factor)            → CarbonResult
resolveProductFactor(factors, { assetType, manufacturer, model, allowGeneric })
calculateAvoidedEmissions(input)                              → AvoidedResult
rollUpProjectCarbon(results)                                  → { projectEmissions, avoided, byScope, byBucket }
computeDataQuality(inputs, weights)                           → { pct, components, warnings }
```

Every function returns the inputs it used alongside the result, so the caller can persist a complete trace. Nothing returns a bare number.

### 27.2 Persisted calculations

```sql
create table carbon_calculations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  company_id uuid not null references companies(id),
  bucket text not null check (bucket in
    ('PROJECT_EMISSIONS','WASTE_TREATMENT','COMPARATIVE_LIFECYCLE','AVOIDED')),
  scope text check (scope in ('SCOPE_1','SCOPE_2','SCOPE_3','OUT_OF_SCOPE')),
  scope3_category int,
  source_type text not null check (source_type in ('ACTIVITY','ASSET_MOVEMENT','MANUAL')),
  source_id uuid,
  factor_set_id     uuid references emission_factor_sets(id),
  factor_id         uuid references emission_factors(id),
  product_factor_id uuid references product_carbon_factors(id),
  factor_set_name    text not null,       -- denormalized: survives a factor-set edit or delete
  factor_set_version text not null,
  factor_reporting_year int,
  factor_kg_co2e_per_unit numeric(18,9),
  quantity numeric(18,6) not null,
  unit     text not null,
  kg_co2e  numeric(18,6) not null,
  method   text not null check (method in
    ('ACTIVITY_X_FACTOR','MASS_X_TREATMENT_FACTOR','DISPLACEMENT','MANUAL')),
  inputs jsonb not null,                  -- the exact numbers that produced the result
  is_estimate boolean not null default false,
  confidence text check (confidence in ('VERIFIED','DOCUMENTED','ESTIMATED','APPROXIMATE')),
  calculated_at timestamptz not null default now(),
  calculated_by_user_id uuid references users(id),
  superseded_by uuid references carbon_calculations(id),
  created_at timestamptz not null default now()
);
create index on carbon_calculations (project_id, bucket) where superseded_by is null;
```

**`bucket` is the firewall.** Sums are always taken within a bucket. There is no query, no type and no UI component in the system that adds `AVOIDED` to anything else — locked decision #17.

Recalculation (a corrected weight, a re-imported factor set) writes **new** rows and stamps `superseded_by` on the old ones. Nothing is updated in place, so a report generated last quarter can still be reconstructed exactly.

### 27.3 What gets calculated

**Operational emissions — `PROJECT_EMISSIONS`**

```sql
create table project_activities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  company_id uuid not null references companies(id),
  kind text not null check (kind in
    ('VEHICLE_DISTANCE','FUEL','ELECTRICITY','FREIGHT','PLANT','OTHER')),
  activity_date date not null,
  vehicle_id uuid references vehicles(id),
  vehicle_category text, fuel_type text,
  distance_km numeric(12,3),
  litres numeric(12,3),
  kwh    numeric(14,3),
  tonne_km numeric(14,3),
  journeys int,
  entered_value numeric(14,3), entered_unit text,   -- what the user actually typed
  purpose text check (purpose in
    ('COLLECTION','DELIVERY','WASTE_TRANSPORT','ASSET_TRANSPORT','CREW_TRAVEL','PLANT','OTHER')),
  provider_company_id uuid references companies(id),      -- subcontractor transport
  asset_movement_id   uuid references asset_movements(id),
  source text not null default 'ESTIMATED'
           check (source in ('MEASURED','DOCUMENTED','ESTIMATED')),
  document_id uuid references project_documents(id),
  notes text,
  created_by_user_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on project_activities (project_id, kind, activity_date);
```

- **Vehicle / transport:** `distance × factor(vehicle category, fuel)`, or `tonne.km × freight factor`. Covers collections, deliveries, waste transport, asset transport, crew travel and subcontractor transport. Scope 1 for own vehicles, Scope 3 for subcontracted.
- **Fuel:** `litres × fuel factor` (Scope 1).
- **Electricity:** `kWh × grid factor` for the reporting year and region (Scope 2, with the WTT/T&D component reported where the publisher separates it).
- **Waste treatment (Scope 3 Cat 5) — `WASTE_TREATMENT`:** `mass × treatment factor`, where `destination_types.ghg_treatment_key` selects the treatment. Treatments supported: reuse (where a factor exists), recycling, landfill, combustion/incineration, energy recovery, other. **Where no suitable factor exists, nothing is produced and the gap is disclosed** — an absent factor is not a zero.

**Avoided emissions — `AVOIDED` (§27.4)** are calculated from `asset_movements` whose destination has `displaces_replacement = true`.

### 27.4 Avoided emissions

A comparative estimate of climate impact. **Not** negative project emissions, and never deducted from any inventory scope.

```
avoided = (quantity × displacement_pct × baseline_embodied_carbon) − enabling_emissions
```

where *enabling emissions* are the additional emissions required to make the reuse happen: refurbishment, cleaning, transport, storage, processing — quantified from `project_activities` and `carbon_calculations` linked to the same movement, where the approved methodology requires their deduction.

Worked example — 100 chairs reused, 80% displacement assumption, 75 kgCO₂e embodied per equivalent chair:

```
baseline   = 100 × 0.80 × 75 kgCO₂e   = 6,000 kgCO₂e
enabling   = transport + refurbishment =   340 kgCO₂e
avoided    =                              5,660 kgCO₂e
```

```sql
create table avoided_emissions_claims (
  id uuid primary key default gen_random_uuid(),
  calculation_id uuid not null references carbon_calculations(id) on delete cascade,
  asset_movement_id uuid references asset_movements(id),
  baseline_scenario    text not null,     -- "equivalent new operator chair manufactured"
  alternative_scenario text not null,     -- "existing chair cleaned and redeployed"
  displacement_pct numeric(5,2),          -- null when basis = UNKNOWN → no claim is made
  displacement_basis text not null check (displacement_basis in
    ('ASSUMED_FULL','USER_DEFINED','UNKNOWN')),
  baseline_kg_co2e   numeric(18,6) not null,
  enabling_kg_co2e   numeric(18,6) not null default 0,
  net_avoided_kg_co2e numeric(18,6) not null,
  system_boundary text not null,          -- from the product factor's lifecycle_boundary
  reporting_period_start date, reporting_period_end date,
  assumptions text not null,
  uncertainty text,
  methodology text not null,
  created_at timestamptz not null default now()
);
```

**Replacement displacement assumption** is explicit per line: `100%`, a user-defined %, or `unknown`. **`UNKNOWN` produces no claim** — it is counted as a data-quality gap, not silently treated as 100%. The org default lives in §39, never in code.

Every claim records baseline scenario, alternative scenario, factor source, system boundary, reporting period, assumptions, quantity, uncertainty and methodology — all of which surface in the report (§29.3). A methodology warning is shown **wherever an avoided figure appears**, in the UI and in the report, not only in an appendix.

### 27.5 GHG Protocol alignment

Calculations are structured so results can be reported consistently with the GHG Protocol: Scope 1 (own vehicles, own fuel), Scope 2 (purchased electricity), Scope 3 (subcontracted transport, freight, and **Category 5 — Waste Generated in Operations**). Scope and Scope 3 category ride on both the factor and the calculation row, so the inventory view is a `group by`.

What CrewQuo must never do, and what §41 enforces:

- Represent avoided emissions as a reduction of Scope 1, 2 or 3.
- Present a single "net" headline that combines emissions and avoided emissions.
- Describe a report as independently verified, ISO-certified or GHG-Protocol-certified. Referencing a methodology is not certification (§29.3).

---

## 28. Sustainability metrics & data quality

### 28.1 Mass balance

Every project's Sustainability section leads with the mass it handled, then where it went — reuse first.

```
TOTAL MATERIAL HANDLED      21.72 t

Reused              8.24 t
Refurbished         2.10 t
Donated             1.04 t
Recycled            8.90 t
Energy recovery     0.82 t
Landfill            0.62 t
```

### 28.2 Definitions (implement exactly)

Let **allocated mass** = Σ mass of movements whose destination is a final outcome. Let **pending mass** = asset mass not yet allocated, plus mass whose latest movement is `STORAGE`.

| Metric | Definition |
|---|---|
| Total material handled | allocated + pending |
| Reuse rate | Σ mass where `counts_as_reuse` ÷ allocated |
| Recycling rate | Σ mass where `counts_as_recycling` ÷ allocated |
| Recovery rate | Σ mass where `counts_as_recovery` ÷ allocated |
| Landfill rate | Σ mass where `counts_as_landfill` ÷ allocated |
| Diversion from landfill | Σ mass where `counts_as_diverted` ÷ allocated |
| Circularity / retained in use | Σ mass where `counts_as_retained_in_use` ÷ allocated |
| Project GHG emissions | Σ `kg_co2e` where bucket ∈ (`PROJECT_EMISSIONS`, `WASTE_TREATMENT`), current rows only |
| Estimated avoided emissions | Σ `kg_co2e` where bucket = `AVOIDED`, current rows only |
| Data completeness | §28.3 |

**Rates are over allocated mass, and pending mass is always shown next to them** — "21.72 t handled, 1.34 t awaiting a final destination". Hiding pending mass in a denominator is how a diversion rate becomes a lie.

### 28.3 Data quality

A single percentage, computed from five weighted components (weights configurable in §39, defaults below):

| Component | Measured over | Default weight |
|---|---|---|
| Asset lines with a weight | line count | 0.25 |
| Mass with a known final destination | mass | 0.25 |
| Mass whose weight is `VERIFIED` or `DOCUMENTED` | mass | 0.20 |
| Asset lines with at least one evidence item or document | line count | 0.15 |
| Avoided-emissions mass using a product-specific (non-generic) factor | mass | 0.15 |

```
Sustainability Data Completeness: 92%
```

Alongside the number, the specific gaps — in plain language, with quantities:

- "18% of project weight is estimated."
- "Carbon benefit for 34 chairs uses a generic product factor."
- "Final destination for 420 kg of stored furniture is currently unknown."
- "No waste-treatment factor exists for plasterboard in the 2027 factor set — 1.2 t excluded from treatment emissions."

These warnings are generated data, not hand-written copy, and they appear in the UI *and* in the report. A report that quietly omits its own gaps is the failure mode this whole section exists to prevent.

### 28.4 Presentation

Two headline carbon figures, side by side, never netted:

```
PROJECT GHG EMISSIONS              ESTIMATED AVOIDED EMISSIONS
3.84 tCO₂e                         27.42 tCO₂e
                                   ⚠ comparative estimate — see methodology
```

---

## 29. Reporting engine

Builds on Phase 4's server-side PDF/XLSX exports in `apps/api` — one rendering path for web and mobile, one place where numbers are formatted.

### 29.1 Project Sustainability & Completion Report

Generated from actual project data, exported to PDF. May carry the contractor's logo, the client's logo, project name, reference, site and reporting period.

Structure:

1. **Cover** — project name · client · site · reporting period · contractor
2. **Executive summary** — a factual summary of scope, work completed, material handled, reuse, recycling, waste and carbon results. Assembled from recorded data; **no invented narrative**.
3. **Project overview** — dates · scope · project manager · supervisor · workforce · subcontractors · site
4. **Sustainability highlights** — e.g. 21.72 t managed · 62.4% kept in use · 91.8% diverted from landfill · 3.84 tCO₂e project emissions · 27.42 tCO₂e estimated avoided emissions
5. **Asset outcomes** — retained · redeployed · reused · refurbished · donated · sold · recycled · recovered · landfill · storage/pending, as table + chart
6. **Material breakdown** — furniture · metal · timber · plastic · WEEE · cardboard · mixed waste · other
7. **Reuse / donation** — items · quantities · weights · recipient · supporting evidence · selected photos
8. **Recycling & waste** — material · weight · treatment · supplier/facility · evidence · transfer documentation
9. **Carbon summary** — **Project GHG emissions** (vehicles, fuel, electricity, waste treatment, other) and **Estimated avoided emissions** (reuse, refurbishment, redeployment, recycling where separately assessed) as two separate subsections. Never netted by default.
10. **Carbon methodology** — auto-generated: factor set name · factor year · calculation methodology · data sources · baseline assumptions · lifecycle boundaries · estimation methodology · limitations · data-quality statement
11. **Evidence** — selected before/during/after photographs
12. **Project completion** — client comments · client sign-off · completion date

### 29.2 Evidence / completion pack

`GENERATE PROJECT EVIDENCE PACK` — the operational counterpart: project details · work completed · site diary · crew · hours · before/during/after photos · assets removed · destination records · waste transfer notes · recycling documentation · donation evidence · variations · incidents (only where client-visible) · client sign-off.

Sections are toggled before generation, and the chosen set is stored on the generated report so a regeneration reproduces the same document.

### 29.3 Disclaimer & claims

A configurable methodology statement (default text in §39, editable per company), similar in meaning to:

> "Greenhouse gas emissions are calculated using activity data recorded for this project and the emission factors identified in this report. Avoided emissions are comparative estimates and are reported separately from Scope 1, Scope 2 and Scope 3 inventory emissions. Results may include estimates where measured activity, asset weight or product-specific lifecycle data was unavailable. Assumptions and data sources are disclosed within this report."

**Never** describe a report as independently verified unless it is, and never claim ISO or GHG Protocol certification because the methodology references those standards.

### 29.4 Reproducibility

```sql
create table generated_reports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,     -- null for client-period reports
  client_company_id uuid references companies(id),
  kind text not null check (kind in ('SUSTAINABILITY','EVIDENCE_PACK','CLIENT_PERIOD')),
  title text not null,
  period_start date, period_end date,
  sections jsonb not null,          -- which sections were included, in order
  snapshot jsonb not null,          -- every number, factor-set id+version, and source record id
  content_hash text not null,       -- sha256 of the canonicalized snapshot
  factor_set_ids uuid[] not null default '{}',
  disclaimer text not null,         -- the exact text used, frozen
  file_id uuid references stored_files(id),      -- the rendered PDF
  status text not null default 'GENERATED'
           check (status in ('GENERATED','SUPERSEDED','VOID')),
  supersedes_id uuid references generated_reports(id),
  client_visible boolean not null default false,
  generated_by_user_id uuid not null references users(id),
  generated_at timestamptz not null default now()
);
```

**Re-rendering a report reads the snapshot; it never recalculates.** A 2026 report opened in 2028, after two new factor sets have been imported and three weights corrected, produces byte-identical numbers. Regenerating *with current data* is an explicit action that creates a new row and marks the old one `SUPERSEDED` — both remain retrievable.

### 29.5 Client-facing project export *(moved here from Phase 4)*

**Owner decision, 2026-08-17.** Phase 4 shipped the owner-side export engine (`GET /v1/projects/:id/export.pdf|.xlsx`, `apps/api/src/modules/exports/`). The **client's** own download belongs here instead, because §29.4 is exactly what it needs: a client re-opening a document must see the numbers they were shown, not a recalculation against rate cards that have since changed.

- Renders from a `generated_reports` snapshot, never from live data — same rule as every other report here.
- **BILL side only.** No PAY figure, no rate snapshot, no subcontractor identity — the §4 boundary, in a file that leaves the building.
- Build the renderer's input from the existing `PortalProjectView` / `PortalLineItem` types in `packages/shared`. Those types *structurally* exclude the owner's PAY columns and every provider identity (that is why they exist as a separate type rather than a filtered `ProjectView`), so the exclusion cannot be forgotten by a later edit the way a `select` list can.
- Reuse Phase 4's `model.ts` formatting seam so a figure reads identically in the owner's export, the client's export and the portal screen. Its output is ASCII-only — jsPDF's built-in Helvetica encodes Latin-1 and drops an em dash or an ellipsis off the page without error.
- Gated on the **owner's** `exports` feature and that engagement's portal settings, matching how the portal read surface already works: a free-plan client can be shown an export by a provider who pays for one.

### 29.6 Charts

Report and dashboard charts are generated server-side into the PDF and client-side in the app from the same snapshot. Keep them plain: mass balance as a stacked bar in hierarchy order, outcomes as a horizontal bar, carbon as two separate figures. No 3-D, no donuts-with-a-number-in-the-middle for anything that is not a single share of a whole.

---

## 30. Variations & commercial performance

### 30.1 Variations / extra works

```sql
create table variations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  company_id uuid not null references companies(id),
  engagement_id uuid references engagements(id),
  reference text,
  description text not null,
  reason      text,
  requested_by text,                     -- client-side person who asked
  requested_on date not null,
  status text not null default 'DRAFT' check (status in
    ('DRAFT','SUBMITTED','APPROVED','REJECTED','COMPLETED','INVOICED')),
  sell_total_cents int not null default 0,
  cost_total_cents int not null default 0,
  client_approved_by text,
  client_approved_at timestamptz,
  approval_evidence_file_id uuid references stored_files(id),
  reviewed_by_user_id uuid references users(id),
  reviewed_at timestamptz,
  reject_reason text,
  invoice_id uuid references invoices(id),
  created_by_user_id uuid not null references users(id),
  updated_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table variation_lines (
  id uuid primary key default gen_random_uuid(),
  variation_id uuid not null references variations(id) on delete cascade,
  kind text not null check (kind in
    ('LABOUR','VEHICLE','MATERIAL','WASTE','SUBCONTRACTOR','OTHER')),
  description text not null,
  quantity numeric(12,2) not null default 1,
  unit_cost_cents int not null default 0,
  unit_sell_cents int not null default 0,
  cost_cents int not null default 0,
  sell_cents int not null default 0,
  role_id  uuid references role_catalog(id),      -- LABOUR lines price off the rate engine
  asset_id uuid references project_assets(id),
  created_at timestamptz not null default now()
);
```

The status machine mirrors the work workflow (§3.4) deliberately — same shape, same guards, plus `COMPLETED`/`INVOICED`. Labour lines resolve their default cost and sell from the existing rate engine, so a variation is priced the same way everything else is. **Approved variations feed project revenue and profitability** through `computeProjectSummary`, not through a second calculator. Every status change and price edit is audited (§36).

### 30.2 Planned vs actual

```sql
create table project_budgets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade unique,
  company_id uuid not null references companies(id),
  currency text not null,
  revenue_cents       int not null default 0,
  labour_cents        int not null default 0,
  subcontractor_cents int not null default 0,
  vehicle_cents       int not null default 0,
  mileage_cents       int not null default 0,
  waste_cents         int not null default 0,
  materials_cents     int not null default 0,
  purchases_cents     int not null default 0,
  expenses_cents      int not null default 0,
  other_cents         int not null default 0,
  notes text,
  created_by_user_id uuid not null references users(id),
  updated_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

**Actuals are computed, never stored** — from approved time logs (labour, via the frozen PAY snapshots), approved expenses, asset movements and activities (vehicles, mileage, waste), and approved variations (revenue). Storing them would create two sources of truth that drift.

Variance is shown per category, absolute and percentage, with direction:

```
Labour     Budget £8,200   Actual £9,040   Variance +£840 / +10.2%
```

Colour communicates direction only (over/under), on the number — not a coloured card per row (§40).

---

## 31. Crew scheduling

```sql
create table vehicles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  registration text,
  category text,                       -- "Van (class III)", "HGV rigid 7.5–17t"
  fuel_type text,
  emission_factor_activity text,       -- the factor `activity` an admin mapped it to (§26)
  capacity_note text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index on vehicles (company_id, registration) where registration is not null;

create table schedule_assignments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  resource_type text not null check (resource_type in ('USER','PROVIDER','VEHICLE')),
  user_id             uuid references users(id),
  provider_company_id uuid references companies(id),
  vehicle_id          uuid references vehicles(id),
  role_id uuid references role_catalog(id),
  is_supervisor boolean not null default false,
  headcount int not null default 1,             -- for PROVIDER rows: "4 crew from Pashe"
  starts_at timestamptz not null,
  ends_at   timestamptz not null,
  location_id uuid references project_locations(id),
  status text not null default 'PLANNED' check (status in ('PLANNED','CONFIRMED','CANCELLED')),
  notes text,
  created_by_user_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index on schedule_assignments (company_id, starts_at);
create index on schedule_assignments (project_id, starts_at);
```

- **Views:** day, week and month. Resource rows down, time across. Drag-and-drop on web where it is genuinely faster than a form; mobile is read-plus-confirm, not drag.
- **Conflict detection is a warning, not a block** — overlapping assignments for the same user or vehicle are surfaced at save time with the clash named. `CANCELLED` rows never conflict. Deliberate double-booking of a subcontractor's *company* is normal and only warns when headcount exceeds a stated availability.
- **Availability & requirements:** per-user availability windows and per-project role requirements ("2 × Rigger, 1 × Supervisor, Mon–Wed") drive an unfilled-requirement indicator. Requirements live on the project, not the schedule.
- **Connects to existing time/rate calculations:** an assignment pre-fills the log-time screen (project, role, date, shift), and planned labour cost resolves through the rate engine for §30.2's budget line.
- **Compliance flags** (§33) show on the assignment row where the subcontractor has an expired or expiring document — visible, never automatically blocking unless configured.

---

## 32. Supervisor mobile experience

> **Built in Phase 13, after the shared domain is proven** (decision #21). This is a purpose-designed field experience, not a copy of the web workspace.

A separate, simplified project screen for supervisors — **not** the desktop admin UI shrunk down. New expo-router group `apps/mobile/app/(app)/site/`.

```
TODAY
  Project · Site · Time

  [ Start Shift ]

  Crew            Tasks           Add Photo
  Site Diary      Assets Removed  Waste / Reuse
  Add Expense     Report Issue    Add Variation
  Client Sign-Off                 Complete Day
```

- Large touch targets — the user is wearing gloves in a loading bay.
- **One screen, one job.** Each action opens a focused flow with the project, date and (where known) location pre-filled.
- **Add Photo** is reachable in one tap from the site screen and defaults to camera capture.
- **Complete Day** closes the diary (§23) and prompts for anything obviously missing: no photos today, assets with no destination, unsubmitted time.
- Everything posts to the **same endpoints** the web app uses. No mobile-only write path, no divergent validation.
- Offline capture is a Phase 13 decision and is a real gap for basements and lifts—flagged in §45.

---

## 33. Subcontractor compliance

Extends the company/engagement model rather than adding a subcontractor record type.

```sql
create table compliance_documents (
  id uuid primary key default gen_random_uuid(),
  subject_company_id uuid not null references companies(id) on delete cascade,  -- who it covers
  owner_company_id   uuid not null references companies(id) on delete cascade,  -- who tracks it
  engagement_id uuid references engagements(id),
  kind text not null check (kind in
    ('PUBLIC_LIABILITY','EMPLOYERS_LIABILITY','PROFESSIONAL_INDEMNITY','RAMS',
     'TRAINING','QUALIFICATION','LICENCE','CERTIFICATE','OTHER')),
  title text not null,
  reference text,
  insurer text, cover_amount_cents bigint,     -- for insurance kinds
  file_id uuid references stored_files(id),
  issued_on date, expires_on date,
  status text not null default 'VALID'
           check (status in ('VALID','EXPIRING','EXPIRED','MISSING','REJECTED')),
  verified_by_user_id uuid references users(id),
  verified_at timestamptz,
  notes text,
  uploaded_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on compliance_documents (owner_company_id, expires_on);

create table compliance_alerts (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references compliance_documents(id) on delete cascade,
  threshold_days int not null check (threshold_days in (90,60,30,14,7)),
  sent_at timestamptz not null default now(),
  unique (document_id, threshold_days)
);
```

- **Alerts at 90 / 60 / 30 / 14 / 7 days** before expiry, once per threshold, to the tracking company's managers (and to the subcontractor where they are a CrewQuo company). Delivered by the same nightly job that purges audit rows.
- `status` is recomputed nightly and on write.
- **Work is never blocked automatically.** `sustainability_settings`-adjacent company config carries `enforce_compliance` (default `false`); only when an org turns it on does an expired mandatory document prevent scheduling or submission — and even then it warns loudly rather than failing silently.
- A subcontractor uploads its own documents once and they are visible to each company that engages it, per the one-hop rule — no re-upload per client.

---

## 34. Client sign-off

```sql
create table client_signoffs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  company_id uuid not null references companies(id),          -- the contractor capturing it
  engagement_id uuid references engagements(id),
  phase text,                                                  -- null = whole project
  signer_name text not null,
  signer_company text,
  signer_role text,
  signer_email text,
  signature_file_id uuid references stored_files(id),          -- drawn signature image
  completion_statement text not null,
  comments text,
  signed_at timestamptz not null,
  signed_ip inet, signed_user_agent text,
  evidence_snapshot jsonb not null,     -- the exact state signed for
  content_hash text not null,
  supersedes_id uuid references client_signoffs(id),
  captured_by_user_id uuid not null references users(id),
  created_at timestamptz not null default now()
);
```

Captured on-site on a phone or tablet at project or phase completion. The `evidence_snapshot` freezes what was signed for — the completion statement, the work summary, the asset outcomes and the evidence set as they stood at that moment — and `content_hash` makes tampering detectable. Rows are **append-only**: a later amendment is a new row pointing at the one it supersedes, and both are retained with their signatures. This is the immutable-evidence-plus-audit-history requirement.

---

## 35. Project timeline

An automatic chronology assembled from records that already exist — no new writes, one read model:

project creation · crew assignments · diary entries · time entries · photos · asset movements · waste records · document uploads · variations · approvals · incidents · client sign-offs · completion.

`GET /v1/projects/:id/timeline?from&to&types[]&cursor` — a UNION over the source tables ordered by event time, keyset-paginated like every other list (§7). Each item carries type, timestamp, actor, a one-line description and a link to the record. Filters by type and date; the client-portal variant returns only client-visible items.

Someone who was not on site should be able to read the timeline and understand what happened.

---

## 36. Auditability

`audit_logs` + `recordAudit` (§3.6) already capture *that* something happened, on every Phase 3/4 mutation. Commercial and sustainability records additionally need *what changed*.

```sql
create table record_revisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  entity_type text not null,          -- 'project_asset', 'asset_movement', 'variation', ...
  entity_id   uuid not null,
  revision    int not null,
  action text not null check (action in ('CREATE','UPDATE','DELETE')),
  before jsonb, after jsonb,
  changed_fields text[] not null default '{}',
  reason text,
  changed_by_user_id uuid references users(id),
  changed_at timestamptz not null default now(),
  unique (entity_type, entity_id, revision)
);
create index on record_revisions (entity_type, entity_id, revision desc);
```

Revision-tracked, with a **required reason** on the starred ones:

weights ★ · destinations and movements ★ · emission factors and factor sets · carbon calculations (via supersession, §27.2) · approved time and rates ★ · variations ★ · client sign-off (via supersession, §34) · sustainability classifications · closed diary entries ★ (§23).

Every such table also carries `created_by_user_id` / `created_at` / `updated_by_user_id` / `updated_at`. Like `recordAudit`, revision writes **never throw** into the caller — a broken trail must not fail an approval; failures are logged. Retention follows the existing `audit_retention_days` entitlement, except that revisions attached to a generated report are retained as long as the report is.

---

## 37. Permissions & capabilities

**The four membership roles do not change.** `OWNER`/`ADMIN`/`MANAGER`/`MEMBER` keep their current meaning and every existing check keeps working. Job functions are a capability layer on top — which is how a Supervisor can write the diary without being able to see margin, and a Finance user can see margin without being able to close a day.

```sql
create table capabilities (
  key text primary key, name text not null, description text, category text not null
);
create table capability_bundles (
  key text primary key, name text not null, description text,
  company_id uuid references companies(id) on delete cascade,   -- null = system bundle
  is_system boolean not null default true
);
create table capability_bundle_items (
  bundle_key text not null references capability_bundles(key) on delete cascade,
  capability_key text not null references capabilities(key),
  primary key (bundle_key, capability_key)
);
alter table memberships add column bundle_key text references capability_bundles(key);  -- null ⇒ derive from role
create table membership_capability_overrides (
  membership_id uuid not null references memberships(id) on delete cascade,
  capability_key text not null references capabilities(key),
  granted boolean not null,
  note text,
  primary key (membership_id, capability_key)
);
```

**Capability keys** (the enforcement surface):

`project.read` · `project.manage` · `schedule.manage` · `crew.manage` · `time.log.own` · `time.review` · `expense.log` · `expense.review` · `diary.write` · `diary.close` · `evidence.upload` · `evidence.manage` · `evidence.publish` · `document.upload` · `document.manage` · `asset.write` · `asset.destination.set` · `asset.weight.verify` · `sustainability.read` · `sustainability.factors.manage` · `sustainability.settings.manage` · `variation.create` · `variation.approve` · `commercial.read` · `commercial.manage` · `invoice.manage` · `signoff.capture` · `report.generate` · `compliance.manage`

**System bundles:**

| Bundle | Grants |
|---|---|
| **Admin** | everything |
| **Project Manager** | project ops, assets, evidence, sustainability read/write, commercial read/manage, variations, reports, schedule, crew |
| **Supervisor** | diary (write + close), evidence upload, crew read, assets, asset destinations, issues, expenses, variation create, signoff capture — **no** `commercial.read` |
| **Worker** | `time.log.own`, `expense.log`, `evidence.upload` (own uploads), `project.read` on assigned projects |
| **Finance** | `commercial.read/manage`, `invoice.manage`, `expense.review`, `time.review`, `variation.approve`, reports |
| **Sustainability / Compliance** | assets, destinations, weights, `sustainability.*`, `document.manage`, `compliance.manage`, `report.generate` |

**Safe default resolution.** A null `bundle_key` derives capabilities from the membership role: `OWNER`/`ADMIN` → Admin, `MANAGER` → Project Manager, `MEMBER` → Worker. This keeps prototype and seeded memberships valid while the unified capability model is introduced.

**Resolution** mirrors `resolveEntitlements`: `resolveCapabilities(membershipId)` = bundle ⊕ overrides, cached with the same TTL and invalidated on the same events. A route requires **both** `hasFeature(companyId, …)` (does the plan sell it?) **and** `hasCapability(ctx, …)` (may this person do it?), and both live in `policies.ts`/`guards.ts` beside the existing checks. **A capability never widens company scope or the one-hop rule** — those are checked first and independently.

**Client** remains an engagement position with the existing restricted portal (§3.6), never a user role. Locked decision #7 is unchanged.

---

## 38. Dashboards & client-level reporting

### 38.1 Organisation dashboard

The organisation dashboard is designed as one operational view of commercial and sustainability performance: total tonnes handled · reused · refurbished · donated · recycled · landfill · diversion from landfill % · retained-in-use % · project emissions tCO₂e · **separately** reported avoided emissions tCO₂e. Existing prototype widgets do not constrain its layout.

Filters: date range · client · project · project manager · site · destination · asset category.

**No vanity metrics.** Every figure is clickable through to the records behind it, and any figure whose data completeness is below a configurable threshold is shown with its completeness percentage attached rather than presented as fact.

### 38.2 Client-level aggregation

Multiple projects for the same client roll up into a client report over a period:

```
PwC · December 2026 – November 2027
Projects 32 · Total material managed 184.6 t
Reused 74.8 t · Recycled 92.1 t · Landfill 3.7 t · Other 14.0 t
Retained in use 48.3% · Diversion from landfill 98.0%
Project operational emissions X tCO₂e · Estimated avoided emissions Y tCO₂e
```

Aggregation runs over `client_company_id` (following `claimed_by_company_id` tombstones so a placeholder that later signed up still aggregates with its own history) and reuses the project metric definitions in §28.2 — summed, never re-derived by a second code path. **Mixed factor years are disclosed**: a period spanning two factor sets says so.

**Build the data architecture now** even though the full client-reporting UI is Phase 12: the `CLIENT_PERIOD` report kind, the aggregation query and the period fields exist from Phase 10 so nothing has to be reshaped later. Quarterly and annual client sustainability reporting is the destination.

---

## 39. Admin: sustainability settings

Assumptions live in a settings screen, not in source code.

```sql
create table sustainability_settings (
  company_id uuid primary key references companies(id) on delete cascade,
  default_country text not null default 'GB',
  default_factor_set_id uuid references emission_factor_sets(id),
  reporting_year int,
  weight_unit   text not null default 'AUTO'  check (weight_unit in ('KG','TONNE','AUTO')),
  distance_unit text not null default 'KM'    check (distance_unit in ('KM','MILE')),
  carbon_display_unit text not null default 'AUTO'
                       check (carbon_display_unit in ('KGCO2E','TCO2E','AUTO')),
  default_displacement_pct numeric(5,2) not null default 100,
  allow_generic_product_factors boolean not null default true,
  require_document_for_verified_weight boolean not null default true,
  capture_gps_on_evidence boolean not null default false,
  data_quality_weights jsonb not null,           -- §28.3 defaults
  data_quality_warn_below int not null default 80,
  report_disclaimer text not null,               -- §29.3 default text
  report_logo_file_id uuid references stored_files(id),
  report_accent_hex text,
  enforce_compliance boolean not null default false,
  updated_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Also configurable from this area: default waste classifications, asset categories and custom asset types (§25.1), destination types and their counts-as flags (§25.4), destination organisations, approved product carbon factors (§26.3) and factor-set imports (§26.2).

---

## 40. Design requirements

Preserve CrewQuo branding. The product must look like **serious commercial operations software** — the kind of tool a project manager keeps open all day.

**Avoid** — these read as machine-generated and waste the screen:

excessive rounded cards · `rounded-3xl` everywhere · gradients · glassmorphism · glowing buttons · oversized headings · decorative blobs · cards inside cards · unnecessary icons · huge empty spaces · excessive pill badges.

**Prioritise:** tables · lists · clear typography · structured forms · compact metrics · side panels · filters · timelines · evidence galleries · understandable charts · strong information hierarchy.

**Specifics that follow from the above:**

- **Density.** A project's asset list is a table with sortable columns and inline editing, not a feed of cards. Aim for 20+ rows visible on a laptop screen.
- **One elevation level.** Panels sit on the page. Panels do not sit inside panels.
- **Numbers are typographic, not decorative.** Tabular figures, right-aligned, consistent decimal places, units stated once in the column header.
- **Colour carries meaning only.** Over/under budget, expired/expiring, verified/estimated, hierarchy tier. **The sustainability module must not be green everywhere** — a green wash makes every number look like good news, including the landfill one. Use the same neutral surface as the rest of the app and let the data colour itself.
- **Warnings are inline and specific.** "18% of project weight is estimated" next to the figure it qualifies, not a banner at the top of the page.
- **Mobile is a different design, not a narrower one** (§32).

Existing tokens live in `packages/ui`. The owner has frontend work happening via Codex (§17) — these constraints apply to that work too.

---

## 41. Calculation principles (non-negotiable)

1. **Never invent emissions factors.** No factor, no number — say so instead.
2. **Every carbon result traces back to** activity data → factor → factor version → methodology. If a result cannot name all four, it does not ship.
3. **Historical reports remain reproducible.** New factor sets never change old reports (§29.4).
4. **Avoided emissions stay separate** from Scope 1/2/3 inventory emissions, in the schema, the API and every screen (§27.4).
5. **Reuse is distinguished from recycling** everywhere, and ranked above it (§25.5).
6. **Measured data is distinguished from estimated data**, at the row level and in every total (§25.3).
7. **Asset storage does not count as reuse** — or as any outcome — until a final destination is recorded (§25.4).
8. **"Diverted from landfill" is not "reused."** They are different metrics with different definitions and are never presented as interchangeable.
9. **Full precision internally, sensible rounding for display.** Never round mid-calculation; never display more precision than the input justifies.
10. **Every generated report discloses its methodology and material assumptions** (§29.1 §10, §29.3).

When a product decision and one of these principles conflict, the principle wins — and the conflict goes to the user, not into the code.

---

## 42. Delivery roadmap — Phases 5–13

This is one v2 roadmap. Each phase is independently demoable and verified end to end before the next begins. The sequence manages implementation risk; every phase below belongs to the new application.

**Current position.** Phase 4's domain and **export engine** are complete (2026-08-17); §29 builds on `apps/api/src/modules/exports/model.ts`, the single place a figure is formatted. **Phase 5 is built and verified** (2026-08-17) — every workflow, plus the endpoints the phase itself found missing (super-admin companies console, member management, `PATCH /v1/me`); its closing milestone is an owner judgement on information architecture and visual design. **Phase 6 is next**, and makes the product commercially operable; note that two of its inputs are still open owner decisions (real per-currency pricing, and the Gumroad payout/webhook confirmation — §17). Phases 7–12 then complete the operational scope.

### Web-led sequencing (decision #21)

> Phases 5–12 establish the complete web workspace and shared domain. Phase 13 delivers the complete mobile field workspace.
>
> This does not make mobile a port. Existing mobile code may be reused or replaced, and the field experience is designed for field jobs, device capabilities, intermittent connectivity and one-handed use.
>
> A phase is **not done** until its relevant web experience is complete—every state (empty, loading, error, limit-reached and permission-denied), not only a happy path. Phase 13 is not done until the same standard is met for every in-scope field workflow.

### Phase 5 — Unified v2 web application

Create the new product experience described in §9 and §20. The existing API capability inventory is useful, but this is not a parity exercise and not necessarily UI-only: reshape contracts or backend orchestration where the workflow needs it.

- [x] Auth completion: register, forgot/reset password, verify email, profile (incl. `PATCH /v1/me`), company switcher
- [x] Entitlements: plan + live usage, limit-reached and feature-locked states
- [x] Engagements, providers, clients: list/create/pause/end, invite flows, **public invite-accept page**
- [x] Members + invites, plus role change, suspend/restore and removal
- [x] Projects: list, detail, create/edit, provider assignment, summary with cost/bill/margin
- [x] Time & expenses: entry plus **bulk review/approve at scale** — filters, multi-select, reject-with-reason
- [x] Client portal: client-side project list + detail, line items, notes thread
- [x] Audit trail viewer + per-engagement visibility settings
- [x] Super-admin console: plans/prices/features/limits, companies + overrides + comped trials + forced plan changes
- [x] Playwright E2E over the full loop: register → company → provider invite → project → log time → approve → portal → audit (17 tests)
- *Milestone: the core lifecycle feels like one intentionally designed product from onboarding through client collaboration—not a collection of endpoint screens.* **Every workflow is built, reachable and verified; whether it reads as one designed product is the owner judgement still open — see `PROGRESS.md`.**

### Phase 6 — Commercial readiness

- [ ] `invoices` and `invoice_items`, with totals derived from the same approved work and variation calculations.
- [ ] Merchant-of-Record checkout, webhooks, trial-to-paid state and entitlement snapshots.
- [ ] Super-admin price and subscription management.
- [ ] Push and email notifications with user preferences and retry-safe delivery.
- [ ] Public marketing, pricing, terms, privacy and refund pages.
- [ ] Production observability, support tooling, backup/restore rehearsal and launch runbook.
- *Milestone: a company can discover, subscribe to and operate CrewQuo without manual database or platform intervention.*

### Phase 7 — Evidence foundations
- **7.0 Storage service** (§22.1): `stored_files`, R2 presign/complete, `sharp` derivatives, download authorization, `storage_gb` metering. Retro-fit expense receipt upload, which Phase 3 deferred.
- **7.1 Capability layer** (§37): `capabilities`, bundles, overrides, `resolveCapabilities`, `hasCapability`, role-derived defaults. Ship before the modules that need Supervisor ≠ Manager.
- **7.2 Project locations** (§21).
- **7.3 Project evidence** (§22): records, batch upload, camera capture, gallery/timeline/filters, selection.
- **7.4 Project documents** (§24).
- **7.5 Site diary** (§23) with attendance, Close Day and post-close revisions.
- **7.6 Web UI:** the project section shell (§20) with these five sections — evidence gallery/timeline/filters with drag-and-drop batch upload, document manager, diary editor with Close Day. Desktop upload and batch metadata editing carry this phase; camera capture arrives in Phase 13.
- *Milestone: a full day's evidence — photos, documents and a closed diary entry — captured and organised on the project from a desktop, attributed, dated and located.*

### Phase 8 — Assets & materials
- `asset_types` (seeded, no invented weights), `project_assets` with bulk lines and weight provenance (§25.2, §25.3).
- `destination_types` (seeded per §25.4), `destination_organisations`, `asset_movements` with partial splits and derived `outcome_state`.
- Mass roll-ups and the pending/allocated split (§28.2, mass only — no carbon yet).
- Evidence and document linkage to assets and movements.
- Web: asset table with inline editing, bulk entry/paste-import, movement recording and destination assignment.
- *Milestone: 42 chairs in, 30 donated and 12 recycled out, with weights, evidence and a destination organisation on each — and the project reports the tonnage split correctly.*

### Phase 9 — Sustainability engine
- `emission_factor_sets` / `emission_factors` + the importer and admin UI (§26.1, §26.2).
- `product_carbon_factors` + the preferred-source resolver (§26.3).
- `packages/shared/src/carbon-engine/` with exhaustive tests (§27.1).
- `project_activities` (§27.3), `carbon_calculations` with supersession (§27.2), `avoided_emissions_claims` (§27.4).
- Project Sustainability section: mass balance, rates, two separate carbon figures, data quality with named gaps (§28).
- Organisation sustainability dashboard (§38.1).
- `sustainability_settings` (§39).
- *Milestone: a project shows 3.84 tCO₂e emissions and 27.42 tCO₂e avoided, side by side, every number traceable to a factor and a factor-set version.*

### Phase 10 — Reporting & sign-off
- Sustainability & Completion report (§29.1) with snapshots and reproducible re-render (§29.4).
- Evidence pack with section selection (§29.2).
- Disclaimer configuration and claim guards (§29.3).
- Client sign-off with signature capture and immutable snapshots (§34).
- `CLIENT_PERIOD` report kind + the aggregation query shipped now, UI later (§38.2).
- *Milestone: a client-ready PDF generated from real project data, regenerable byte-identical a year later.*

### Phase 11 — Commercial & operations
- Variations with pricing, approval and revenue feed-through (§30.1).
- `project_budgets` + computed actuals + variance (§30.2).
- Scheduling with day/week/month, drag-and-drop assignment, conflicts and requirements (§31).
- Project timeline (§35).
- *Milestone: budget vs actual with approved variations included, and a week's crew scheduled with conflicts surfaced.*

### Phase 12 — Compliance & analytics
- Subcontractor compliance documents, statuses and the 90/60/30/14/7 alert ladder (§33).
- Client aggregated reporting UI, quarterly and annual (§38.2).
- Advanced analytics and cross-project comparison.
- *Milestone: a year of PwC projects aggregated into one client sustainability report.*

### Phase 13 — Complete mobile field experience

Build and validate the purpose-designed mobile workspace against the field jobs in §8 and §32. By this point the shared domain is proven, but the information architecture and interactions are mobile decisions—not copies of web screens.

- **13.1 Establish the mobile product shell:** navigation, authentication, company/project context, design system, accessibility and resilient API state. Reuse prototype code only where it fits the target experience.
- **13.2 Supervisor site experience** (§32) — the `(app)/site/` group and its 11 actions. The flagship field screen.
- **13.3 Evidence capture** — direct camera, multi-shot, project/date/location pre-fill, background upload with retry (§22.3).
- **13.4 Site diary** on mobile — write, attendance confirm, Close Day with its missing-data prompts (§23).
- **13.5 Assets & waste** — Assets Removed and Waste/Reuse flows, destination assignment on site (§25).
- **13.6 Read-and-confirm surfaces** — schedule (not drag, §31), project sections that make sense on a phone (§20), timeline, compliance flags.
- **13.7 Sign-off capture** — signature on glass, the one interaction that is genuinely better on a tablet than a desktop (§34).
- **13.8 Offline capture** (§45 open item) — draft queue for diary, evidence and assets; basements and loading bays have no signal. Decide here whether it is in scope or stays deferred.
- **13.9 EAS store submission** — dev-client, production builds, OTA channels and store listings for the complete field app.
- **13.10 Maestro E2E** on the supervisor day: start shift → photo → diary → assets → complete day.
- *Milestone: a supervisor runs an entire site day from a phone through a coherent field product that shares data and rules with the web workspace.*

**Which project sections reach mobile** (the §20 gap called out earlier): Overview, Schedule (read), Crew, Site Diary, Photos & Evidence, Assets & Materials, Variations (create only), Documents (read), Client Sign-Off. **Not on mobile:** Time & Costs beyond own entry, Sustainability, Reports, and the full commercial view — those are desk work and stay on web.

**Throughout every phase:** `record_revisions` on the tables §36 lists, `recordAudit` on every mutation, entitlement keys registered (§43), tests written with the code (§44), and no regression in what Phases 0–4 already do.

---

## 43. Entitlements additions

New keys for the existing engine (§5B) — the mechanism is unchanged, these are rows.

**Features:** `project_evidence` · `site_diary` · `project_documents` · `asset_tracking` · `sustainability` · `carbon_engine` · `sustainability_reports` · `evidence_pack` · `client_signoff` · `variations` · `scheduling` · `compliance_tracking` · `client_reporting` · `custom_factors` (import your own factor sets)

**Limits:** `storage_gb` · `evidence_uploads_per_month` · `active_projects` · `factor_sets`

Suggested placement against the seed plans (§5B) — final packaging is an owner decision (§45):

| | Crew | Starter | Pro | Business | Enterprise |
|---|---|---|---|---|---|
| evidence / diary / documents | upload only | ✔ | ✔ | ✔ | ✔ |
| asset tracking | — | ✔ | ✔ | ✔ | ✔ |
| sustainability + carbon engine | — | — | ✔ | ✔ | ✔ |
| sustainability reports / evidence pack | — | — | ✔ | ✔ | ✔ |
| variations / scheduling | — | ✔ | ✔ | ✔ | ✔ |
| compliance tracking | — | — | ✔ | ✔ | ✔ |
| client reporting / custom factors | — | — | — | ✔ | ✔ |
| `storage_gb` | 1 | 25 | 200 | 1000 | unlimited |

`storage_gb` is the one genuinely metered new axis, and it needs usage wired into `usage.ts` alongside `active_subcontractors` and `clients`.

---

## 44. Testing additions

Extends §13; same gates, same CI.

- **`packages/shared/src/carbon-engine/` — exhaustive unit tests, written before anything renders a number.** Every branch of factor selection (year, region, validity window, missing factor), every unit conversion, every rounding boundary, and every avoided-emissions path including `UNKNOWN` displacement and the no-factor case. This is the rate engine lesson applied: the pure core is where correctness is cheap.
- **Metric definition tests** (§28.2) over fixture projects: pending mass excluded from rates, storage never counted, partial movement splits, diversion ≠ reuse, empty project returns nulls not zeros.
- **Reproducibility test:** generate a report, import a new factor set, correct a weight, re-render the report — assert byte-identical numbers and an unchanged `content_hash`; then regenerate-with-current-data and assert a new row plus `SUPERSEDED` on the old.
- **The firewall test:** assert that no API response ever returns a total mixing the `AVOIDED` bucket with any other, and that no persisted `carbon_calculations` sum crosses buckets.
- **Authorization tests per capability** (§37), following the existing one-test-per-rule discipline: Supervisor cannot read margin; Worker cannot set a destination; Finance cannot close a diary; a capability never widens company scope or the one-hop rule.
- **Storage tests:** presign rejects oversize and wrong content type; complete verifies checksum; downloads 403 without the owning record's authorization; derivative failure leaves the original intact.
- **Backward-compatibility suite:** the Phase 0–4 end-to-end scripts re-run unchanged at the end of every new phase. Existing endpoint response shapes are snapshot-tested so an additive change cannot silently become a breaking one.

---

## 45. Domain open items (ask before building the affected phase)

- **Emission factor dataset redistribution.** Confirm the licensing terms for the UK Government GHG Conversion Factors (and any WRAP/Defra resource dataset) before bundling one into the seed or a platform-wide factor set. Until confirmed, Phase 9 ships the importer and orgs upload their own. *(Phase 9)*
- **Feature packaging for the new modules** — the §43 table is a proposal. Which tier sells sustainability? Is asset tracking a Starter feature or the Pro hook? *(Phase 7, before the first gate is written)*
- **Enabling-emissions policy for avoided claims** — deduct refurbishment/transport/storage always, or only when the org's methodology requires it? Default matters because it changes headline numbers. *(Phase 9)*
- **Default displacement assumption** — ship at 100% or at "unknown, ask"? 100% is the industry-common default and the more flattering one. *(Phase 9)*
- **Offline capture for supervisors** — basements, lifts and loading bays have no signal, and §32 is the flagship mobile experience. Decide in Phase 13 (13.8) whether the first release includes the resilient draft queue or explicitly defers it. *(Phase 13)*
- **Client visibility defaults for evidence** — every new evidence/document/report row defaults to `client_visible = false`. Confirm that is right for photos, which clients most want to see. *(Phase 7)*
- **GPS capture** — off by default (§39). Confirm; it is worker-location data and some organisations will not want it recorded at all. *(Phase 7)*
- **Retention for evidence and originals** — audit rows expire on the plan's `audit_retention_days`; photos and originals currently do not expire at all, which is a growing storage bill. Lifecycle policy? *(Phase 7)*
- **Report branding** — contractor logo and client logo are specified (§29.1). Confirm where the client logo comes from: uploaded per client company, or per project? *(Phase 10)*

---

## 46. API contract additions

Extends §7 — same conventions throughout, no exceptions: `Authorization: Bearer` + `X-Company-Id`, shared Zod schemas in `packages/shared` typing both sides, `{ data, nextCursor }` keyset lists, the `{ error: { code, message, details? } }` envelope, and `Idempotency-Key` on create/submit/approve. `CRUD` below means the usual five verbs.

```
# Files & storage (§22.1)
POST   /v1/files/presign                    -- validates type/size/storage_gb; returns presigned PUT + PENDING row
POST   /v1/files/:id/complete               -- verifies checksum/size, READY, enqueues derivatives
GET    /v1/files/:id/download               -- authorized short-lived presigned GET (?variant=ORIGINAL|WEB|THUMB)
DELETE /v1/files/:id

# Locations, evidence, documents, diary (§21–§24)
CRUD   /v1/projects/:id/locations
POST   /v1/projects/:id/locations/apply-template
CRUD   /v1/projects/:id/evidence            -- filters: category, from, to, uploaderId, locationId, assetId, clientVisible
PATCH  /v1/projects/:id/evidence/batch      -- apply category/date/location/visibility to a selection
CRUD   /v1/projects/:id/documents
CRUD   /v1/projects/:id/diary               -- one entry per project/company/date
POST   /v1/projects/:id/diary/:entryId/close
GET    /v1/projects/:id/diary/:entryId/revisions
CRUD   /v1/projects/:id/incidents

# Assets & materials (§25)
CRUD   /v1/asset-types                       -- company rows shadow system rows
CRUD   /v1/destination-types                 -- hierarchy tier + counts-as flags (feature: sustainability)
CRUD   /v1/destination-organisations
CRUD   /v1/projects/:id/assets
POST   /v1/projects/:id/assets/bulk          -- paste/import many lines at once
CRUD   /v1/assets/:assetId/movements         -- quantity splits; outcome_state derived server-side
GET    /v1/projects/:id/materials/summary    -- mass balance, allocated vs pending (§28.2)

# Sustainability & carbon (§26–§28)
CRUD   /v1/emission-factor-sets              (capability: sustainability.factors.manage)
POST   /v1/emission-factor-sets/:id/import   -- CSV/XLSX; ?dryRun=true returns the diff, never writes
GET    /v1/emission-factors                  -- search: category, activity, material, treatment, unit
CRUD   /v1/product-carbon-factors
CRUD   /v1/projects/:id/activities           -- vehicle distance / fuel / electricity / freight
POST   /v1/projects/:id/carbon/calculate     -- (re)calculates; writes new rows + supersedes old (§27.2)
GET    /v1/projects/:id/carbon               -- rows grouped by bucket & scope; never a cross-bucket total
GET    /v1/projects/:id/sustainability       -- metrics + data quality + named gaps (§28)
GET/PUT /v1/sustainability-settings          (capability: sustainability.settings.manage)

# Reporting & sign-off (§29, §34)
POST   /v1/projects/:id/reports              -- { kind, sections, periodStart?, periodEnd? } → snapshot + render
GET    /v1/reports                           -- list; filters: projectId, kind, status
GET    /v1/reports/:id                       -- the frozen snapshot
GET    /v1/reports/:id/download.pdf          -- re-renders FROM the snapshot (§29.4)
POST   /v1/reports/:id/regenerate            -- recalculates: new row, old marked SUPERSEDED
CRUD   /v1/projects/:id/signoffs             -- append-only; PATCH creates a superseding row

# Commercial & operations (§30–§32, §35)
CRUD   /v1/projects/:id/variations  /v1/variations/:id/lines
POST   /v1/variations/:id/submit | /approve | /reject | /complete
GET/PUT /v1/projects/:id/budget
GET    /v1/projects/:id/performance          -- planned vs actual vs variance by category (§30.2)
CRUD   /v1/vehicles
CRUD   /v1/schedule-assignments              -- ?from&to&resourceType&projectId
GET    /v1/schedule/conflicts?from&to        -- warnings, never a block
GET    /v1/projects/:id/timeline             -- ?from&to&types[]&cursor (§35)

# Compliance, capabilities, dashboards (§33, §37, §38)
CRUD   /v1/compliance-documents              -- ?subjectCompanyId&status&expiringWithinDays
GET    /v1/compliance/summary                -- expiry ladder across all engaged providers
GET    /v1/capabilities                      -- catalog + this membership's resolved set
CRUD   /v1/capability-bundles                (OWNER/ADMIN)
PUT    /v1/members/:membershipId/capabilities -- bundle + overrides
GET    /v1/dashboard/sustainability          -- ?from&to&clientId&projectManagerId&siteId&destination&assetCategory
GET    /v1/clients/:clientCompanyId/sustainability -- period aggregation (§38.2)
```

**Gating.** Every route above is guarded by `hasFeature` (does the plan sell it? §43) **and** `hasCapability` (may this person do it? §37), after the existing company-scope and one-hop checks — which are unchanged and always run first. Client-portal reads of any new resource go through the existing `/v1/portal/*` surface and return only `client_visible` rows; no new endpoint exposes a counterparty's data directly.

---

## 47. Brief → specification map

Every section of the implementation brief, and where it is specified here.

| Brief | Topic | Plan |
|---|---|---|
| intro | Scope, customers, lifecycle, one coherent product | §19, §0, decision #12 |
| 1 | Project structure | §20 |
| 2 | Project photos & evidence | §22 (storage §22.1) |
| 3 | Site diary | §23 |
| 4 | Project locations | §21 |
| 5 | Asset & material tracking | §25.1, §25.2 |
| 6 | Asset destinations | §25.4 |
| 7 | Waste hierarchy | §25.4, §25.5 |
| 8 | Weight tracking | §25.3, decision #14 |
| 9 | Sustainability module | §28 |
| 10 | Carbon / CO₂e engine | §26.1, §27.1, §27.2 |
| 11 | UK Government GHG factors | §26.2 |
| 12 | GHG Protocol alignment | §27.5 |
| 13 | Project operational emissions | §27.3 |
| 14 | Avoided emissions | §27.4 |
| 15 | Embodied carbon / product factors | §26.3 |
| 16 | Reuse calculations | §27.4 |
| 17 | Recycling & resource carbon metrics | §26.4 |
| 18 | Sustainability data quality | §28.3 |
| 19 | Variations / extra works | §30.1 |
| 20 | Planned vs actual | §30.2 |
| 21 | Crew scheduling | §31 |
| 22 | Supervisor mobile experience | §32 |
| 23 | Project documents | §24 |
| 24 | Subcontractor compliance | §33 |
| 25 | Client sign-off | §34 |
| 26 | Project sustainability report | §29.1 |
| 27 | Report disclaimer | §29.3 |
| 28 | Evidence / completion pack | §29.2 |
| 29 | Project timeline | §35 |
| 30 | Auditability | §36 |
| 31 | Permissions | §37 |
| 32 | Dashboard | §38.1 |
| 33 | Client-level reporting | §38.2 |
| 34 | Admin sustainability settings | §39 |
| 35 | Design requirements | §40 |
| 36 | Calculation principles | §41 |
| 37 | Implementation approach | §0 (rules), §19.3 (shared foundations), §42 (phases + database changes), §46 (API), §37 (permissions), §22.1 (file storage), §26 (factor architecture), §27 (calculation service), §29 (reporting engine), §20/§32 (UI + mobile), §44 (testing) |
