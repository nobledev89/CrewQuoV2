import {
  claimOutboxEvents,
  claimInboxEvents,
  completeInboxEvent,
  completeOutboxEvent,
  deferInboxEvent,
  failInboxEvent,
  type InboxEvent,
  failOutboxEvent,
  type OutboxEvent,
} from './repo';
import { DeferredDeliveryError, PermanentDeliveryError } from './model';

export type DeliveryHandler = (event: OutboxEvent) => Promise<void>;
export type InboxHandler = (event: InboxEvent) => Promise<void>;

/** Process one bounded batch. Persistence and leases live in Postgres, not memory. */
export async function runOutboxBatch(input: {
  workerId: string;
  handlers: ReadonlyMap<string, DeliveryHandler>;
  limit?: number;
}): Promise<{ claimed: number; delivered: number; failed: number }> {
  const events = await claimOutboxEvents(input.workerId, [...input.handlers.keys()], input.limit);
  let delivered = 0;
  let failed = 0;
  for (const event of events) {
    const handler = input.handlers.get(event.topic)!;
    try {
      await handler(event);
      await completeOutboxEvent(event.id, input.workerId);
      delivered += 1;
    } catch (err) {
      await failOutboxEvent({
        id: event.id,
        workerId: input.workerId,
        currentAttempts: event.attempts,
        error: err instanceof Error ? err.message : String(err),
        retryable: !(err instanceof PermanentDeliveryError),
      });
      failed += 1;
    }
  }
  return { claimed: events.length, delivered, failed };
}

/** Process signature-verified inbound provider events from the durable inbox. */
export async function runInboxBatch(input: {
  workerId: string;
  handlers: ReadonlyMap<string, InboxHandler>;
  limit?: number;
}): Promise<{ claimed: number; processed: number; deferred: number; failed: number }> {
  const events = await claimInboxEvents(input.workerId, [...input.handlers.keys()], input.limit);
  let processed = 0;
  let deferred = 0;
  let failed = 0;
  for (const event of events) {
    const handler = input.handlers.get(event.provider)!;
    try {
      await handler(event);
      await completeInboxEvent(event.id, input.workerId);
      processed += 1;
    } catch (err) {
      // Deferral is checked before failure because it is not one: the handler is
      // telling us the event is valid but early, and counting an attempt would
      // eventually dead-letter it for that.
      if (err instanceof DeferredDeliveryError) {
        await deferInboxEvent({
          id: event.id,
          workerId: input.workerId,
          delaySeconds: err.retryAfterSeconds,
          reason: err.message,
        });
        deferred += 1;
        continue;
      }
      await failInboxEvent({
        id: event.id,
        workerId: input.workerId,
        currentAttempts: event.attempts,
        error: err instanceof Error ? err.message : String(err),
        retryable: !(err instanceof PermanentDeliveryError),
      });
      failed += 1;
    }
  }
  return { claimed: events.length, processed, deferred, failed };
}
