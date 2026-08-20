-- 0018_session_lineage.sql
-- Refresh-token lineage, reuse detection and self-service device management
-- (CREWQUO_V2_PLAN.md 42). Step 2 of the build order in
-- docs/operating-model/access.md 14; step 1 was 0016.
--
-- THE HOLE THIS CLOSES. Rotation already happens: `refresh()` revokes the
-- presented token and issues a successor, so a refresh token does not survive
-- being used. DETECTION is what is missing. Replaying a retired token returns a
-- plain UNAUTHENTICATED - the same answer an expired one gives - and the
-- legitimate session carries on untouched. So the single strongest signal of
-- theft this product could have, the same token presented twice, which has only
-- two explanations (a thief, or a client bug), is thrown away as a 401.
--
-- Acting on that signal means revoking "the family", and the family is not
-- currently expressible: `refresh_tokens` has no session and no predecessor
-- column. That, not rotation, is the work here.
--
-- AND A SESSION IS NOT A TOKEN. A person thinks in devices - "sign out the phone
-- I left on a train" - while the table thinks in 30-day strings replaced every
-- time the app is opened. Ending "a token" is meaningless to the owner of a lost
-- phone, because the token they signed in with was retired weeks ago. So the
-- device is the row a user acts on, and the tokens are its lineage.

-- 1. The session: one row per sign-in, one row per device -----------------------

create table if not exists auth_sessions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,

  -- Coarse and client-supplied, from the User-Agent family only: "Chrome on
  -- Windows", never "Chrome 141.0.7390 on Windows 11 from 41.13.8.2".
  --
  -- NULL IS A REAL ANSWER and the column is deliberately nullable: a caller with
  -- no recognisable User-Agent (curl, the verification script, a future
  -- server-to-server client) gets no label rather than a guessed one, and the UI
  -- says "Unknown device". A row backfilled from before this migration has none
  -- either, which is the honest reading of a session nobody recorded a device for.
  --
  -- THERE IS NO LOCATION COLUMN, and that is the packet's 7 rather than an
  -- omission: storing an address history against every session builds a log of a
  -- person's movements to answer a question a device name answers, and that log
  -- is then a thing which can leak. `auth_attempts.source_key` hashes its address
  -- for the same reason.
  device_label   text check (device_label is null or length(btrim(device_label)) > 0),

  created_at     timestamptz not null default now(),
  -- Bumped on every rotation. This is the "last seen" a device list shows, and
  -- the only reason a session row stays interesting after its token is gone.
  last_used_at   timestamptz not null default now(),
  -- Slides with the newest token in the family, so liveness is answerable from
  -- this row alone - which is what lets the auth middleware check a session
  -- without joining the token it was not given.
  expires_at     timestamptz not null,

  revoked_at     timestamptz,
  -- WHY the session ended, as a closed set. A device list that says "ended" and
  -- cannot say by whom is the one screen where the answer matters most: "I ended
  -- it" and "somebody ended it for me" are the difference between a tidy-up and
  -- an incident.
  revoked_cause  text check (revoked_cause in
                   ('SIGNED_OUT', 'ENDED_BY_USER', 'PASSWORD_RESET', 'TOKEN_REUSE', 'OPERATOR')),
  -- Free text, and only ever an operator's stated reason (13.2). A user ending
  -- their own phone owes nobody an explanation; a super admin ending somebody
  -- else's does.
  revoked_reason text,
  revoked_by_user_id uuid references users(id) on delete set null,

  -- A cause without an ending, or an ending without a cause, both mean the
  -- writer lost track of which it was.
  check ((revoked_at is null) = (revoked_cause is null)),
  check (revoked_at is not null or (revoked_reason is null and revoked_by_user_id is null))
);

-- The device list: one user's sessions, newest first.
create index if not exists auth_sessions_user_idx
  on auth_sessions (user_id, created_at desc);

-- The middleware's question - "is this session still live" - and the pruner's.
create index if not exists auth_sessions_live_idx
  on auth_sessions (user_id, expires_at desc)
  where revoked_at is null;

comment on table auth_sessions is
  'One sign-in on one device. Refresh tokens are its lineage; this row is what a user ends and what an operator revokes.';

-- 2. The lineage on the tokens --------------------------------------------------

alter table refresh_tokens
  add column if not exists session_id uuid references auth_sessions(id) on delete cascade,
  -- The token this one replaced. Not read by the rotation path, which only needs
  -- the session - it is here so a compromise can be walked backwards: "this
  -- family was revoked at 03:12; how many rotations, from when, and did the chain
  -- fork?" A fork is exactly what a thief and a victim refreshing in parallel
  -- looks like, and it is unreconstructable from timestamps alone.
  add column if not exists parent_id uuid references refresh_tokens(id) on delete set null,
  -- RETIRED BY ROTATION, as distinct from `revoked_at`, which says only that the
  -- token no longer works. Both are set when a token is exchanged; only
  -- `revoked_at` is set when a session is ended deliberately. That distinction IS
  -- the reuse detector: replaying a rotated token is theft or a client bug, while
  -- replaying a signed-out one is a client that has not noticed yet, and treating
  -- the second as the first would fire the alarm at every sign-out.
  add column if not exists rotated_at timestamptz;

