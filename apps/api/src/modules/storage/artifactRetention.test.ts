import { describe, expect, it } from 'vitest';
import { artifactRetentionDue } from './artifactRetention';

describe('artifact retention policy', () => {
  const now = new Date('2030-01-01T00:00:00.000Z');

  it('keeps unlimited and unconfigured plans indefinitely', () => {
    expect(artifactRetentionDue(new Date('2000-01-01T00:00:00Z'), now, null)).toBe(false);
    expect(artifactRetentionDue(new Date('2000-01-01T00:00:00Z'), now, undefined)).toBe(false);
  });

  it('becomes due exactly at the retained-day boundary', () => {
    expect(artifactRetentionDue(new Date('2029-12-02T00:00:00Z'), now, 30)).toBe(true);
    expect(artifactRetentionDue(new Date('2029-12-03T00:00:00Z'), now, 30)).toBe(false);
  });
});
