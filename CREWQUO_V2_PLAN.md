# CrewQuo v2 — Complete Build Specification

> **Status:** Approved (direction greenlit 2026-07-20). Build may begin at Phase 0.
> **Decision:** Greenfield rebuild. v2 is a **new, independent product** with **no runtime connection to v1**. v1 (Next.js + Firebase) stays live and frozen. No shared database, no shared auth, no data migration in scope (see §12 for optional later onboarding).

---

## 0. For the implementing agent — read this first

You can build v2 from this document plus two files from the v1 repo. Do this before writing code:

1. **Read `firestore.rules`** (repo root) — the authoritative source of v1's access rules. §4 here is the port; if anything is ambiguous, the rules file is ground truth for intended behavior.
2. **Read `functions/src/rates.ts`** — the rate/margin engine. §6 here says to port it *verbatim*; that file is the exact logic.
3. **Treat this document's DDL (§3) and API contract (§7) as canonical.** They are fully specified — do not invent alternative shapes.
4. **Build phase-by-phase (§11). Do not batch phases.** Each phase is independently demoable and testable. Ship and verify one before starting the next.
5. **This is a new repo (`crewquo-v2`), not this one.** Nothing from the v1 Next.js/Firebase codebase is imported — only the *domain rules* carry over.
6. **When a genuine product decision is unspecified, stop and ask the user** rather than guessing. The open items are listed in §17; everything else is decided.
7. **What this spec does NOT contain:** final visual design (spacing, colors, copy) and per-screen pixel layout. Screen *inventory, purpose, data, and actions* are specified (§8/§9); the visual polish is produced during build against the design tokens in `packages/ui`.

Conventions used in the DDL: every table has `id uuid primary key default gen_random_uuid()`, `created_at timestamptz not null default now()`, and `updated_at timestamptz not null default now()` unless stated otherwise. Enumerated values are `text` columns with `CHECK` constraints (easier to migrate than native enums); allowed values are listed inline. Money is stored as integer minor units (`*_cents`) unless noted. All foreign keys are `not null` unless marked `nullable`.

---

## 1. Why we are doing this

v1 works but is hard to use and hard to evolve. The complexity comes from two sources:

1. **The data is deeply relational, but Firestore is a document store.** Companies → engagements → projects → rate cards → time logs → invoices is textbook SQL. Firestore forces denormalization, fan-out reads, and duplicated writes.
2. **Authorization lives in custom claims + security rules.** v1's git history is dominated by claims/access bugs (`refresh-all-claims`, `grant-project-access`, `diagnose-client-access`, "Firestore undefined value error"). The `ownCompany`/`activeCompany`/`subcontractorRoles` context-switching is spread across JWT claims and `firestore.rules` — the main source of fragility.

Moving authorization into an **API layer backed by Postgres** collapses that class of problem: access checks become SQL `WHERE` clauses and middleware — one source of truth, testable in isolation.

### Goals
- **Mobile-first.** Expo (React Native) is the primary client; web is secondary (heavy admin + client portal).
- **Straight to the point.** Fewer screens, fewer taps, opinionated default flows.
- Own the backend: Postgres + a TypeScript API on Render, deployable and debuggable end to end.
- Keep what's genuinely good in v1: the **rate/margin engine** and the **PAY vs BILL** model.

### Non-goals (v2.0)
- Migrating v1 production data (v1 stays live).
- Feature parity on day one — ship the core loop first (§11).
- Real-time collaboration / live sync.
- Offline-first mobile (deferred to Phase 6).

---

## 2. Target architecture

Single Turborepo monorepo, pnpm workspaces.