-- Every lookup in the refresh path is by hash, and until now there was NO INDEX
-- ON `token_hash` AT ALL - every refresh sequentially scanned a table that grows
-- with every sign-in of every user on the platform. Unique because a SHA-256 of
-- 48 random bytes cannot legitimately repeat, so a duplicate would be a bug (a
-- re-inserted token) rather than a coincidence, and the constraint is the only
-- thing that would ever say so.
create unique index if not exists refresh_tokens_token_hash_key
  on refresh_tokens (token_hash);

create index if not exists refresh_tokens_session_idx
  on refresh_tokens (session_id);

comment on column refresh_tokens.rotated_at is
  'Retired by exchange. Set with revoked_at on rotation only; a deliberately ended token has revoked_at and no rotated_at.';

-- 3. Backfill: give every LIVE token a session ----------------------------------
--
-- Live tokens only, and this matters more than it looks: without it, every person
-- currently signed in is signed out by the deployment - which is exactly the
-- "rotating the secret logs everybody out" failure the packet's 10 objects to,
-- arriving through a different door.
--
-- One session per live token rather than one per user: two live tokens for one
-- user really are two devices, and the lineage that would tell them apart does
-- not exist for rows written before this migration. Merging them would fuse a
-- laptop and a phone into one row, and ending it would end both.
--
-- Already-revoked and expired tokens are deliberately left with a null
-- `session_id`. They are history: nobody can act on them, null reads as
-- "predates lineage", and inventing sessions for them would fill every user's
-- device list with dozens of phantom devices they never lost.

with live as (
  select id, user_id, created_at, expires_at
    from refresh_tokens
   where revoked_at is null and expires_at > now() and session_id is null
), created as (
  insert into auth_sessions (user_id, device_label, created_at, last_used_at, expires_at)
  select user_id, null, created_at, created_at, expires_at from live
  returning id, user_id, created_at, expires_at
), paired as (
  -- Pair each live token with its own new session. `row_number` over the same
  -- ordering on both sides is what makes this one-to-one: the inserted rows carry
  -- no reference back to the token they were made for, so the ordering is the only
  -- link available, and (user_id, created_at, expires_at) is stable across both.
  -- Deliberately no `id` tie-break: the two sides hold different ids (a token's
  -- and a session's), so adding one would order them differently. Two tokens that
  -- tie on all three columns are indistinguishable anyway - same user, same
  -- lifetime - so either pairing is the same answer.
  select l.id as token_id, c.id as session_id
    from (select *, row_number() over (order by user_id, created_at, expires_at) as rn from live) l
    join (select *, row_number() over (order by user_id, created_at, expires_at) as rn from created) c
      on c.rn = l.rn
)
update refresh_tokens t
   set session_id = p.session_id
  from paired p
 where t.id = p.token_id;

-- 4. Account-scoped notifications -----------------------------------------------
--
-- `notifications.company_id` was `not null`, so the inbox could only hold
-- something belonging to a company - and every event in this domain belongs to a
-- PERSON. Their account may span several companies, or none at all.
--
-- 0016 hit this and deferred it: the lockout notice sends an email and writes a
-- platform-audit row, with a comment saying the in-product half waits for "the
-- MFA slice, where the rest of this domain's notification kinds land together and
-- the column can be widened once for all of them rather than bent here for one".
-- This slice adds two more of those kinds - a detected token reuse, and an
-- operator ending your sessions - which makes it the widening-once that comment
-- asked for, one slice earlier than it guessed.
--
-- Picking one of the holder's companies instead would put a security alert in a
-- tenant's audit-visible inbox and imply the event happened there, which is false
-- and leaks across a boundary the rest of the product spends four checks
-- defending.
--
-- The durable path is the other half of the reason. An email sent inline from a
-- request is lost when the provider blips, and the reuse alert is the ONE warning
-- a victim gets; routing it through `notification_deliveries` gives it the same
-- retries, dead-lettering and evidence every other notification has.

alter table notifications alter column company_id drop not null;

comment on column notifications.company_id is
  'Null means account-scoped: a security event about the person, not about a tenant. Shown in the holder inbox whichever company they are viewing.';

-- The inbox read gains an `or company_id is null` arm, which the composite index
-- above cannot serve. Tiny by volume - a handful of rows per account, ever.
create index if not exists notifications_account_scoped_idx
  on notifications (recipient_user_id, created_at desc)
  where company_id is null;
