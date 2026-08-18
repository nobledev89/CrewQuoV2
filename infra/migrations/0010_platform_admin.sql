-- 0010_platform_admin.sql
-- Platform-wide administration evidence and typed settings foundation.

create table if not exists platform_audit_logs (
  id            uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users(id) on delete set null,
  action        text not null,
  entity_type   text not null,
  entity_id     text,
  changes       jsonb not null default '{}',
  description   text,
  created_at    timestamptz not null default now()
);

create index if not exists platform_audit_logs_created_at_idx
  on platform_audit_logs (created_at desc, id desc);
create index if not exists platform_audit_logs_actor_idx
  on platform_audit_logs (actor_user_id, created_at desc);

insert into system_settings (key, value)
values
  ('platform.branding', '{"platformName":"CrewQuo Platform","supportEmail":""}'::jsonb),
  ('platform.access', '{"registrationOpen":true,"maintenanceMode":false,"maintenanceMessage":""}'::jsonb)
on conflict (key) do nothing;

