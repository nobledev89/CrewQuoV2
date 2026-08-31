import { imminentNoticeDue } from '@crewquo/shared';
import { withTransaction } from '../db';
import { enqueueOutboxEvent } from '../modules/delivery/repo';
import {
  recoverStaleClosureClaims,
  runDueClosures,
  type ClosureRunSummary,
} from '../modules/deletion/execute';
import { listImminentRequests } from '../modules/deletion/repo';

/**
 * The pass that runs closures and sends their last warning
 * (`docs/operating-model/observability-data-lifecycle.md` §14 step 5).
 *
 * **Hourly, not daily**, and the reason is the deadline rather than the volume.
 * A closure has an instant somebody was emailed, and a daily pass would run it up
 * to twenty-four hours late — which is survivable — while sending the "closes
 * tomorrow" warning up to twenty-four hours late is not: a one-day notice that
 * arrives on the day is not a notice, it is an announcement. Hourly makes both
 * accurate to within an hour, which is the resolution the promise is made at.
 *
 * The order inside is deliberate: warnings first, then runs. A request that is both
 * inside its final day and past its deadline in the same pass — which happens on a
 * deployment that was down for a day — gets its warning written before it is acted
 * on, so the notice exists even where it arrives alongside the outcome. The reverse
 * order would swallow it.
 */
export interface ClosurePassResult extends ClosureRunSummary {
  warned: number;
  recovered: number;
}

/**
 * Queue the one-day-out notice for every request inside its final day.
 *
 * The guard against sending twenty-four of them is the recorded send
 * (`imminent_notice_at`), not a window — and the handler sets it after dispatching,
 * so a pass that dies between the enqueue and the mark re-enqueues into the same
 * outbox idempotency key, which is a no-op.
 */
export async function sendImminentClosureNotices(now = new Date()): Promise<number> {
  let warned = 0;

  for (const request of await listImminentRequests()) {
    // The SQL already narrowed to the window; the pure policy is what decides, so
    // the rule stays in one place and is testable without a database.
    if (
      !imminentNoticeDue({
        now,
        scheduledFor: request.scheduled_for,
        alreadySent: request.imminent_notice_at !== null,
      })
    ) {
      continue;
    }

    /*
     * Only the personal arm gets a second notice, and the asymmetry is honest rather
     * than an oversight. A company closure's audience is a cohort — its own owners
     * and admins, plus every counterparty with a live engagement — and a second
     * round to counterparties a day out would tell them nothing the first did not,
     * while a company that is still blocked has a live `blocked_reason` on the screen
     * its owners are already watching. A person has no such screen unless they sign
     * in, which is exactly what somebody about to be erased has stopped doing.
     */
    if (request.scope !== 'PERSONAL' || !request.subject_user_id) continue;

    await withTransaction(async (client) => {
      await enqueueOutboxEvent(
        {
          topic: 'account.closure_imminent',
          aggregateType: 'DELETION_REQUEST',
          aggregateId: request.id,
          companyId: null,
          payload: {
            requestId: request.id,
            recipientUserId: request.subject_user_id,
            scheduledFor: request.scheduled_for.toISOString(),
          },
          idempotencyKey: `account.closure_imminent:${request.id}`,
        },
        client
      );
    });
    warned += 1;
  }

  return warned;
}

export async function runClosurePass(now = new Date()): Promise<ClosurePassResult> {
  const recovered = await recoverStaleClosureClaims();
  const warned = await sendImminentClosureNotices(now);
  const run = await runDueClosures();
  return { ...run, warned, recovered };
}
