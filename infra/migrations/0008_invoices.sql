-- 0008_invoices.sql
-- Phase 6 commercial-readiness foundation (CREWQUO_V2_PLAN.md §3.5, §42).
-- Invoice amounts are snapshots. The API derives work-backed lines from approved
-- records using the same BILL-rate path as project summaries, then recomputes
-- header totals after every item mutation.

create table if not exists invoices (
  id                      uuid primary key default gen_random_uuid(),
  engagement_id           uuid not null references engagements(id),
  issuer_company_id        uuid not null references companies(id),
  counterparty_company_id  uuid not null references companies(id),
  project_id               uuid references projects(id),
  number                   text,
  status                   text not null default 'DRAFT'
                             check (status in ('DRAFT','ISSUED','PAID','VOID')),
  currency                 text not null check (currency ~ '^[A-Z]{3}$'),
  subtotal_cents           integer not null default 0 check (subtotal_cents >= 0),
  tax_cents                integer not null default 0 check (tax_cents >= 0),
  total_cents              integer not null default 0 check (total_cents >= 0),
  issued_at                timestamptz,
  due_at                   timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check (issuer_company_id <> counterparty_company_id),
  check (total_cents = subtotal_cents + tax_cents),
  check ((status = 'DRAFT' and issued_at is null and number is null)
      or (status <> 'DRAFT' and issued_at is not null and number is not null))
);

create unique index if not exists invoices_issuer_number_uq
  on invoices (issuer_company_id, number) where number is not null;
create index if not exists invoices_issuer_created_idx
  on invoices (issuer_company_id, created_at desc);
create index if not exists invoices_counterparty_created_idx
  on invoices (counterparty_company_id, created_at desc);
create index if not exists invoices_project_idx on invoices (project_id);

create table if not exists invoice_items (
  id                uuid primary key default gen_random_uuid(),
  invoice_id        uuid not null references invoices(id) on delete cascade,
  description       text not null check (length(btrim(description)) > 0),
  quantity          numeric(10,2) not null default 1 check (quantity > 0),
  unit_amount_cents integer not null check (unit_amount_cents >= 0),
  amount_cents      integer not null check (amount_cents >= 0),
  source_type       text check (source_type in ('TIME_LOG','EXPENSE','MANUAL')),
  source_id         uuid,
  created_at        timestamptz not null default now(),
  check (amount_cents = round(quantity * unit_amount_cents)),
  check ((source_type in ('TIME_LOG','EXPENSE') and source_id is not null)
      or (source_type = 'MANUAL' and source_id is null))
);

create index if not exists invoice_items_invoice_idx on invoice_items (invoice_id);
create index if not exists invoice_items_source_idx
  on invoice_items (source_type, source_id) where source_id is not null;