```
crewquo-v2/
├─ apps/
│  ├─ mobile/        Expo + expo-router (PRIMARY client)
│  ├─ web/           Next.js on Vercel (admin + client portal + super-admin console)
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
| Exports | **Server-side `jspdf`/`xlsx` in `apps/api`** | Identical files for web + mobile. |
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

## 5. Auth (replacing Firebase Auth)

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

### Seed plans (editable rows, not constants)

| Plan | Price (USD/mo, billed yearly) | operates_downstream | active_subcontractors | internal_seats | audit_retention_days | features |
|---|---|---|---|---|---|---|
| **Crew** | 0 | false | 0 | 1 | 0 | (provider-only: log & submit up) |
| **Starter** | 39 | true | 5 | 2 | 30 | rate_cards, holiday_rates, exports, client_portal |
| **Pro** ⭐ | 119 | true | 30 | 8 | 90 | + client_portal_notes, invoicing, audit_visibility |
| **Business** | 349 | true | 150 | 25 | 365 | + api_access, sso, white_label |
| **Enterprise** | custom | true | unlimited | unlimited | unlimited | all |

Monthly (no annual commit) ≈ +20%. Trial: 14 days on paid plans, no card. Metering axis = **active subcontractors** only; client portal is a feature gate, not a second meter. "Be a subcontractor" (Crew) is free forever — the growth funnel. Placeholder clients are free/unlimited (only real portal logins count toward `clients`).

### Billing — Merchant of Record (required: PH-based seller, no local business permit)
Stripe-direct (PH unsupported) and local PH gateways (need DTI/SEC) are ruled out. Use an **MoR** — the provider is the legal seller, so no permit is needed and they handle global VAT/GST.
- **Lemon Squeezy — primary** (SaaS-native, Stripe-owned as of 2026, bank/PayPal payouts, easy onboarding).
- **Paddle — alternative at scale** (needs live pricing + ToS + Privacy + Refund pages to verify).
- Backups: Polar, Dodo Payments.

CrewQuo plans are the source of truth; mirror each `plan_price` to a provider product (`provider_price_id`), use hosted checkout, consume webhooks to sync `company_subscriptions.status`. **Caveats:** MoR still needs KYC + W-8BEN + a payout method (bank/PayPal/Wise/Payoneer — verify PH is listed); fees ≈ 5%; launch with **hard caps** (MoR handles metered billing poorly); the seller's personal PH (BIR) income tax is separate — advise an accountant.

### Grandfathering
On purchase/renewal, snapshot effective entitlements into `company_subscriptions.entitlements_snapshot`. A plan edit affects only new subscribers unless the super admin explicitly "apply to existing."

---

## 6. Rate engine (port `functions/src/rates.ts` verbatim)

Move v1's [functions/src/rates.ts](functions/src/rates.ts) into `packages/shared/src/rate-engine/` as **pure functions over plain data** (no DB imports). The API loads rate cards from Postgres and passes them in. Preserve exactly:

- **`shiftTypeToRateLabel`** mapping — and the DB code equivalence:
  `WEEKDAY_DAY→MON_FRI_DAY`, `NIGHT→MON_THU_NIGHT`, `SUNDAY→SUNDAY`, `SHIFT→SHIFT`, `DAILY→DAILY`. (The `FRI_SAT_NIGHT` label exists for rate cards but is selected by date logic, matching v1's display labels.)
- **`RateResolver.resolveRate`** → SQL query for candidate cards (`company_id, kind, role_id, rate_label, effective_from <= date` ordered `effective_from desc`) + the effective-date selection loop (pick most recent where `effective_to` is null or `>= date`).
- **`extractRate`** per `rate_mode` — HOURLY: `otRate = ot_hourly_rate ?? base*1.5`; SHIFT/DAILY: no OT.
- **`PriceCalculator.calculate`** — SHIFT/DAILY treated as units; `margin = clientBill − subCost`; `marginPct`; round to cents.
- **`applyMinHours`**.
- **`getHolidayInfo`** + holiday multipliers, reading `rate_card_templates.timeframe_definitions` (`type:'holiday'`, `holidayDates:string[]`, `holidayMultiplier`).

Add a Vitest suite pinning **every branch** — this is the highest-value, lowest-risk port and the one place v1 had real bugs (weekend/holiday labels).

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

# Rate engine
CRUD   /v1/role-catalog
CRUD   /v1/rate-card-templates
CRUD   /v1/rate-cards                              -- BILL cards never returned to provider side
GET    /v1/rates/resolve?roleId&shiftType&date&counterpartyId&kind   -- resolved rate (uses §6)

# Projects & work
CRUD   /v1/projects
POST   /v1/projects/:id/assignments               -- assign a provider (+engagement)
GET    /v1/projects/:id/summary                   -- server-computed costs, margins, totals
GET    /v1/projects/:id/export.(pdf|xlsx)         -- server-rendered file (feature: exports)
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

# Super-admin (isSuperAdmin only)
CRUD   /v1/admin/plans  /v1/admin/plans/:id/prices  /v1/admin/features  /v1/admin/limits
GET    /v1/admin/companies  POST /v1/admin/companies/:id/overrides  POST /v1/admin/companies/:id/comp-trial
```

