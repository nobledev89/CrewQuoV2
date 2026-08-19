-- 0016_access_hardening.sql
-- Authentication rate limiting (CREWQUO_V2_PLAN.md 42).
-- Operating-model packet: docs/operating-model/access.md
--
-- The hole this closes, stated plainly: `POST /v1/auth/login` had NO rate limit
-- of any kind, against a population of accounts that all have exactly one
-- factor. `RATE_LIMITED` existed as an error code and exactly one route in the
-- whole API threw it - company-creation requests. An attacker with a
-- credential-stuffing list had as many free guesses as their bandwidth allowed,
-- and nothing anywhere recorded that the guessing happened.
--
-- WHY POSTGRES AND NOT AN IN-MEMORY COUNTER. Two reasons, and the second is the
-- one that decided it. The API runs more than one instance, so a per-process
-- counter is silently multiplied by the instance count and the limit is a lie
-- proportional to how well the product is doing. And this phase has already
-- committed to moving derived state OFF process-local storage - the outbox
-- scheduler and every lazy expiry - so a new process-local dependency would be
-- work to undo. There is no Redis in this stack and this does not justify one.
--
-- WHAT IS DELIBERATELY NOT STORED. No password, no attempted password, no
-- length, no prefix, nothing derived from one. A rate-limit table that records
-- anything about the secret being guessed turns a nuisance breach into a
-- catastrophic one. The source is stored HASHED for the same reason a refresh
-- token is: this table would otherwise be a log of which addresses signed in
-- from where, which is exactly the location history the packet's 7 refuses to
-- build.

create table if not exists auth_attempts (
  id            bigserial primary key,
  scope         text not null check (scope in ('LOGIN', 'RESET', 'REGISTER')),

  -- The normalised email the attempt was aimed at, lower-cased and trimmed by
  -- the caller. Null only where the scope has no identity to key on.
  --
  -- NOT a foreign key to `users`, on purpose and importantly: most failed
  -- attempts name an address that has no account, and those are precisely the
  -- ones worth counting. A reference here would make the table unable to record
  -- the attack it exists to detect.
  identity_key  text,

  -- SHA-256 of the caller's address. Hashed rather than stored, because the
  -- limiter needs to know "same source again?" and never needs to know who.
  source_key    text not null,

  -- Only failures consume budget (`rateLimitDecision` counts these alone), but
  -- successes are recorded too: without them there is no denominator, and
  -- "logins failing" cannot be told apart from "nobody is logging in".
  succeeded     boolean not null default false,

  occurred_at   timestamptz not null default now()
);

-- One index per budget, both descending on time, because every query is
-- "how many in the last N seconds" against one key.
create index if not exists auth_attempts_identity_idx
  on auth_attempts (scope, identity_key, occurred_at desc)
  where identity_key is not null;

create index if not exists auth_attempts_source_idx
  on auth_attempts (scope, source_key, occurred_at desc);

-- Sweeping index: the rows are operational, not evidence, and are pruned on a
-- rolling basis. The security *audit* of a lockout lives in
-- `platform_audit_logs`, which is insert-only and outside every purge - so
-- pruning here can never erase the record that somebody was locked out.
create index if not exists auth_attempts_occurred_at_idx
  on auth_attempts (occurred_at);
