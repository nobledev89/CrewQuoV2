-- Planned vs actual (CREWQUO_V2_PLAN.md §30.2) — step 11.2 of the Phase 11 build
-- order in docs/operating-model/commercial-operations.md §14.
--
-- One table, ten money columns, and **one column §30.2 declares that is not
-- created**.
--
-- ── PACKET FINDING 1: THERE IS NO `currency` COLUMN ─────────────────────────
--
-- §30.2 declares `currency text not null` on a table with `unique (project_id)` —
-- one row per project. Migration `0017_one_currency_per_company.sql` removed
-- exactly this column from `rate_cards`, `rate_proposals` and `invoices`, and
-- PROGRESS records the reason in one line: *"a copy that can drift is worse than
-- no copy… two copies make 'which is authoritative?' a real question with no
-- answer."*
--
-- A budget's unit can only ever be `projects.reporting_currency`, which is ITSELF
-- THE PIN — a snapshot taken at creation precisely so a company that changes its
-- label next year cannot relabel a project that closed last year. A second
-- snapshot of a snapshot is not more careful; it is one more thing that can
-- disagree. §30.2's DDL predates the owner decision of 2026-08-19.
--
-- ── AND ACTUALS ARE NOT STORED, WHICH IS §30.2'S OWN RULE ──────────────────
--
-- *"Actuals are computed, never stored — storing them would create two sources of
-- truth that drift."* So there are ten `*_cents` columns and no `actual_*` columns
-- anywhere. Six of the ten have no source to be computed FROM (packet finding 2),
-- and the resolution is in `budgets.ts` rather than here: `actualCents` is null
-- rather than zero, and the row says what would have to exist. Nothing about that
-- is a schema decision, which is why this file is short.

create table if not exists project_budgets (
  id uuid primary key default gen_random_uuid(),

  -- One budget per project (§30.2's own `unique`), stated as a constraint rather
  -- than an index so the upsert can name it in `on conflict`.
  project_id uuid not null references projects(id) on delete cascade
    constraint project_budgets_one_per_project unique,

  -- `cascade` here where variations took `restrict`, and the difference is the
  -- point: a budget is a plan, and a plan for a deleted project is nothing. A
  -- variation is an agreement with a client and an invoice line behind it.
  company_id uuid not null references companies(id),

  -- No `currency`. See the header.

  revenue_cents       int not null default 0 check (revenue_cents >= 0),
  labour_cents        int not null default 0 check (labour_cents >= 0),
  subcontractor_cents int not null default 0 check (subcontractor_cents >= 0),
  vehicle_cents       int not null default 0 check (vehicle_cents >= 0),
  mileage_cents       int not null default 0 check (mileage_cents >= 0),
  waste_cents         int not null default 0 check (waste_cents >= 0),
  materials_cents     int not null default 0 check (materials_cents >= 0),
  purchases_cents     int not null default 0 check (purchases_cents >= 0),
  expenses_cents      int not null default 0 check (expenses_cents >= 0),
  other_cents         int not null default 0 check (other_cents >= 0),

  notes text,

  -- Nullable, for the fourth time (0030, 0034, 0040, 0045). §30.2 says `not null`;
  -- the closure promise of 2026-08-20 anonymises a person and preserves the record.
  created_by_user_id uuid references users(id) on delete set null,
  updated_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table project_budgets is
  'The project plan (§30.2). Actuals are computed and never stored, and there is deliberately NO currency column — a budget''s unit is projects.reporting_currency, and migration 0017 deleted exactly that duplicate from three other tables (commercial-operations.md finding 1).';
comment on column project_budgets.vehicle_cents is
  'Budgeted, and CrewQuo holds no source of actual vehicle spend — asset movements and activities carry mass, distance, fuel and energy and no money at all. The variance row reports "not tracked" rather than -100% (commercial-operations.md finding 2).';
comment on column project_budgets.notes is
  'Free text. A budget is the one commercial record here that anyone with commercial.manage may rewrite at any time with no supersession chain — it is a plan, and a plan that needs ceremony to revise is a plan people keep in a spreadsheet. Its history is record_revisions.';

create index if not exists project_budgets_company_idx
  on project_budgets (company_id, updated_at desc);