---

## 8. Mobile app (Expo — primary)

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

Notifications: push on submit / approve / reject. Offline draft capture = Phase 6.

---

## 9. Web app (Vercel)

Next.js (App Router). Handles the heavy work awkward on a phone. Shares `packages/shared` + `packages/api-client` with mobile — **no business logic duplicated.** Auth via httpOnly cookies (SSR-friendly).

**Areas:** Auth pages · Dashboard · **Rate cards & templates** (the big tables) · Projects + assignments + summaries · Time/expense review at scale · **Client portal** (line items, notes, audit trail, exports) · **Invoices** · Reports · Company & members admin · **Super-admin console** (§5B) · **Public marketing + legal pages** (pricing, terms, privacy, refunds) for MoR verification.

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

**Phase 2 — Rate engine + catalog.** Port `rates.ts` into `packages/shared` with full Vitest coverage. `role_catalog`, `rate_card_templates`, `rate_cards` (PAY/BILL, no per-card currency), holiday timeframes, `/v1/rates/resolve`. Web screens to manage them. *Milestone: rates resolve for a date+shift with correct margins.*

**Phase 3 — The core loop (mobile-first).** `engagements`, `providers`, `projects`, `project_assignments`, `invites` (create provider + accept). `time_logs` + `expenses` with `DRAFT→SUBMITTED→APPROVED/REJECTED`. Mobile: log time → submit; approvals inbox. `/projects/:id/summary`. *Milestone: a subcontractor logs time on a phone and an admin approves it — the product's heartbeat.*

**Phase 4 — Client portal + exports + audit.** Client-side portal via engagements + `projects.client_visible`; `line_item_notes`, `audit_logs` (+ nightly `expires_at` cleanup job), `audit_settings`. Server-side PDF/XLSX exports. Web portal + placeholder→linked company **merge flow**. *Milestone: a client logs in, sees only granted projects + visible audit trail, downloads an export.*

**Phase 5 — Billing, invoicing, notifications, polish.** `invoices`/`invoice_items`. **MoR billing** (Lemon Squeezy/Paddle): checkout, webhooks, trial→paid, entitlement snapshots. Super-admin price editor + subscription management. Push + email notifications. Reports. EAS store submission. Public marketing + legal pages.

**Phase 6 (deferred).** Offline draft capture, real-time updates, and the optional v1→v2 per-customer importer (§12).

---

## 12. Relationship to v1

v2 is a **new Firebase-free product** with its own DB, auth, and app; v1 runs untouched. **No live coupling** (no shared tokens, dual-writes, or sync). **Optional future importer (Phase 6):** a one-off ETL reading a v1 company's Firestore export into v2 Postgres, run per-customer on request. v2's schema is a clean superset, so it's well-scoped — but it is not part of v2.0 and not a runtime dependency.

---

## 13. Testing strategy

