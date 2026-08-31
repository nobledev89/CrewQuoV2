import type { DeletionScope, DeletionStatus } from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

/**
 * `deletion_requests` — the permanent record of a closure (0022).
 *
 * The data goes; the fact that somebody asked for it to go, and that the platform
 * did it, stays. A deletion with no record is indistinguishable from a data loss.
 */

export interface DeletionRequestRow {
  id: string;
  scope: DeletionScope;
  subject_user_id: string | null;
  subject_company_id: string | null;
  requested_by_user_id: string | null;
  contact_email: string | null;
  contact_name: string | null;
  status: DeletionStatus;
  scheduled_for: Date;
  imminent_notice_at: Date | null;
  reason: string | null;
  blocked_reason: string | null;
  cancelled_at: Date | null;
  completed_at: Date | null;
  counts: Record<string, unknown>;
  created_at: Date;
}

const COLUMNS = `id, scope, subject_user_id, subject_company_id, requested_by_user_id,
  contact_email, contact_name, status, scheduled_for, imminent_notice_at, reason,
  blocked_reason, cancelled_at, completed_at, counts, created_at`;

const LIVE = `('REQUESTED', 'SCHEDULED', 'EXECUTING')`;

/**
 * Open the request.
 *
 * **The insert is the concurrency control**, not a preceding read: the partial
 * unique index on (subject, non-terminal status) is what makes two clicks one
 * request. A check-then-insert would let two simultaneous submissions both pass the
 * check, and the product would then hold two cooling-off clocks and send two
 * completion mails for one account — the correction `money-boundary.md` §3 made,
 * and the reason `company_creation_requests_one_open_per_user` has the same shape.
 */
export async function insertDeletionRequest(
  input: {
    scope: DeletionScope;
    subjectUserId: string | null;
    subjectCompanyId: string | null;
    requestedByUserId: string;
    contactEmail: string;
    contactName: string | null;
    scheduledFor: Date;
    reason: string | null;
  },
  runner?: Queryable
): Promise<DeletionRequestRow> {
  const row = await queryOne<DeletionRequestRow>(
    `insert into deletion_requests
       (scope, subject_user_id, subject_company_id, requested_by_user_id,
        contact_email, contact_name, scheduled_for, reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning ${COLUMNS}`,
    [
      input.scope,
      input.subjectUserId,
      input.subjectCompanyId,
      input.requestedByUserId,
      input.contactEmail,
      input.contactName,
      input.scheduledFor,
      input.reason,
    ],
    runner
  );
  return row!;
}

export function findLiveRequestForUser(
  userId: string,
  runner?: Queryable
): Promise<DeletionRequestRow | null> {
  return queryOne<DeletionRequestRow>(
    `select ${COLUMNS} from deletion_requests
      where subject_user_id = $1 and status in ${LIVE}`,
    [userId],
    runner
  );
}

export function findLiveRequestForCompany(
  companyId: string,
  runner?: Queryable
): Promise<DeletionRequestRow | null> {
  return queryOne<DeletionRequestRow>(
    `select ${COLUMNS} from deletion_requests
      where subject_company_id = $1 and status in ${LIVE}`,
    [companyId],
    runner
  );
}

export function findRequestById(
  id: string,
  runner?: Queryable
): Promise<DeletionRequestRow | null> {
  return queryOne<DeletionRequestRow>(
    `select ${COLUMNS} from deletion_requests where id = $1`,
    [id],
    runner
  );
}

/**
 * `REQUESTED → SCHEDULED`, and this is the only path to it.
 *
 * Called by the outbox handler that sends the notice, **after** it has been
 * dispatched. That is the whole reason the two states exist: the executor claims
 * `SCHEDULED` only, so a notice that never went out is a closure that never runs
 * rather than one that runs in silence. Idempotent, because the outbox may deliver
 * the same event twice and the second delivery must not be an error.
 */
export async function markNoticeDispatched(id: string, runner?: Queryable): Promise<void> {
  await query(
    `update deletion_requests set status = 'SCHEDULED', updated_at = now()
      where id = $1 and status = 'REQUESTED'`,
    [id],
    runner
  );
}

/** The one-day-out notice, recorded so it goes exactly once (§6). */
export async function markImminentNoticeSent(id: string, runner?: Queryable): Promise<void> {
  await query(
    `update deletion_requests set imminent_notice_at = now(), updated_at = now()
      where id = $1 and imminent_notice_at is null`,
    [id],
    runner
  );
}

