-- 0019_mfa.sql
-- Second factors: TOTP with recovery codes (CREWQUO_V2_PLAN.md 42).
-- Step 3 of the build order in docs/operating-model/access.md 14.
--
-- THE GAP THIS CLOSES. Every account on the platform is a password and nothing
-- else - including the super admins who can read every company, comp trials,
-- revoke sessions and approve new tenants. 0016 stopped unlimited guessing and
-- 0018 made a stolen session detectable, but neither adds a second thing an
-- attacker has to have.
--
-- WHO IS REQUIRED TO HOLD ONE, AND WHO IS NOT (13.1, reaffirmed by the owner on
-- 2026-08-20 after the question was reopened). Mandatory for platform staff,
-- offered but never required to customer OWNER/ADMIN, and out of scope entirely
-- for Crew-plan field accounts. The asymmetry is the reasoning: a compromised
-- customer password is one tenant's incident, a compromised staff password is
-- every tenant's. And the persona who logs four hours from a car park with cold
-- hands gets no new friction - mandatory TOTP there buys little and costs enough
-- that the work stops being recorded, which is a data-integrity failure wearing a
-- security win's clothes.

-- 1. The factor ------------------------------------------------------------------

create table if not exists auth_factors (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,

  -- A closed set with one member. WebAuthn later adds a VALUE here, not a table:
  -- the questions this row answers - is it confirmed, when was it last used, may
  -- it be removed - are the same whatever the factor is made of.
  kind         text not null check (kind in ('TOTP')),

  -- Base32, as the authenticator app received it.
  --
  -- STORED IN PLAIN TEXT, AS A STATED DECISION RATHER THAN AN OVERSIGHT. The
  -- obvious alternative is application-level encryption under a key from the
  -- environment, and it was rejected for this stack: there is no KMS here, so the
  -- key would live beside the database credentials it protects, and the failure
  -- mode is severe and silent - lose or rotate that key and every user on the
  -- platform is locked out of their own factor with no path back except an
  -- operator reset each. The realistic gain is against a database dump alone
  -- (an application compromise reads the key too), and a dump already exposes
  -- every business record in the product.
  --
  -- What would change the decision: a real key-management service, or a
  -- `secret_key_version` column so a key can be rotated by lazily re-encrypting
  -- instead of by mass re-enrolment. Both are additive to this shape.
  secret       text not null check (length(btrim(secret)) > 0),

  -- PENDING -> ACTIVE. There is no NONE: absence of a row IS none.
  --
  -- `PENDING` earns its place (packet 3): enrolment is not complete until the
  -- user has produced one correct code. Without the state, a proportion of
  -- enrolments strand somebody outside their own account holding a QR code they
  -- never scanned properly - and for a mandatory-MFA operator, that is a locked
  -- door with the key inside.
  status       text not null check (status in ('PENDING', 'ACTIVE')),
  confirmed_at timestamptz,

  -- The last counter this factor accepted, so one code is worth exactly one
  -- login. Without it a code stays replayable for its whole drift window, and a
  -- code read over somebody's shoulder is worth 90 seconds instead of nothing.
  last_counter bigint,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- Confirmed and PENDING are contradictory in both directions.
  check ((status = 'ACTIVE') = (confirmed_at is not null)),

  -- One factor of a kind per person. Re-enrolling replaces the pending row rather
  -- than accumulating abandoned secrets, each of which would otherwise stay a
  -- valid way in.
  unique (user_id, kind)
);

create index if not exists auth_factors_user_idx on auth_factors (user_id);

comment on table auth_factors is
  'Second factors. Absence of a row is NONE; PENDING means a secret was issued and never proven.';

-- 2. Recovery codes --------------------------------------------------------------
--
-- The answer to "my phone is gone" that does not require an operator (9). Ten of
-- them, single-use, shown exactly once.
--
-- HASHED WITH SHA-256, NOT BCRYPT, and that is a considered difference from
-- `users.password_hash`. Bcrypt exists to make a LOW-ENTROPY human secret
-- expensive to guess; a recovery code is 50 bits of machine randomness, so
-- guessing is already hopeless and the slow hash would instead be a cost paid on
-- every check - ten of them per attempt, on the one path somebody uses while
-- locked out and anxious. Same reasoning `refresh_tokens.token_hash` already
-- follows.

create table if not exists auth_recovery_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  code_hash  text not null,
  -- Set once, on spend. The row is kept rather than deleted so "was a recovery
  -- code used, and when" survives the code - which is the question asked after an
  -- account behaves oddly.
  used_at    timestamptz,
  created_at timestamptz not null default now(),

  -- Two identical codes for one person would make one of them unspendable.
  unique (user_id, code_hash)
);

-- The spend path: this user's unused codes.
create index if not exists auth_recovery_codes_open_idx
  on auth_recovery_codes (user_id)
  where used_at is null;

comment on table auth_recovery_codes is
  'Single-use codes shown exactly once at enrolment. Regenerating invalidates the whole set.';

-- 3. A budget for code guessing --------------------------------------------------
--
-- A six-digit code is a million possibilities, and roughly 3 of them are valid at
-- any moment across the drift window - so an unlimited guesser needs about
-- 300,000 attempts for even odds, which is minutes of scripted traffic. The
-- password limiter does not cover this: a code is checked AFTER the password has
-- already been accepted, on a different endpoint, against a challenge the attacker
-- legitimately holds.
--
-- Widening the existing check constraint rather than adding a table, because the
-- counting, the pruning, the source hashing and the "only failures consume
-- budget" rule are all already right in `auth_attempts`.

alter table auth_attempts drop constraint if exists auth_attempts_scope_check;
alter table auth_attempts
  add constraint auth_attempts_scope_check
  check (scope in ('LOGIN', 'RESET', 'REGISTER', 'MFA'));
