-- 0020_job_runs.sql
-- The record of scheduled work actually running, and the basis of the alarm for
-- its own absence (CREWQUO_V2_PLAN.md 2348).
-- Step 1 of the build order in docs/operating-model/observability-data-lifecycle.md 14.
--
-- THE GAP THIS CLOSES, AND IT IS THE MOST SERIOUS ONE IN PHASE 6. Three deferred
-- jobs exist - purge-audit, purge-auth and work - and they are deliberately
-- one-shot, on reasoning that is written down in workers.cli.ts and correct: an
-- external scheduler restarts a dead job, whereas a setInterval inside the API
-- stops the moment that process falls over and does nothing at all if the service
-- scales to zero.
--
-- Nothing scheduled them. render.yaml declared a web service and a database and
-- no cron of any kind, and neither did CI. So in a deployed environment the outbox
-- never drained - meaning no notification was ever delivered, by any channel - and
-- the audit retention that customers are SOLD as an entitlement was enforced by
-- nothing at all. The substrate was correct and inert.
--
-- This is the third time this phase has caught the same shape: 0012 built an
-- outbox nothing claimed from, 0016 wrote a pruner nothing called, and now three
-- jobs nothing scheduled. The caller keeps getting built; the thing that calls the
-- caller keeps not being.
--
-- WHY A TABLE RATHER THAN JUST A CRON. Because a cron is exactly as silent when it
-- stops as no cron at all, and the chosen host has a documented way of stopping:
-- GitHub disables a schedule trigger after 60 days without repository activity
-- (13.5). The failure mode of scheduled work is not a crash - it is silence, and
-- silence is indistinguishable from a quiet week. A row per pass turns "did it
-- run?" into a query, and "has it stopped?" into a comparison against a deadline.

-- 1. One row per pass ------------------------------------------------------------

create table if not exists job_runs (
  id            uuid primary key default gen_random_uuid(),

  -- The scheduled unit, not the function it called. 'workers' runs both the
  -- outbox drain and the notification delivery pass, because they are scheduled
  -- and fail together; splitting the name would let one report success for the
  -- pair.
  job           text not null check (job in ('workers', 'audit-retention', 'auth-retention')),

  started_at    timestamptz not null default now(),
  finished_at   timestamptz,

  -- RUNNING is a real state rather than a null finished_at with a guess attached.
  -- A pass that was killed mid-flight - a runner timing out, a deploy - leaves
  -- RUNNING behind, and that is a different fact from FAILED: nothing decided it
  -- went wrong, the process simply stopped existing. The overdue check treats it
  -- as "not a success", which is the only safe reading of either.
  outcome       text not null default 'RUNNING'
                check (outcome in ('RUNNING', 'SUCCEEDED', 'FAILED')),

  -- Counts, never contents. What the pass moved is operational data; what it
  -- moved it for is somebody's record, and a job log that quoted payloads would
  -- be a copy of the notification queue with weaker access control (7).
  claimed       integer not null default 0,
  succeeded     integer not null default 0,
  failed        integer not null default 0,

  -- The terminal reason, for a FAILED pass. An operator reads this; it is not
  -- shown to any customer, and nothing derived from a payload belongs in it.
  error         text,

  -- Correlates the pass with the request-scoped log lines it produced. Same id
  -- shape as the API's X-Request-Id so one search finds both halves of a story
  -- that starts in a request and finishes in a worker.
  run_id        uuid not null default gen_random_uuid()
);

-- The only query the alarm makes: the most recent successful pass per job. A
-- partial index because a run that failed or is still running answers nothing
-- about whether the schedule is alive.
create index if not exists job_runs_last_success_idx
  on job_runs (job, finished_at desc)
  where outcome = 'SUCCEEDED';

-- The operator console lists recent passes newest-first regardless of outcome.
create index if not exists job_runs_recent_idx on job_runs (job, started_at desc);

-- 2. Retention -------------------------------------------------------------------
--
-- These rows are operational (7): they are the record of the platform running,
-- not of any customer, so they carry the fixed 30-day retention rather than a
-- per-tenant setting. Pruned by the auth-retention pass, which already exists and
-- already runs on the same schedule - a new job to prune the job table would be
-- one more thing that can stop.
--
-- Deliberately NOT cascaded from anything and NOT tenant-scoped: there is no
-- company_id here because a pass is not done on behalf of a tenant, and inventing
-- one would make the platform's own heartbeat look like customer data.

comment on table job_runs is
  'One row per scheduled job pass. Operational data, 30-day retention, no tenant scope. The last SUCCEEDED row per job is what the overdue alarm reads.';
