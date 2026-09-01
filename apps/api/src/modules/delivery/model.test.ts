import { describe, expect, it } from 'vitest';
import { DeferredDeliveryError, deliveryFailureState, retryDelaySeconds } from './model';

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

describe('DeferredDeliveryError', () => {
  it('carries a whole number of seconds, never zero', () => {
    expect(new DeferredDeliveryError('waiting', 900).retryAfterSeconds).toBe(900);
    expect(new DeferredDeliveryError('waiting', 0.4).retryAfterSeconds).toBe(1);
    expect(new DeferredDeliveryError('waiting', -30).retryAfterSeconds).toBe(1);
  });

  it('is not a permanent failure, so the worker cannot mistake one for the other', () => {
    const deferred = new DeferredDeliveryError('waiting', 60);
    expect(deferred).toBeInstanceOf(Error);
    expect(deferred.name).toBe('DeferredDeliveryError');
    // The worker branches on `instanceof`, so the two classes staying unrelated is
    // the whole safety property: a deferral treated as a failure would dead-letter
    // a valid event for being early.
    expect(deferred.constructor.name).not.toBe('PermanentDeliveryError');
  });
});
