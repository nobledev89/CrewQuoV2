-- Capability layer (CREWQUO_V2_PLAN.md §37) — step 0 of the Phase 7 build order
-- in docs/operating-model/project-evidence.md §14.
--
-- WHY THIS IS FIRST, AHEAD OF THE STORAGE SERVICE THE PLAN OPENS PHASE 7 WITH.
-- Two reasons, and the second is the one that decided it. Every route Phase 7
-- adds needs `hasCapability` beside its existing `hasFeature`, and authorization
-- is the cheapest thing in the world to design in and the most expensive to
-- retrofit — the same argument decision #22 makes for the offline contract. And
-- this item is the only one of the phase's first three that needs no answer from
-- the owner, while the storage service is blocked on four open questions in the
-- packet's §13. A build order whose first step waits on a decision stalls at
-- step 1.
--
-- WHAT DOES NOT CHANGE. The four membership roles keep their meaning and every
-- existing check keeps working. `memberships.bundle_key` lands nullable and
-- every existing row keeps its null, which §37 defines as "derive from the
-- role" — so a company sees no difference until somebody deliberately assigns a
-- bundle. Nothing in this migration gates an existing route.
--
-- THE DIVISION OF LABOUR IS THE ENTITLEMENTS ENGINE'S, DELIBERATELY. The keys
-- live in code (`packages/shared/src/capabilities.ts`), the way `FEATURE_KEYS`
-- does, because adding one is a deliberate edit plus an enforcement hook. The
-- membership lives here, the way `plan_features` does, because a company builds
-- its own bundles without a deploy.

-- ── 1. The enforcement surface ────────────────────────────────────────────────
--
-- §37's 29 keys. `category` groups them for a permissions screen and carries no
-- authorization meaning — a route names a key, never a category, or the grouping
-- becomes a second and weaker way to grant something.

