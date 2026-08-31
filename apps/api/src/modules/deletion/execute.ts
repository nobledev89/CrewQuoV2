import { WITHDRAWN_PERSON_NAME, type DeletionScope } from '@crewquo/shared';
import { query, withTransaction, type Queryable } from '../../db';
import { log } from '../../observability/log';
import { recordPlatformAudit } from '../admin/platform.repo';
import { recordAudit } from '../audit/record';
import { dispatchNotification } from '../notifications/dispatch';
import { companyBlocks, personalBlocks } from './preconditions';
import {
  blockRequest,
  claimForExecution,
  completeRequest,
  failRequest,
  listExecutableRequests,
  type DeletionRequestRow,
} from './repo';
import { CLOSURE_SPECS } from './steps';

/**
 * Running a closure.
 * Operating-model packet: `docs/operating-model/observability-data-lifecycle.md`
 * §3, §9, §12 and §14 step 5.
 *
 * **The whole run is one transaction, and that is the design decision this file is
 * built around.** The packet's §3 wanted a `FAILED_PARTIAL` state because "a
 * deletion spans many tables and … a run that stops halfway has left the account in
 * a state no screen describes". That is true of a run that is not atomic. Every
 * step here is a statement against Postgres, so one transaction makes the halfway
 * state unreachable: a crash rolls back and the account is exactly as it was. The
 * half-deleted account the packet wanted made visible cannot occur.
 *
 * What survives from §9 is the rule that actually protects people: **a failed
 * deletion is never blind-retried.** Retrying a partially-completed run is how a
 * preserved evidence row becomes a deleted one on attempt three. Here the run either
 * committed or did nothing, and a `FAILED` row is still never picked up again —
 * `listExecutableRequests` asks for `SCHEDULED`, and a person has to look at a
 * failure before it moves.
 */

/**
 * A `type` rather than an `interface`, and the difference is load-bearing here:
 * TypeScript gives a type alias an implicit index signature and an interface none, so
 * only this form is assignable to the `Record<string, unknown>` the audit and request
 * writers take. The alternative was widening those signatures, which would let any
 * object at all into a jsonb column that must only ever hold counts.
 */
export type ClosureCounts = {
  anonymised: Record<string, number>;
  removed: Record<string, number>;
  preserved: Record<string, number>;
};

const BUCKET: Record<'ANONYMISE' | 'REMOVE' | 'PRESERVE', keyof ClosureCounts> = {
  ANONYMISE: 'anonymised',
  REMOVE: 'removed',
  PRESERVE: 'preserved',
};

/**
 * Apply every step of a scope's plan to one subject, inside the caller's
 * transaction.
 *
 * The acting steps run in `actingOrder`, which is **not** the plan's reading order:
 * `users` is last because `auth_attempts` and `invites` are keyed on the email
 * address the anonymisation destroys, and running them afterwards would leave both
 * sets of rows holding a real address while reporting zero rows deleted — a silent
 * failure in the one direction that matters. `steps.test.ts` asserts the ordering
 * rather than trusting this paragraph.
 *
 * The preserved counts are gathered **after** the acting steps, so they are what
 * genuinely survived rather than what was there beforehand. That is the difference
 * between evidence and an intention.
 */
export async function applyClosurePlan(
  scope: DeletionScope,
  subjectId: string,
  client: Queryable
): Promise<ClosureCounts> {
  const spec = CLOSURE_SPECS[scope];
  const counts: ClosureCounts = { anonymised: {}, removed: {}, preserved: {} };
  const byTable = new Map(spec.plan.map((step) => [step.table, step]));

  for (const table of spec.actingOrder) {
    const step = byTable.get(table)!;
    const result = await client.query(spec.statements[table]!.sql, [subjectId] as never[]);
    counts[BUCKET[step.action as 'ANONYMISE' | 'REMOVE']][table] = result.rowCount ?? 0;
  }

  for (const step of spec.plan) {
    if (step.action !== 'PRESERVE') continue;
    const rows = await query<{ n: number }>(
      spec.statements[step.table]!.sql,
      [subjectId],
      client
    );
    counts.preserved[step.table] = rows[0]?.n ?? 0;
  }

  return counts;
}

