import {
  claimOutboxEvents,
  completeOutboxEvent,
  failOutboxEvent,
  type OutboxEvent,
} from './repo';
import { PermanentDeliveryError } from './model';

export type DeliveryHandler = (event: OutboxEvent) => Promise<void>;

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
