-- 0012_durable_delivery.sql
-- One durable substrate for domain-event delivery, internal jobs and inbound webhooks.

create table delivery_outbox (
  id              uuid primary key default gen_random_uuid(),
  topic           text not null,
  aggregate_type  text not null,
  aggregate_id    text not null,
  company_id      uuid references companies(id) on delete set null,
  payload         jsonb not null default '{}',
  idempotency_key text not null unique,
  status          text not null default 'PENDING'
                  check (status in ('PENDING','PROCESSING','DELIVERED','DEAD_LETTER')),
  attempts        integer not null default 0 check (attempts >= 0),
  available_at    timestamptz not null default now(),
  locked_at       timestamptz,
  locked_by       text,
  last_error      text,
  delivered_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check ((status = 'PROCESSING') = (locked_at is not null and locked_by is not null)),
  check ((status = 'DELIVERED') = (delivered_at is not null))
);

create index delivery_outbox_claim_idx
  on delivery_outbox (available_at, created_at)
  where status = 'PENDING';
create index delivery_outbox_dead_idx
  on delivery_outbox (updated_at desc)
  where status = 'DEAD_LETTER';
create index delivery_outbox_aggregate_idx
  on delivery_outbox (aggregate_type, aggregate_id, created_at);

create table webhook_inbox (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null,
  external_event_id text not null,
  event_type        text not null,
  body_sha256       text not null,
  payload           jsonb not null,
  status            text not null default 'RECEIVED'
                    check (status in ('RECEIVED','PROCESSING','PROCESSED','DEAD_LETTER')),
  attempts          integer not null default 0 check (attempts >= 0),
  available_at      timestamptz not null default now(),
  locked_at         timestamptz,
  locked_by         text,
  last_error        text,
  processed_at      timestamptz,
  received_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (provider, external_event_id),
  check ((status = 'PROCESSING') = (locked_at is not null and locked_by is not null)),
  check ((status = 'PROCESSED') = (processed_at is not null))
);

create index webhook_inbox_claim_idx
  on webhook_inbox (available_at, received_at)
  where status = 'RECEIVED';
create index webhook_inbox_dead_idx
  on webhook_inbox (updated_at desc)
  where status = 'DEAD_LETTER';

comment on table delivery_outbox is
  'Events/jobs inserted in the same transaction as their domain mutation; claimed with SKIP LOCKED.';
comment on table webhook_inbox is
  'Only signature-verified webhook payloads enter this table; provider event ids deduplicate delivery.';
