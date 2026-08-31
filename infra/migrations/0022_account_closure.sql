-- Account and company closure — the deletion half of the observability packet's
-- §14 step 5 (docs/operating-model/observability-data-lifecycle.md), and the
-- owner decision recorded there as §13.1: **anonymise the person, preserve the
-- record.**
--
-- Export shipped first, on purpose and in that order (0021). Deletion before
-- export would have meant the first person to use the erasure path had no way to
-- take their records with them, and it is the one mistake in this area that
-- cannot be repaired afterwards.
--
-- WHAT DELETION DOES, AND WHY IT IS NOT A DELETE. Sam's time log is his
-- employer's payroll record and the hiring company's proof of an invoiced hour.
-- Destroying it on Sam's request destroys a record the other company is legally
-- obliged to keep and never agreed to lose; destroying nothing makes "delete my
-- data" a lie. §13.1 chose the only option that keeps both promises: the personal
-- fields are overwritten, the account cannot sign in, and every evidence row
-- survives attributed to a withdrawn person. Money never moves.
--
-- The database already agreed, which is worth noticing rather than discovering:
-- `time_logs.logged_by_user_id`, `engagements.client_company_id` and
-- `invoices.issuer_company_id` are all plain references with no `on delete
-- cascade`, so a hard delete of a person or a company that has traded is refused
-- by Postgres before any policy gets a say. Anonymise-and-preserve is the answer
-- this schema was already built for.

-- ── 1. The request ────────────────────────────────────────────────────────────
--
-- A resource with a permanent record (§2). The data goes; the fact that somebody
-- asked for it to go, and that the platform did it, is evidence and stays — a
-- deletion with no record is indistinguishable from a data loss.

