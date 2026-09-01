export const DELIVERY_MAX_ATTEMPTS = 8;
const BASE_DELAY_SECONDS = 15;
const MAX_DELAY_SECONDS = 60 * 60;

/** Deterministic exponential backoff: 15s, 30s, 60s … capped at one hour. */
export function retryDelaySeconds(failedAttempt: number): number {
  const exponent = Math.max(0, Math.floor(failedAttempt) - 1);
  return Math.min(BASE_DELAY_SECONDS * 2 ** exponent, MAX_DELAY_SECONDS);
}

export function deliveryFailureState(input: {
  failedAttempt: number;
  retryable: boolean;
  maxAttempts?: number;
}): { status: 'PENDING' | 'DEAD_LETTER'; delaySeconds: number | null } {
  const maxAttempts = input.maxAttempts ?? DELIVERY_MAX_ATTEMPTS;
  if (!input.retryable || input.failedAttempt >= maxAttempts) {
    return { status: 'DEAD_LETTER', delaySeconds: null };
  }
  return { status: 'PENDING', delaySeconds: retryDelaySeconds(input.failedAttempt) };
}

export class PermanentDeliveryError extends Error {}

/**
 * The event is well-formed and will be applicable later, so it must neither
 * succeed nor consume a retry.
 *
 * The retry budget is deliberately short — eight attempts over about seventy
 * minutes — because it exists for a provider that is briefly unreachable. It is
 * the wrong instrument for waiting on a *person*: an additional-company
 * subscription arrives the moment somebody pays, and the company it belongs to
 * does not exist until they come back and create it, which the approval window
 * gives them thirty days to do. Retrying would dead-letter a paid subscription
 * within the hour and leave it needing an operator to notice and replay.
 *
 * Bounded by the waited-on thing's own lifecycle, never by this class: a handler
 * that defers must be able to say when waiting has become pointless, and raise a
 * `PermanentDeliveryError` then.
 */
export class DeferredDeliveryError extends Error {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = 'DeferredDeliveryError';
    this.retryAfterSeconds = Math.max(1, Math.floor(retryAfterSeconds));
  }
}
