import { pool } from '../db';
import { recoverStaleInboxClaims, recoverStaleOutboxClaims } from '../modules/delivery/repo';
import { runInboxBatch, runOutboxBatch } from '../modules/delivery/worker';
import { runNotificationDeliveryBatch } from '../modules/notifications/deliveryWorker';
import { NOTIFICATION_HANDLERS } from '../modules/notifications/handlers';
import { recordJobRun } from './jobRuns';
import { BILLING_INBOX_HANDLERS } from '../modules/billing/reconcile';
import { runStorageBatch } from '../modules/storage/worker';
import { runDocumentExpiryBatch } from '../modules/documents/expiry';
import { runStorageAgeingBatch } from '../modules/assets/storageAgeing';

/**
 * The process that actually drains the durable substrate.
 *
 * **Until this existed, nothing called `runOutboxBatch`.** 0012 built the outbox,
 * the leases, the retry policy and the dead-letter replay, and company creation
 * emitted into it — but no process ever claimed a row, so every event sat
 * `PENDING` forever. The substrate was correct and inert. This is the caller.
 *
 * Run it two ways, both one-shot from the outside:
 *
 *   pnpm --filter @crewquo/api work            # one pass, then exit
 *   pnpm --filter @crewquo/api work -- --loop  # keep passing until interrupted
 *
 * One-shot is the deployable shape, for the same reason the audit purge is
 * (`auditPurge.cli.ts`): an external scheduler restarts a dead job, whereas a
 * `setInterval` inside the API server silently stops draining the moment that one
 * process falls over, and does nothing at all if the API is scaled to zero. The
 * loop exists for local development, where running a scheduler is friction.
 *
 * Two passes per cycle, in this order:
 *   1. `runOutboxBatch` turns domain events into inbox rows.
 *   2. `runNotificationDeliveryBatch` sends the intrusive channels for rows that
 *      already exist.
 * Ordering matters only in that (1) creates work for (2); a cycle that does (2)
 * first simply picks it up on the next pass.
 */

const LOOP = process.argv.includes('--loop');
const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 5000);
const WORKER_ID = `${process.pid}@${process.env.HOSTNAME ?? 'local'}`;

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Finish the pass in flight rather than abandoning a claimed lease: an
    // abandoned one is recoverable, but only after the stale-claim timeout.
    stopping = true;
  });
}

async function pass(): Promise<{ claimed: number; succeeded: number; failed: number }> {
  const [recoveredOutbox, recoveredInbox] = await Promise.all([
    recoverStaleOutboxClaims(),
    recoverStaleInboxClaims(),
  ]);
  if (recoveredOutbox > 0) console.log(`[workers] recovered ${recoveredOutbox} stale outbox lease(s)`);
  if (recoveredInbox > 0) console.log(`[workers] recovered ${recoveredInbox} stale inbox lease(s)`);

  const inbox = await runInboxBatch({ workerId: WORKER_ID, handlers: BILLING_INBOX_HANDLERS });
  if (inbox.claimed > 0) {
    console.log(
      `[workers] webhooks claimed=${inbox.claimed} processed=${inbox.processed} ` +
        `deferred=${inbox.deferred} failed=${inbox.failed}`
    );
  }

  /*
   * Storage scanning and derivatives (0027). A third consumer of this pass rather
   * than a fourth scheduler, for the reason §14 step 1 records: the failure mode
   * of deferred work is not a crash, it is silence, and every new schedule is one
   * more thing that can stop quietly.
   */
  const storage = await runStorageBatch();
  if (storage.scanned > 0 || storage.expired > 0) {
    console.log(
      `[workers] files scanned=${storage.scanned} ready=${storage.ready} ` +
        `failed=${storage.failed} derivatives=${storage.derivatives} expired=${storage.expired}`
    );
  }

  /*
   * Document expiry (0031). Runs BEFORE the outbox drain rather than after, so a
   * document that crossed a rung overnight is noticed and delivered in the same
   * pass — otherwise every warning is a full scheduler interval late, which for a
   * once-a-day scheduler means the 7-day warning arrives on day 6.
   */
  const expiry = await runDocumentExpiryBatch();
  if (expiry.onLadder > 0) {
    console.log(`[workers] documents scanned=${expiry.scanned} onLadder=${expiry.onLadder}`);
  }

  /*
   * Storage ageing (§25.4). The fifth pass, beside the expiry ladder above and
   * before the outbox drain for the same reason: a line that crossed 30 days
   * overnight is noticed and delivered in one pass, rather than a full scheduler
   * interval later.
   *
   * **It is the only enforcement locked decision #18 has.** Storage counting
   * toward no rate is correct and completely silent; this is the thing that
   * looks.
   */
  const ageing = await runStorageAgeingBatch();
  if (ageing.ageing > 0) {
    console.log(`[workers] storage scanned=${ageing.scanned} ageing=${ageing.ageing}`);
  }

  const outbox = await runOutboxBatch({ workerId: WORKER_ID, handlers: NOTIFICATION_HANDLERS });
  if (outbox.claimed > 0) {
    console.log(
      `[workers] outbox claimed=${outbox.claimed} delivered=${outbox.delivered} failed=${outbox.failed}`
    );
  }

  const deliveries = await runNotificationDeliveryBatch();
  if (deliveries.claimed > 0) {
    console.log(
      `[workers] notifications claimed=${deliveries.claimed} sent=${deliveries.sent} ` +
        `skipped=${deliveries.skipped} failed=${deliveries.failed}`
    );
  }

  // Both halves in one set of counts, because they are scheduled as one unit and
  // a split would let one report success for the pair.
  return {
    claimed: inbox.claimed + outbox.claimed + deliveries.claimed,
    succeeded: inbox.processed + outbox.delivered + deliveries.sent,
    failed: inbox.failed + outbox.failed + deliveries.failed,
  };
}

try {
  if (LOOP) {
    console.log(`[workers] looping every ${INTERVAL_MS}ms as ${WORKER_ID} (Ctrl-C to stop)`);
    while (!stopping) {
      // A thrown pass must not kill the loop: one poisonous row would otherwise
      // stop every other tenant's notifications. The row itself is already
      // recorded as failed by the batch, and dead-letters on its own budget.
      await pass().catch((err) => console.error('[workers] pass failed:', err));
      if (stopping) break;
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
    console.log('[workers] stopped');
  } else {
    /*
     * Only the one-shot arm records a run, and the asymmetry is deliberate.
     * `--loop` is the local-development shape (`workers.cli.ts` header), where a
     * developer's laptop writing "the schedule is alive" into a shared database
     * would be a heartbeat for a scheduler that does not exist in production. The
     * one-shot arm is what the scheduler invokes, so it is what gets to say the
     * scheduler ran.
     */
    await recordJobRun('workers', pass);
    console.log('[workers] done');
  }
} catch (err) {
  console.error('[workers] failed:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