create table if not exists deletion_requests (
  id uuid primary key default gen_random_uuid(),

  scope text not null check (scope in ('PERSONAL', 'COMPANY')),

  -- Exactly one. A personal closure has no company: the person may belong to
  -- five, and their own account is not any of theirs.
  subject_user_id    uuid references users(id) on delete set null,
  subject_company_id uuid references companies(id) on delete set null,

  -- Who asked. A company closure is requested by an owner, who is a person, and
  -- the two differing is the interesting case for anybody reading this later.
  requested_by_user_id uuid references users(id) on delete set null,

  /*
   * THE ADDRESS, CAPTURED BEFORE THE RUN — §6's finding, and exactly the kind of
   * thing found by writing the notification matrix rather than the code: the
   * "your account is closed" mail has to go somewhere, and the address is inside
   * the thing being deleted. `notification_deliveries` resolves a recipient's
   * address by joining `users` at send time, so a notice dispatched after the
   * anonymisation would be addressed to the tombstone.
   *
   * NULLED WHEN THE REQUEST REACHES A TERMINAL STATE, and the constraint below
   * makes that structural rather than remembered. By then the notice it exists
   * for has been dispatched with a copy of its own, and a permanent record of a
   * deletion has no business permanently holding the address of the person who
   * asked to be forgotten. What stays is who asked, when, and what was done.
   */
  contact_email text,
  contact_name  text,

  /*
   * REQUESTED → SCHEDULED → EXECUTING → COMPLETED, with CANCELLED reachable from
   * REQUESTED and SCHEDULED only, and FAILED from EXECUTING.
   *
   * WHY REQUESTED AND SCHEDULED ARE BOTH REAL, rather than one shape with two
   * names: REQUESTED means the row exists, SCHEDULED means the holder has
   * actually been told and the deadline is now a promise to a person. The notice
   * goes out through the outbox, and the handler that sends it is what advances
   * the state — so **a request stuck in REQUESTED is one nobody was warned about,
   * and the executor refuses to touch it.** The entire safety property of a
   * cooling-off period is that the warning arrives before the only copy is gone;
   * without this distinction, a permanently dead-lettered notice would delete an
   * account in silence on the seventh day.
   *
   * WHY `FAILED_PARTIAL` IS NOT HERE, though the packet's §3 names it. It
   * reasoned that "a deletion spans many tables … a run that stops halfway has
   * left the account in a state no screen describes". True of a run that is not
   * atomic. This one is: every step is a statement against Postgres inside one
   * transaction, so a crash mid-run rolls the whole thing back and the account is
   * exactly as it was. The half-deleted state the packet wanted made visible
   * cannot occur, and a status value that can never be reached is a shape with
   * one possible value pretending to be caution. What survives from §9 is the
   * rule that matters — **a failed run is never blind-retried** — enforced by the
   * executor claiming `SCHEDULED` only, so a FAILED row waits for a person.
   */
  status text not null default 'REQUESTED'
    check (status in ('REQUESTED', 'SCHEDULED', 'EXECUTING', 'COMPLETED', 'CANCELLED', 'FAILED')),

  -- The end of the cooling-off window. Stored rather than derived from
  -- `created_at` plus a constant, because the constant may change and a deadline
  -- somebody was emailed must not move when it does.
  scheduled_for timestamptz not null,

  -- When the one-day-out notice went, so it goes exactly once (§6).
  imminent_notice_at timestamptz,

  -- Optional, from the requester. Never required: somebody closing their own
  -- account owes nobody an explanation, the same rule `auth_sessions` follows for
  -- a user ending their own device.
  reason text,

  /*
   * WHY A DUE REQUEST DID NOT RUN, in terms the requester can act on.
   *
   * A company with live engagements must settle or hand over before it may go
   * (§13.1), and a person who is the only owner of a company must hand that over
   * first. Those are preconditions on the *run*, not only on the request — see
   * the service for why refusing a company's request outright would mean the
   * counterparty notice that makes settling possible could never be sent.
   *
   * Recorded rather than logged, because the alternative is a closure that
   * quietly never happens and a customer who believes it did.
   */
  blocked_reason text,
  blocked_at     timestamptz,

  cancelled_by_user_id uuid references users(id) on delete set null,
  cancelled_at         timestamptz,
  -- An operator cancelling somebody else's request owes a reason; a person
  -- cancelling their own does not. Enforced in the service, not here, because the
  -- database cannot tell an operator from an owner.
  cancel_reason        text,

  started_at   timestamptz,
  completed_at timestamptz,

  /*
   * WHAT WAS DONE, AS COUNTS AND NEVER CONTENTS (§5).
   *
   * `{"anonymised": {"account": 1}, "removed": {"sessions": 3, …},
   *   "preserved": {"time_logs": 41, …}}`. A payload describing what was deleted,
   * sitting in a permanent record, would be a copy of the thing somebody asked to
   * have removed. The preserved counts are here for the opposite reason: they are
   * the evidence that the promise was kept in both directions.
   */
  counts jsonb not null default '{}',

  error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint deletion_requests_one_subject check (
    (scope = 'PERSONAL' and subject_user_id is not null and subject_company_id is null)
    or (scope = 'COMPANY' and subject_company_id is not null and subject_user_id is null)
  ),

  -- The address outlives the run and nothing more. See `contact_email` above.
  constraint deletion_requests_contact_released check (
    status not in ('COMPLETED', 'CANCELLED') or contact_email is null
  ),

  constraint deletion_requests_cancellation check (
    (status = 'CANCELLED') = (cancelled_at is not null)
  ),
  constraint deletion_requests_completion check (
    (status = 'COMPLETED') = (completed_at is not null)
  ),
  -- A block that cannot say why is a block nobody can clear.
  constraint deletion_requests_block_reason check (
    (blocked_at is null) = (blocked_reason is null)
  )
);

/*
 * SINGLE-FLIGHT PER SUBJECT, as a partial unique index rather than a
 * check-then-insert — the correction `money-boundary.md` §3 made, and the reason
 * `company_creation_requests_one_open_per_user` looks the same. Two clicks are one
 * request; two rows would be two cooling-off clocks and two completion mails for
 * one account, and the second run would find nothing to do and report that as an
 * error.
 */
