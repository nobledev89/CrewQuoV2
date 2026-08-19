-- 0014_notifications.sql
-- Notifications and the Universal Action Centre (CREWQUO_V2_PLAN.md 42, 19.5).
-- Operating-model packet: docs/operating-model/notifications.md
--
-- What exists today is seven `void notifyCompanyManagers(...)` calls that fire an
-- Expo push and forget it. If the push fails, or the device is offline, or the
-- user never installed the app, the fact is gone: no record that anyone was told,
-- no list of what is outstanding, no second attempt. This is the durable version.
--
-- ONE TABLE, NOT TWO. The Action Centre is not a second system beside the inbox
-- - it is the *actionable subset* of the same per-recipient projection, marked by
-- `requires_action` and closed by `resolved_at`. A later phase adding "compliance
-- document expiring" adds a KIND, not a table. Two inboxes would eventually
-- disagree about what is outstanding, which is the one question an inbox exists
-- to answer.

-- 1. The durable per-recipient projection ---------------------------------------
-- `recipient_user_id` is nullable and `on delete set null` on purpose: deleting a
-- user must anonymise their inbox, not erase the company-side record that a thing
-- was raised and resolved. A null recipient matches no caller, so the read filter
-- stays correct without a special case.

create table if not exists notifications (
  id                  uuid primary key default gen_random_uuid(),
  recipient_user_id   uuid references users(id) on delete set null,
  company_id          uuid not null references companies(id) on delete cascade,
  kind                text not null,
  -- Frozen at write time from the facts as they were. A notification is a record
  -- of what somebody was told, so it is never edited into a different one; a
  -- reversal is a new row.
  title               text not null check (length(btrim(title)) > 0),
  body                text not null check (length(btrim(body)) > 0),
  subject_type        text,
  subject_id          uuid,
  action_url          text,
  requires_action     boolean not null default false,
  urgency             text not null default 'NORMAL'
                        check (urgency in ('NORMAL', 'URGENT')),
  -- `<topic>:<aggregateId>:<recipientUserId>`. The unique index is what makes a
  -- replayed outbox event produce one row per recipient and no more - the
  -- durable-delivery packet's "consumers must be idempotent" as a database
  -- guarantee rather than a promise in a handler.
  dedupe_key          text not null unique,
  read_at             timestamptz,
  resolved_at         timestamptz,
  resolved_by_user_id uuid references users(id) on delete set null,
  dismissed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- A notice with nothing to do cannot be resolved; only a task can.
  check (requires_action or resolved_at is null),
  -- Resolved and dismissed are different answers and cannot both be true.
  check (resolved_at is null or dismissed_at is null),
  -- The system may resolve an item nobody clicked (a colleague did the work), so
  -- a resolver is optional - but naming a resolver without a resolution is not.
  check (resolved_by_user_id is null or resolved_at is not null)
);

-- The inbox read, which is always scoped to one recipient in one company.
create index if not exists notifications_inbox_idx
  on notifications (recipient_user_id, company_id, created_at desc);

-- The Action Centre read: what is still outstanding for this person.
create index if not exists notifications_open_actions_idx
  on notifications (recipient_user_id, company_id, created_at desc)
  where requires_action and resolved_at is null and dismissed_at is null;

-- Resolving a task because somebody else did the work looks it up by subject.
create index if not exists notifications_subject_idx
  on notifications (subject_type, subject_id)
  where requires_action and resolved_at is null;

comment on table notifications is
  'One durable row per recipient per event. The actionable subset (requires_action) is the Universal Action Centre; later phases add kinds, not tables.';

-- 2. Channel delivery evidence ---------------------------------------------------
-- In-product delivery IS the row above, so only the intrusive channels appear
-- here. A retry is a new attempt on the same row, never a rewritten history.

create table if not exists notification_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  notification_id     uuid not null references notifications(id) on delete cascade,
  channel             text not null check (channel in ('EMAIL', 'PUSH')),
  status              text not null default 'PENDING'
                        check (status in ('PENDING', 'SENT', 'SKIPPED', 'FAILED')),
  -- SKIPPED is a real outcome, not a synonym for sent: "we did not send this, and
  -- here is why" is the difference between a diagnosable system and one where
  -- absence of evidence looks like success.
  skip_reason         text,
  provider_message_id text,
  error               text,
  attempts            integer not null default 0 check (attempts >= 0),
  -- Quiet hours defer the knock on the door. They never defer the inbox row.
  deliver_after       timestamptz not null default now(),
  sent_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check ((status = 'SENT') = (sent_at is not null)),
  check ((status = 'SKIPPED') = (skip_reason is not null)),
  unique (notification_id, channel)
);

create index if not exists notification_deliveries_due_idx
  on notification_deliveries (deliver_after, created_at)
  where status = 'PENDING';
create index if not exists notification_deliveries_failed_idx
  on notification_deliveries (updated_at desc)
  where status = 'FAILED';

comment on table notification_deliveries is
  'One row per notification per intrusive channel. In-product delivery is the notifications row itself and is never recorded here.';

-- 3. Per-user preferences ---------------------------------------------------------
-- Per-kind channel choices live in jsonb rather than a row per (user, kind,
-- channel): a new kind must not require a backfill for every existing user, and
-- an absent key means "use the kind's own default", which is a real answer.
--
-- `time_zone` is on the user because quiet hours are a property of the person,
-- and because company/project IANA zones are a later Phase 6 bullet - this does
-- not pre-empt that decision, it just refuses to guess UTC for a human being.

create table if not exists notification_preferences (
  user_id            uuid primary key references users(id) on delete cascade,
  time_zone          text not null default 'UTC',
  quiet_hours_start  time,
  quiet_hours_end    time,
  digest             text not null default 'IMMEDIATE'
                       check (digest in ('IMMEDIATE', 'HOURLY', 'DAILY')),
  channels           jsonb not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Half a quiet-hours window is not a window.
  check ((quiet_hours_start is null) = (quiet_hours_end is null))
);

comment on column notification_preferences.channels is
  'Per-kind overrides: {"work.submitted": {"email": false}}. An absent kind or channel means the kind default. Governs EMAIL and PUSH only - in-product delivery is never optional.';
