-- 0005_portal_audit.sql
-- Phase 4 (CREWQUO_V2_PLAN.md §3.6): the client-portal surface — per-line-item
-- notes, an append-only audit trail, and the per-engagement settings that decide
-- what a client may see and do.
--
-- As with 0004, authorization (one-hop visibility, who may read a counterparty's
-- trail) is enforced in the API (src/authorization/policies.ts), not the DB.

-- Comments on a project / line item. Either side of an engagement may add one,
-- subject to audit_settings.client_can_comment for the client side.
create table if not exists line_item_notes (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  entity_type   text not null check (entity_type in ('PROJECT','TIME_LOG','EXPENSE','INVOICE')),
  entity_id     uuid not null,
  author_company_id uuid not null references companies(id),
  author_user_id    uuid not null references users(id),
  body      text not null,
  resolved  boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists line_item_notes_entity_idx on line_item_notes (entity_type, entity_id);
create index if not exists line_item_notes_engagement_idx on line_item_notes (engagement_id);

-- Append-only. The app never issues update/delete against this table; the only
-- deletes come from the nightly retention purge (apps/api/src/jobs/auditPurge.ts),
-- because Postgres has no row TTL.
--
-- expires_at is stamped at write time from the company's audit_retention_days
-- entitlement: 'infinity' when the plan grants unlimited retention. A company
-- whose retention is 0 gets no audit rows written at all.
create table if not exists audit_logs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade, -- whose activity
  actor_user_id uuid references users(id),
  action        text not null,                          -- e.g. 'time_log.approved'
  entity_type   text not null,
  entity_id     uuid,
  changes       jsonb,
  description   text,
  visible_to_client boolean not null default false,     -- may the upstream client see it?
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists audit_logs_company_created_idx on audit_logs (company_id, created_at desc);
create index if not exists audit_logs_expires_idx on audit_logs (expires_at);
create index if not exists audit_logs_entity_idx on audit_logs (entity_type, entity_id);

-- Per-engagement portal settings, owned by the provider side of the edge (the
-- company whose data is being exposed). Absent row = defaults below.
create table if not exists audit_settings (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade unique,
  client_can_comment boolean not null default true,
  show_audit_trail   boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