create unique index if not exists deletion_requests_one_live_per_user
  on deletion_requests (subject_user_id)
  where subject_user_id is not null and status in ('REQUESTED', 'SCHEDULED', 'EXECUTING');

create unique index if not exists deletion_requests_one_live_per_company
  on deletion_requests (subject_company_id)
  where subject_company_id is not null and status in ('REQUESTED', 'SCHEDULED', 'EXECUTING');

-- The executor's question: what is due, and warned about?
create index if not exists deletion_requests_due_idx
  on deletion_requests (scheduled_for)
  where status = 'SCHEDULED';

-- The operator's and the requester's question: what is outstanding on this subject?
create index if not exists deletion_requests_user_idx
  on deletion_requests (subject_user_id, created_at desc)
  where subject_user_id is not null;
create index if not exists deletion_requests_company_idx
  on deletion_requests (subject_company_id, created_at desc)
  where subject_company_id is not null;

comment on table deletion_requests is
  'A closure request and its permanent record. The data goes; that somebody asked, and that the platform did it, stays — a deletion with no record is indistinguishable from a data loss.';

-- ── 2. The marks on the subject ───────────────────────────────────────────────

/*
 * THE ROW SURVIVES; THE PERSON DOES NOT.
 *
 * `users` is not deleted, because every preserved evidence row points at it — a
 * withdrawn person is the attribution §13.1 chose over "nobody", and
 * `time_logs.logged_by_user_id` is `not null` regardless. This column is what
 * says so: set once, never cleared, and read by the auth middleware so a token
 * minted before the run stops working the moment it commits.
 *
 * Deliberately not inferred from a tombstone email pattern. A behaviour that
 * depends on parsing a string is a behaviour somebody breaks by changing the
 * string.
 */
alter table users add column if not exists anonymized_at timestamptz;

create index if not exists users_anonymized_idx on users (anonymized_at)
  where anonymized_at is not null;

comment on column users.anonymized_at is
  'When this account was closed under a deletion request. The row survives because preserved evidence is attributed to it; sign-in is refused from here.';

/*
 * A CLOSED COMPANY, AND WHY ITS NAME IS NOT ANONYMISED.
 *
 * The person's name goes because it identifies a human with an erasure right. A
 * company's name stays because it is *the counterparty's* record of who they
 * traded with, and §10 is unconditional about that: one tenant's deletion may
 * never remove another tenant's record of a shared fact. Renaming Northgate to
 * "Withdrawn company" would leave every client holding invoices from nobody —
 * privacy for a legal person bought with the falsification of somebody else's
 * books.
 *
 * So closure is what a company gets, not erasure, and the promise made before the
 * button says exactly that: everyone's access ends, the subscription stops, the
 * private commercial configuration goes, and the projects, hours and invoices the
 * clients and subcontractors are party to remain theirs.
 */
alter table companies add column if not exists closed_at timestamptz;

create index if not exists companies_closed_idx on companies (closed_at)
  where closed_at is not null;

comment on column companies.closed_at is
  'When this company was closed. Its name and trading history survive because they are the counterparty record too; what ends is access, billing and its own private configuration.';

-- ── 3. The address a completion notice needs ──────────────────────────────────
--
-- `notification_deliveries` resolves the recipient's address by joining `users`
-- at send time, which is right for every other kind and wrong for exactly one:
-- the notice that the account is gone. This column carries the address captured
-- at request time past the anonymisation that removed it.
--
-- CLEARED THE MOMENT THE DELIVERY IS TERMINAL — sent, skipped or out of attempts.
-- Kept only as long as the send needs it, so a dead-lettered completion mail
-- costs the operator the address rather than keeping one indefinitely against a
-- replay nobody will run. Null on every other delivery in the table, and the join
-- is what still answers those.

alter table notification_deliveries
  add column if not exists recipient_email_snapshot text;

comment on column notification_deliveries.recipient_email_snapshot is
  'An address captured before the account holding it was anonymised. Set only for closure notices, cleared when the delivery is terminal; every other row resolves its address by joining users at send time.';