/**
 * The notice that the account is gone — the last message it will ever receive.
 *
 * Written **inside the run's transaction**, which makes it the only notification in
 * the product not enqueued through the outbox. The reason is specific rather than
 * stylistic: every other kind is enqueued so a worker can resolve its recipients
 * later, and this one's recipient has stopped existing by the time a worker would
 * look. In the same transaction, an account is never anonymised without its farewell
 * queued, and never sent one for a closure that rolled back.
 *
 * The address comes from `contact_email`, captured at request time (§6): the mail
 * has to go somewhere and the address was inside the thing that was deleted.
 */
async function queueClosureFarewell(
  request: DeletionRequestRow,
  client: Queryable
): Promise<void> {
  if (!request.subject_user_id || !request.contact_email) return;

  await dispatchNotification(
    {
      kind: 'account.closure_completed',
      // No company: this is not an event inside a tenant, and by now the person
      // belongs to none.
      companyId: null,
      recipientUserIds: [request.subject_user_id],
      title: 'Your CrewQuo account has been closed',
      body:
        'Your name, email address and sign-in are gone, and this address will not ' +
        'receive anything else from us. As we said when you asked: the hours you ' +
        'logged remain on the projects they belong to, without your name on them, ' +
        `recorded as “${WITHDRAWN_PERSON_NAME}”. The companies you worked for keep ` +
        'their own record of work they had already approved and invoiced. Nothing ' +
        'else about you is retained, and there is no account left to sign in to.',
      subjectType: 'USER',
      subjectId: request.subject_user_id,
      topic: 'account.closure_completed',
      aggregateId: request.id,
      recipientEmailSnapshot: request.contact_email,
    },
    client
  );
}

/**
 * Run one claimed request.
 *
 * Returns what happened rather than throwing, because the caller is a scheduled job
 * counting outcomes: one blocked company closure must not stop the eleven personal
 * ones behind it.
 */
export async function executeClaimedRequest(
  request: DeletionRequestRow
): Promise<'COMPLETED' | 'BLOCKED' | 'FAILED'> {
  const subjectId = request.subject_user_id ?? request.subject_company_id!;

  /*
   * The preconditions, checked again here and not only at request time.
   *
   * Seven days is long enough for somebody to be promoted to sole owner of a
   * company, or for a client to open a new engagement with a company that is
   * closing. Running anyway would leave a company with no owner, or take a live
   * relationship away from a counterparty who started it in good faith — and §13.1's
   * "settle or hand over" is a condition on the deletion, not on the paperwork.
   */
  const blocks =
    request.scope === 'PERSONAL'
      ? await personalBlocks(subjectId)
      : await companyBlocks(subjectId);

  if (blocks.length > 0) {
    await blockRequest({ id: request.id, reason: blocks.join(' ') });
    log('warn', 'closure_blocked', { deletionRequestId: request.id });
    return 'BLOCKED';
  }

  try {
    const counts = await withTransaction(async (client) => {
      const applied = await applyClosurePlan(request.scope, subjectId, client);

      if (request.scope === 'PERSONAL') {
        await queueClosureFarewell(request, client);
      } else {
        /*
         * The company's own trail records its own ending, and this is the last row
         * it will ever have. Left to expire under its own `audit_retention_days`
         * like every other row rather than purged now, because the client-visible
         * slice of this trail is what a counterparty reads in the portal.
         */
        await recordAudit(
          {
            companyId: subjectId,
            actorUserId: request.requested_by_user_id,
            action: 'company.closed',
            entityType: 'COMPANY',
            entityId: subjectId,
            // Counts, never contents. See 0022.
            changes: { counts: applied },
            description: 'Company closed at the request of an owner',
          },
          client
        );
      }

      /*
       * The platform's own record, and §12's twelfth assertion: immutable, with what
       * was removed and what was preserved as counts, outliving the data.
       * `platform_audit_logs` is insert-only and outside every retention purge, which
       * is exactly the property a deletion record needs — the *record* of a deletion
       * outlives the thing deleted, or a deletion is indistinguishable from a loss.
       */
      await recordPlatformAudit(
        {
          actorUserId: request.requested_by_user_id,
          action: request.scope === 'PERSONAL' ? 'account.closed' : 'company.closed',
          entityType: request.scope === 'PERSONAL' ? 'USER' : 'COMPANY',
          entityId: subjectId,
          changes: { requestId: request.id, scope: request.scope, counts: applied },
          description:
            request.scope === 'PERSONAL'
              ? 'Account anonymised on request; evidence preserved'
              : 'Company closed on request; jointly-held records preserved',
        },
        client
      );

      await completeRequest({ id: request.id, counts: applied }, client);
      return applied;
    });

    log('info', 'closure_completed', {
      deletionRequestId: request.id,
      // A count of tables touched, never which rows and never how many of anybody's.
      succeeded: Object.keys(counts.removed).length + Object.keys(counts.anonymised).length,
    });
    return 'COMPLETED';
  } catch (err) {
    /*
     * The transaction rolled back, so the subject is untouched. Recorded on a fresh
     * connection — the failed one is no longer usable — and left `FAILED`, which
     * nothing picks up again.
     */
    await failRequest({
      id: request.id,
      error: err instanceof Error ? err.message : String(err),
    });
    log('error', 'closure_failed', {
      deletionRequestId: request.id,
      errorClass: err instanceof Error ? err.constructor.name : typeof err,
    });
    return 'FAILED';
  }
}

