-- The artifact-class lifecycle deferred by Phase 7 and due in Phase 12.
-- Rows remain as business evidence; only bytes age out. Frozen reports/sign-offs
-- are holds, and object deletion is durable work rather than a best-effort side effect.

alter table stored_files
  add column if not exists retention_class text generated always as (
    case
      when kind = 'SIGNATURE' or project_id is null then 'PERMANENT'
      when kind = 'EXPORT' then 'TEMPORARY'
      else 'PROJECT'
    end
  ) stored;

alter table stored_files drop constraint if exists stored_files_retention_class_check;
alter table stored_files add constraint stored_files_retention_class_check
  check (retention_class in ('TEMPORARY','PROJECT','PERMANENT'));

create index if not exists stored_files_retention_candidates_idx
  on stored_files (retention_class, created_at)
  where status = 'READY' and variant = 'ORIGINAL';

create table if not exists artifact_deletion_queue (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references stored_files(id) on delete cascade,
  bucket_key text not null unique,
  status text not null default 'PENDING' check (status in ('PENDING','DELETED')),
  attempts int not null default 0 check (attempts >= 0),
  last_error_class text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists artifact_deletion_queue_pending_idx
  on artifact_deletion_queue (created_at) where status = 'PENDING';

-- A new immutable snapshot may not cite bytes already reclaimed. Taking a row
-- lock here serializes the check with the sweep's READY -> DELETED transition.
create or replace function report_file_reference_requires_ready_file()
returns trigger language plpgsql as $$
declare file_status text;
begin
  select status into file_status from stored_files where id = new.file_id for key share;
  if file_status is distinct from 'READY' then
    raise exception 'a frozen document may reference only a ready file';
  end if;
  return new;
end;
$$;
drop trigger if exists report_file_references_ready_file on report_file_references;
create trigger report_file_references_ready_file
  before insert or update of file_id on report_file_references
  for each row execute function report_file_reference_requires_ready_file();

insert into limits (key, name, description, unit, unlimited_allowed) values
  ('artifact_retention_days', 'Completed-project artifact retention',
   'Days completed-project evidence and document bytes remain available; immutable document holds override it',
   'days', true)
on conflict (key) do update set
  name = excluded.name, description = excluded.description, unit = excluded.unit;

-- Joined against `plans` rather than naming ids in a values list. NO MIGRATION
-- INSERTS `plans` — only infra/seed/index.ts does — so on a genuinely fresh
-- database the literal form violates plan_limits_plan_id_fkey and stops the whole
-- run here, leaving every later migration unapplied. This yields no rows on an
-- empty `plans`, which is the shape 0033, 0038 and 0043 already use for
-- plan_features, and the seed is the authority for placement either way.
--
-- Forward-only-safe: schema_migrations records filenames, so an already-migrated
-- database re-runs nothing and this edit changes behaviour only where it is
-- currently broken.
insert into plan_limits (plan_id, limit_key, value)
select p.id, k.key, k.value
from plans p
join (values
  ('crew',       'artifact_retention_days', 365),
  ('starter',    'artifact_retention_days', 1095),
  ('pro',        'artifact_retention_days', 2555),
  ('business',   'artifact_retention_days', 2555),
  ('enterprise', 'artifact_retention_days', null::int)
) as k(id, key, value) on k.id = p.id
on conflict (plan_id, limit_key) do update set value = excluded.value;