/**
 * Cancel, and release the address with it.
 *
 * `contact_email` goes to null because the notice it was captured for will now
 * never be sent, and 0022's constraint refuses a cancelled row that still holds
 * one. The address is on the person's own live account regardless — this row is the
 * copy that had a purpose, and the purpose is gone.
 *
 * Conditioned on the cancellable states rather than checked first, so two people
 * clicking cancel produce one cancellation and one no-op.
 */
export async function cancelDeletionRequest(
  input: { id: string; cancelledByUserId: string; reason: string | null },
  runner?: Queryable
): Promise<DeletionRequestRow | null> {
  return queryOne<DeletionRequestRow>(
    `update deletion_requests
        set status = 'CANCELLED', cancelled_at = now(), cancelled_by_user_id = $2,
            cancel_reason = $3, contact_email = null, updated_at = now()
      where id = $1 and status in ('REQUESTED', 'SCHEDULED')
      returning ${COLUMNS}`,
    [input.id, input.cancelledByUserId, input.reason],
    runner
  );
}

/**
 * Every request whose deadline has passed and whose holder has been told.
 *
 * `SCHEDULED` only — see `deletionIsExecutable` in the shared policy for why a
 * `REQUESTED` row past its deadline is left alone, and why a `FAILED` one is never
 * picked up again.
 */
export function listExecutableRequests(runner?: Queryable): Promise<DeletionRequestRow[]> {
  return query<DeletionRequestRow>(
    `select ${COLUMNS} from deletion_requests
      where status = 'SCHEDULED' and scheduled_for <= now()
      order by scheduled_for`,
    [],
    runner
  );
}

/** Requests inside the one-day-out window that have not had their second notice. */
export function listImminentRequests(runner?: Queryable): Promise<DeletionRequestRow[]> {
  return query<DeletionRequestRow>(
    `select ${COLUMNS} from deletion_requests
      where status = 'SCHEDULED' and imminent_notice_at is null
        and scheduled_for <= now() + interval '24 hours'
      order by scheduled_for`,
    [],
    runner
  );
}

/**
 * Take the row for a run.
 *
 * A lease in its own transaction, before the work: two schedulers overlapping — a
 * manual dispatch on top of the cron — must not both run the same closure, and the
 * second one finding nothing to claim is the correct outcome rather than a
 * conflict. `for update skip locked` is the same shape the outbox uses.
 */
export async function claimForExecution(
  id: string,
  runner?: Queryable
): Promise<DeletionRequestRow | null> {
  return queryOne<DeletionRequestRow>(
    `update deletion_requests
        set status = 'EXECUTING', started_at = now(), blocked_reason = null,
            blocked_at = null, updated_at = now()
      where id = (select id from deletion_requests
                   where id = $1 and status = 'SCHEDULED'
                   for update skip locked)
      returning ${COLUMNS}`,
    [id],
    runner
  );
}

/** Put a claimed row back, because a precondition is still in the way. */
export async function blockRequest(
  input: { id: string; reason: string },
  runner?: Queryable
): Promise<void> {
  await query(
    `update deletion_requests
        set status = 'SCHEDULED', started_at = null, blocked_reason = $2,
            blocked_at = now(), updated_at = now()
      where id = $1`,
    [input.id, input.reason],
    runner
  );
}

/**
 * Close the run, with what it did as counts and never contents (§5).
 *
 * `contact_email` is cleared here too: the completion notice has been enqueued in
 * this same transaction with its own copy of the address, so the permanent record
 * no longer needs — and 0022's constraint no longer permits — the address of
 * somebody who asked to be forgotten.
 */
export async function completeRequest(
  input: { id: string; counts: Record<string, unknown> },
  runner?: Queryable
): Promise<void> {
  await query(
    `update deletion_requests
        set status = 'COMPLETED', completed_at = now(), counts = $2::jsonb,
            contact_email = null, error = null, updated_at = now()
      where id = $1`,
    [input.id, JSON.stringify(input.counts)],
    runner
  );
}

/**
 * Record a run that raised.
 *
 * Written in its own connection after the work transaction rolled back, so the
 * account is untouched and the row says so. **Nothing retries this** — §9's rule
 * that a failed deletion is never blind-retried is enforced by the claim query
 * asking for `SCHEDULED`, and `FAILED` is not that. An operator resumes it
 * deliberately or not at all.
 */
export async function failRequest(
  input: { id: string; error: string },
  runner?: Queryable
): Promise<void> {
  await query(
    `update deletion_requests
        set status = 'FAILED', error = $2, updated_at = now()
      where id = $1`,
    [input.id, input.error.slice(0, 1000)],
    runner
  );
}