export interface ClosureRunSummary {
  claimed: number;
  completed: number;
  blocked: number;
  failed: number;
}

/**
 * Every request whose deadline has passed and whose holder has been warned.
 *
 * The claim is a separate transaction from the work, which is what makes
 * `EXECUTING` a state an operator can actually see: a row that says EXECUTING and
 * is not moving is a run whose process stopped existing, and that is a different
 * fact from a failure — the same distinction `job_runs` draws with `RUNNING`.
 * `recoverStaleClosureClaims` is what returns those rows, and it is only safe
 * *because* the work is atomic: nothing was half-done, so nothing is half-retried.
 */
export async function runDueClosures(): Promise<ClosureRunSummary> {
  const summary: ClosureRunSummary = { claimed: 0, completed: 0, blocked: 0, failed: 0 };

  for (const due of await listExecutableRequests()) {
    const claimed = await claimForExecution(due.id);
    // Somebody else took it, or it was cancelled between the read and the claim.
    // Both are the correct outcome rather than a conflict.
    if (!claimed) continue;
    summary.claimed += 1;

    const outcome = await executeClaimedRequest(claimed);
    if (outcome === 'COMPLETED') summary.completed += 1;
    else if (outcome === 'BLOCKED') summary.blocked += 1;
    else summary.failed += 1;
  }

  return summary;
}

/**
 * Return runs whose process died mid-claim.
 *
 * **Safe only because the work is one transaction.** A run that was claimed and
 * never committed did nothing at all, so putting it back is not the blind retry §9
 * forbids — there is no partial state to compound. If the work ever stops being
 * atomic, this function becomes the bug the packet was worried about, which is why
 * the dependency is written here rather than assumed.
 *
 * Thirty minutes, against a run that takes milliseconds: the window only has to
 * outlast a deploy.
 */
export async function recoverStaleClosureClaims(staleMinutes = 30): Promise<number> {
  const rows = await query<{ id: string }>(
    `update deletion_requests
        set status = 'SCHEDULED', started_at = null, updated_at = now()
      where status = 'EXECUTING'
        and started_at < now() - ($1 || ' minutes')::interval
      returning id`,
    [String(staleMinutes)]
  );
  if (rows.length > 0) {
    log('warn', 'closure_claims_recovered', { claimed: rows.length });
  }
  return rows.length;
}
