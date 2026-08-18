import { describe, expect, it } from 'vitest';
import { deliveryFailureState, retryDelaySeconds } from './model';

describe('durable delivery retry policy', () => {
  it('backs off exponentially and caps the delay at one hour', () => {
    expect([1, 2, 3, 4].map(retryDelaySeconds)).toEqual([15, 30, 60, 120]);
    expect(retryDelaySeconds(20)).toBe(3600);
  });

  it('retries transient failures until the attempt budget is exhausted', () => {
    expect(deliveryFailureState({ failedAttempt: 2, retryable: true })).toEqual({
      status: 'PENDING', delaySeconds: 30,
    });
    expect(deliveryFailureState({ failedAttempt: 8, retryable: true })).toEqual({
      status: 'DEAD_LETTER', delaySeconds: null,
    });
  });

  it('dead-letters a permanent failure immediately', () => {
    expect(deliveryFailureState({ failedAttempt: 1, retryable: false })).toEqual({
      status: 'DEAD_LETTER', delaySeconds: null,
    });
  });
});
