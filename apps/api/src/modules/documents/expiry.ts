import {
  DOCUMENT_EXPIRY_THRESHOLDS,
  daysUntil,
  documentExpiryEventPayload,
  expiryThreshold,
} from '@crewquo/shared';
import { withTransaction } from '../../db';
import { enqueueOutboxEvent } from '../delivery/repo';
import { findExpiringDocuments } from './repo';

/**
 * The expiry scan (§24, packet §5).
 *
 * **A fourth consumer of the existing `work` pass rather than a fourth
 * scheduler**, for the reason the observability packet's §14 step 1 records and
 * the storage scan already follows: the failure mode of deferred work is not a
 * crash, it is silence, and every new schedule is one more thing that can stop
 * without anybody noticing.
 *
 * **`document.expiring` ships with a consumer, deliberately departing from the
 * packet's §5 note that it would ship without one.** The reason given there — that
 * the event's *shape* should be decided by whoever knows what a document is,
 * rather than by whoever writes the alert in Phase 12 — is satisfied by this file
 * regardless of whether a handler is registered. What is not satisfied by an
 * unconsumed producer is anything else: `claimOutboxEvents` filters on the
 * registered topic list, so an event with no handler is never claimed, never
 * retried, never dead-lettered and never counted as a backlog. This repository
 * already has 3,578 of those from four topics, found while chasing an unrelated
 * flake. Adding a fifth knowingly, in the same phase that recorded the fault,
 * would be the wrong kind of faithfulness to a spec.
 *
 * What Phase 12 still owns is the **escalation**: who else is told at 14 days,
 * whether it becomes urgent, and the compliance surface that lists everything
 * lapsing across a portfolio. The durable Action Centre item lands here, which is
 * what `notifications.md` requires of every kind anyway — email is never the only
 * copy of a task.
 */

export interface DocumentExpiryResult {
  scanned: number;
  /**
   * Documents sitting on a rung this pass — **not** how many notifications were
   * newly created.
   *
   * `enqueueOutboxEvent` upserts and returns the row's id either way, so it cannot
   * report whether the key was new, and a count named `enqueued` would claim a
   * novelty it has no way to know. A document 45 days out is on the 60 rung every
   * morning for a fortnight and appears in this number every time. Reporting what
   * was actually measured beats reporting what would be more interesting.
   */
  onLadder: number;
}

/** The widest rung, which is how far ahead the query has to look. */
const WIDEST = Math.max(...DOCUMENT_EXPIRY_THRESHOLDS);
const BATCH = 500;

export async function runDocumentExpiryBatch(): Promise<DocumentExpiryResult> {
  const result: DocumentExpiryResult = { scanned: 0, onLadder: 0 };

  const candidates = await findExpiringDocuments({ widestThresholdDays: WIDEST, limit: BATCH });
  for (const doc of candidates) {
    result.scanned += 1;

    /*
     * The arithmetic is pure and the calendar is Postgres's. `today` came back
     * from the query as the *project owner's* current date in its own IANA zone,
     * so a document does not expire a day early for everybody east of the server —
     * the same rule `time.md` settled for the monthly upload meter.
     */
    const daysRemaining = daysUntil(doc.expires_on, doc.today);
    const threshold = expiryThreshold(daysRemaining);
    if (threshold === null) continue;

    /*
     * Keyed on (document, threshold), which is §5's key and is what makes a daily
     * scan safe to run daily. A document sitting at 45 days for a fortnight
     * re-enqueues the same key every morning and enqueues nothing new, because
     * `delivery_outbox` refuses the duplicate on its own unique index — so no
     * column here has to remember what has already been sent, and there is no
     * second, weaker copy of that fact to go wrong.
     */
    await withTransaction((client) =>
      enqueueOutboxEvent(
        {
          topic: 'document.expiring',
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: doc.id,
          companyId: doc.owner_company_id,
          payload: documentExpiryEventPayload({
            documentId: doc.id,
            projectId: doc.project_id,
            ownerCompanyId: doc.owner_company_id,
            providerCompanyId: doc.provider_company_id,
            category: doc.category,
            version: doc.version,
            threshold,
            daysRemaining,
          }),
          idempotencyKey: `document.expiring:${doc.id}:${threshold}`,
        },
        client
      )
    );
    result.onLadder += 1;
  }

  return result;
}
