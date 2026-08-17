import { describe, expect, it } from 'vitest';
import { auditExpiry } from './retention';

describe('auditExpiry', () => {
  it('treats null (the entitlements "unlimited") as never expiring', () => {
    expect(auditExpiry(null)).toEqual({ kind: 'infinity' });
  });

  it('skips the write when the plan grants no retention', () => {
    expect(auditExpiry(0)).toEqual({ kind: 'skip' });
  });

  it('skips when the plan has no audit_retention_days at all', () => {
    // Misconfiguration: fail closed rather than silently retaining forever.
    expect(auditExpiry(undefined)).toEqual({ kind: 'skip' });
  });

  it('maps the seeded plan windows to day counts', () => {
    expect(auditExpiry(30)).toEqual({ kind: 'days', days: 30 }); // Starter
    expect(auditExpiry(90)).toEqual({ kind: 'days', days: 90 }); // Pro
    expect(auditExpiry(365)).toEqual({ kind: 'days', days: 365 }); // Business
  });

  it('floors fractional days and rejects negatives', () => {
    expect(auditExpiry(7.9)).toEqual({ kind: 'days', days: 7 });
    expect(auditExpiry(-5)).toEqual({ kind: 'skip' });
  });
});
