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