- **`packages/shared` (rate engine):** exhaustive Vitest unit tests — pin every branch before any UI depends on it.
- **API:** integration tests against a throwaway Postgres (Vitest + testcontainers, or a scratch Render DB). **One test per v1 `firestore.rules` rule** asserting the same allow/deny — this proves authorization parity.
- **Mobile/web:** component tests for core flows + E2E happy-paths (Playwright web, Maestro mobile) for login → log time → approve.
- **CI gate:** lint + type-check + unit + API integration on every PR; block merge on failure.

---

## 14. Key risks & mitigations

| Risk | Mitigation |
|---|---|
| Scope balloons into v1 parity chase | Ship Phase-3 core loop first; everything else additive; non-goals firm. |
| Rate-engine regressions | Port pure logic verbatim + pin every branch before building on it. |
| Authorization gaps vs v1 | One policy module; one test per `firestore.rules` rule. |
| One-hop leak (a company sees past its edge) | Central engagement-scope check; explicit deny tests at depth ≥ 2. |
| `activeCompany` context bugs (v1's pain) | `memberships` rows + per-request context; nothing to go stale. |
| MoR payout/verification friction | Confirm PH payout method up front; keep Paddle as fallback to Lemon Squeezy. |
| Two apps during transition | v1 frozen (bug-fix only); no feature work on v1. |

---

## 15. Reconciliation notes (what changed from the earlier draft)

This spec resolves contradictions that existed while the plan evolved: (a) the old v1 client model (`client_organizations`/`client_users`/`contractor_client_relationships`/`client_project_access`) is **removed** — clients are `companies` reached via `engagements`; (b) `time_logs`/`expenses`/`invoices` now carry `engagement_id` and company-graph FKs instead of v1's `subcontractor_id`/`client_id`; (c) `currency` removed from `rate_cards` (inherited from company); (d) `plan_tier`/`PREMIUM`/`CLIENT` role references replaced by entitlements + `operates_downstream` and the OWNER/ADMIN/MANAGER/MEMBER role set; (e) all external-context references removed so this file is self-contained.

---

## 16. Decisions (locked)

1. **DB code:** raw `pg`; adopt Drizzle later only if queries get painful.
2. **App ↔ server:** REST + Zod.
3. **File storage:** Cloudflare R2.
4. **Login:** email/password + Google sign-in.
5. **Currency:** one per company; rate cards inherit.
6. **Repo:** new `crewquo-v2`.
7. **Parties are a company graph** (`companies` + `engagements`); client/subcontractor are relative, reversible; no separate client/sub tables.
8. **One-hop visibility;** operate-downstream is a paid capability.
9. **Plans are super-admin-configurable data** (entitlements engine); metering axis = active subcontractors; portal is a feature gate.
10. **Billing via Merchant-of-Record** (Lemon Squeezy primary, Paddle alt); hard-cap tiers.
11. **Membership roles:** OWNER/ADMIN/MANAGER/MEMBER; positions (client/provider) come from engagements.

---

## 17. Open items (ask the user before building the affected phase)

- **Exact seed pricing per currency** — §5B has USD anchors; confirm real numbers + which currencies to localize (affects `plan_prices` seed, Phase 1/5).
- **Placeholder→linked merge policy** — when "PwC" later signs up, auto-suggest merge vs manual admin action; how to re-point existing engagements (Phase 4).
- **MoR final choice** — Lemon Squeezy vs Paddle — and confirmed PH payout method (Phase 5).
- **Rate-label date logic for `FRI_SAT_NIGHT`** — confirm the weekday/date rules that select this label vs `MON_THU_NIGHT` (mirror v1 exactly; verify against `rates.ts` when porting, Phase 2).
- **Visual design system** — brand colors/typography for `packages/ui` (needed once UI work starts, Phase 2+).

---

## 18. Immediate next step

**Phase 0 scaffold:** create the `crewquo-v2` monorepo (turbo + pnpm workspaces), stand up `apps/api` + Render Postgres + the migration runner + `/healthz`, and land the first `packages/shared` Zod schemas + the `schema_migrations` table. That gives a deployable skeleton to build every phase on.