create table if not exists capabilities (
  key         text primary key,
  name        text not null,
  description text,
  category    text not null,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

insert into capabilities (key, name, description, category, sort_order) values
  ('project.read',                    'Read projects',            'See projects they are assigned to, and their records',                'Projects',       10),
  ('project.manage',                  'Manage projects',          'Create, edit, archive projects and their locations',                  'Projects',       20),
  ('schedule.manage',                 'Manage the schedule',      'Assign crew and vehicles to days',                                    'Projects',       30),
  ('crew.manage',                     'Manage crew',              'Assign people to projects and manage assignments',                    'Projects',       40),
  ('time.log.own',                    'Log own time',             'Record their own hours',                                             'Time and cost',  50),
  ('time.review',                     'Review time',              'Approve or return submitted time',                                    'Time and cost',  60),
  ('expense.log',                     'Log expenses',             'Record their own expenses',                                          'Time and cost',  70),
  ('expense.review',                  'Review expenses',          'Approve or return submitted expenses',                               'Time and cost',  80),
  ('diary.write',                     'Write the site diary',     'Create and edit the day''s entry while it is open',                   'Site',           90),
  ('diary.close',                     'Close the day',            'Close a diary entry, and amend a closed one with a reason',           'Site',          100),
  ('evidence.upload',                 'Upload evidence',          'Add photos and files to a project',                                  'Evidence',      110),
  ('evidence.manage',                 'Manage evidence',          'Edit metadata on evidence uploaded by anyone',                        'Evidence',      120),
  ('evidence.publish',                'Publish evidence',         'Decide what the client can see',                                     'Evidence',      130),
  ('document.upload',                 'Upload documents',         'Add project documents',                                             'Documents',     140),
  ('document.manage',                 'Manage documents',         'Supersede versions and manage categories and expiry',                'Documents',     150),
  ('asset.write',                     'Record assets',            'Enter and edit asset lines and quantities',                          'Assets',        160),
  ('asset.destination.set',           'Set destinations',         'Record where material went',                                         'Assets',        170),
  ('asset.weight.verify',             'Verify weights',           'Raise a weight to documented or verified confidence',                'Assets',        180),
  ('sustainability.read',             'Read sustainability',      'See mass balance, rates and carbon figures',                         'Sustainability',190),
  ('sustainability.factors.manage',   'Manage emission factors',  'Import and curate factor sets and product factors',                  'Sustainability',200),
  ('sustainability.settings.manage',  'Manage sustainability settings', 'Change the assumptions calculations run under',                'Sustainability',210),
  ('variation.create',                'Raise variations',         'Create variation requests',                                          'Commercial',    220),
  ('variation.approve',               'Approve variations',       'Approve or reject variations',                                       'Commercial',    230),
  ('commercial.read',                 'Read commercial figures',  'See rates, cost, bill and margin',                                   'Commercial',    240),
  ('commercial.manage',               'Manage commercial terms',  'Manage rate cards, proposals and engagement terms',                  'Commercial',    250),
  ('invoice.manage',                  'Manage invoices',          'Create, issue and void invoices',                                    'Commercial',    260),
  ('signoff.capture',                 'Capture sign-off',         'Take a client signature against a project',                          'Reporting',     270),
  ('report.generate',                 'Generate reports',         'Produce reports and evidence packs',                                 'Reporting',     280),
  ('compliance.manage',               'Manage compliance',        'Manage compliance documents and their alerts',                       'Compliance',    290)
on conflict (key) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  sort_order = excluded.sort_order;

-- ── 2. Bundles ────────────────────────────────────────────────────────────────
--
-- `company_id is null` is a system bundle, shared by every company and not
-- editable by any of them — the same shape `asset_types` will use in Phase 8 and
-- the same shape the plan catalog already uses. A company bundle shadows nothing;
-- it is a separate key in its own namespace.

create table if not exists capability_bundles (
  key         text primary key,
  name        text not null,
  description text,
  company_id  uuid references companies(id) on delete cascade,
  is_system   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- A system bundle has no company and a company bundle is not a system bundle.
  -- Without this, a company could own a row every other company resolves through.
  constraint capability_bundles_system_has_no_company
    check ((is_system and company_id is null) or (not is_system and company_id is not null))
);

create index if not exists capability_bundles_company_idx
  on capability_bundles (company_id) where company_id is not null;

create table if not exists capability_bundle_items (
  bundle_key     text not null references capability_bundles(key) on delete cascade,
  capability_key text not null references capabilities(key),
  primary key (bundle_key, capability_key)
);

insert into capability_bundles (key, name, description, company_id, is_system) values
  ('admin',           'Admin',                      'Everything the company can do',                                    null, true),
  ('project_manager', 'Project Manager',            'Runs projects end to end, including commercial figures',            null, true),
  ('supervisor',      'Supervisor',                 'Runs the site day. Deliberately cannot see commercial figures',     null, true),
  ('worker',          'Worker',                     'Logs their own time and expenses and adds evidence',                null, true),
  ('finance',         'Finance',                    'Commercial figures, invoices and review, without site operations',  null, true),
  ('sustainability',  'Sustainability / Compliance','Assets, weights, factors, documents and compliance',                null, true)
on conflict (key) do update set
  name = excluded.name,
  description = excluded.description;

-- §37's bundle table. Every one of these is a superset of `worker`, which is the
-- rule that keeps the default mapping in section 4 below from removing an
-- ability somebody already has: §37's rows are summaries of a job function, and
-- read literally they produce a Finance user who cannot log their own hours.
-- The list is mirrored in `SYSTEM_BUNDLE_CAPABILITIES` and a test asserts the
-- two agree, so neither can drift.
insert into capability_bundle_items (bundle_key, capability_key)
select 'admin', key from capabilities
on conflict do nothing;

insert into capability_bundle_items (bundle_key, capability_key) values
  -- worker — the floor every other bundle contains
  ('worker', 'project.read'),
  ('worker', 'time.log.own'),
  ('worker', 'expense.log'),
  ('worker', 'evidence.upload'),

  -- supervisor: the whole reason this layer exists. Everything needed to run a
  -- site day, and NO `commercial.read` — today the only way to let somebody
  -- close a day is to let them see what the job is worth. No
  -- `asset.weight.verify` either: §25.3 makes a verified weight a documented
  -- claim, which is the sustainability function's job.
  ('supervisor', 'project.read'),
  ('supervisor', 'time.log.own'),
  ('supervisor', 'expense.log'),
  ('supervisor', 'evidence.upload'),
  ('supervisor', 'diary.write'),
  ('supervisor', 'diary.close'),
  ('supervisor', 'asset.write'),
  ('supervisor', 'asset.destination.set'),
  ('supervisor', 'variation.create'),
  ('supervisor', 'signoff.capture'),

  -- project_manager
  ('project_manager', 'project.read'),
  ('project_manager', 'time.log.own'),
  ('project_manager', 'expense.log'),
  ('project_manager', 'evidence.upload'),
  ('project_manager', 'project.manage'),
  ('project_manager', 'schedule.manage'),
  ('project_manager', 'crew.manage'),
  ('project_manager', 'time.review'),
  ('project_manager', 'expense.review'),
  ('project_manager', 'diary.write'),
  ('project_manager', 'diary.close'),
  ('project_manager', 'evidence.manage'),
  ('project_manager', 'evidence.publish'),
  ('project_manager', 'document.upload'),
  ('project_manager', 'document.manage'),
  ('project_manager', 'asset.write'),
  ('project_manager', 'asset.destination.set'),
  ('project_manager', 'asset.weight.verify'),
  ('project_manager', 'sustainability.read'),
  ('project_manager', 'variation.create'),
  ('project_manager', 'variation.approve'),
  ('project_manager', 'commercial.read'),
  ('project_manager', 'commercial.manage'),
  ('project_manager', 'signoff.capture'),
  ('project_manager', 'report.generate'),

  -- finance: commercial and review, and NO `diary.close`
  ('finance', 'project.read'),
  ('finance', 'time.log.own'),
  ('finance', 'expense.log'),
  ('finance', 'evidence.upload'),
  ('finance', 'time.review'),
  ('finance', 'expense.review'),
  ('finance', 'variation.approve'),
  ('finance', 'commercial.read'),
  ('finance', 'commercial.manage'),
  ('finance', 'invoice.manage'),
  ('finance', 'report.generate'),

  -- sustainability / compliance: the weights and destinations that back a
  -- reported tonne, plus the documents that turn an estimate into a documented
  -- figure. `asset.weight.verify` lives here rather than with the supervisor.
  ('sustainability', 'project.read'),
  ('sustainability', 'time.log.own'),
  ('sustainability', 'expense.log'),
  ('sustainability', 'evidence.upload'),
  ('sustainability', 'document.upload'),
  ('sustainability', 'document.manage'),
  ('sustainability', 'asset.write'),
  ('sustainability', 'asset.destination.set'),
  ('sustainability', 'asset.weight.verify'),
  ('sustainability', 'sustainability.read'),
  ('sustainability', 'sustainability.factors.manage'),
  ('sustainability', 'sustainability.settings.manage'),
  ('sustainability', 'compliance.manage'),
  ('sustainability', 'report.generate')
on conflict do nothing;

-- ── 3. Assignment ─────────────────────────────────────────────────────────────
--
-- Nullable, with no default and no backfill. §37's "null ⇒ derive from role" is
-- what makes this migration behaviour-preserving, so writing a bundle into every
-- existing row would be the one change this file must not make: it would freeze
-- today's derived answer as an explicit assignment, and a later correction to
-- the default mapping would then reach nobody.
--
-- `on delete set null` rather than restrict: retiring a company bundle must not
-- be refused because somebody is using it, and the membership falls back to its
-- role-derived answer, which is a safe place to land rather than an empty one.

alter table memberships
  add column if not exists bundle_key text references capability_bundles(key) on delete set null;

create index if not exists memberships_bundle_key_idx
  on memberships (bundle_key) where bundle_key is not null;

-- ── 4. Per-membership exceptions ──────────────────────────────────────────────
--
-- The primary key is the concurrency control and the duplicate guard at once:
-- two rows for one (membership, capability) would let insertion order silently
-- decide a permission, which is the defect overlapping rate-label rules were
-- rejected for in Phase 2.

create table if not exists membership_capability_overrides (
  membership_id  uuid not null references memberships(id) on delete cascade,
  capability_key text not null references capabilities(key),
  granted        boolean not null,
  note           text,
  created_by_user_id uuid references users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (membership_id, capability_key)
);

create index if not exists membership_capability_overrides_membership_idx
  on membership_capability_overrides (membership_id);
