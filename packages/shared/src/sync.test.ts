import { describe, expect, it } from 'vitest';
import {
  CAPTURE_TIMESTAMPS,
  detectConflict,
  isServerAttested,
  mergeFieldwise,
  mutationEnvelopeSchema,
  tombstoneVisibleTo,
} from './sync';

describe('detectConflict', () => {
  it('allows a write that matches what the caller read', () => {
    expect(detectConflict({ expected: 3, actual: 3, deletedAt: null })).toBeNull();
  });

  it('refuses a write composed against an older version', () => {
    const conflict = detectConflict({ expected: 2, actual: 5, deletedAt: null });
    expect(conflict?.code).toBe('STALE_REVISION');
    expect(conflict?.message).toContain('Somebody else changed this');
  });

  it('refuses a write claiming a version that does not exist here', () => {
    // A client ahead of the server is not a lost update — it is a client talking
    // to a different database, or a replayed body from a restored backup. The
    // message has to differ or the operator chases the wrong problem.
    const conflict = detectConflict({ expected: 9, actual: 4, deletedAt: null });
    expect(conflict?.code).toBe('STALE_REVISION');
    expect(conflict?.message).toContain('does not exist here');
  });

  it('allows a write that makes no claim, which is the browser-form case', () => {
    // The guarantee is available to anyone who asks for it and imposed on nobody
    // who does not — a person looking at the screen they are editing needs no
    // version negotiation.
    expect(detectConflict({ actual: 7, deletedAt: null })).toBeNull();
  });

  it('refuses any write against a tombstone, claim or no claim', () => {
    expect(detectConflict({ expected: 3, actual: 3, deletedAt: '2026-09-01T00:00:00.000Z' })?.code).toBe(
      'GONE'
    );
    expect(detectConflict({ actual: 3, deletedAt: '2026-09-01T00:00:00.000Z' })?.code).toBe('GONE');
  });

  it('reports GONE ahead of STALE_REVISION when both are true', () => {
    // The client's next move differs: a queued edit for a deleted record should
    // be abandoned, not re-composed.
    expect(
      detectConflict({ expected: 1, actual: 9, deletedAt: '2026-09-01T00:00:00.000Z' })?.code
    ).toBe('GONE');
  });
});

describe('mergeFieldwise', () => {
  const base = { delays: 'none', weather: 'dry', notes: 'a' };

  it('applies an edit to a field nobody else touched', () => {
    const result = mergeFieldwise({
      base,
      incoming: { delays: 'concrete late' },
      current: { ...base, weather: 'wet' },
    });
    expect(result.merged).toEqual({ delays: 'concrete late' });
    expect(result.applied).toEqual(['delays']);
    expect(result.conflicted).toEqual([]);
  });

  it('leaves untouched fields out of the write entirely', () => {
    // A field the editor did not touch is never written, which is what stops this
    // re-applying stale values it merely happens to know.
    const result = mergeFieldwise({
      base,
      incoming: { delays: 'x' },
      current: { ...base, weather: 'wet', notes: 'b' },
    });
    expect(Object.keys(result.merged)).toEqual(['delays']);
  });

  it('reports a field both sides moved to different values', () => {
    const result = mergeFieldwise({
      base,
      incoming: { weather: 'sunny' },
      current: { ...base, weather: 'wet' },
    });
    expect(result.conflicted).toEqual(['weather']);
    expect(result.merged).toEqual({});
  });

  it('treats an identical concurrent edit as already applied, not as a conflict', () => {
    // Two supervisors typing "wet" is not a disagreement, and prompting somebody
    // to resolve it would be the machinery inventing work.
    const result = mergeFieldwise({
      base,
      incoming: { weather: 'wet' },
      current: { ...base, weather: 'wet' },
    });
    expect(result.conflicted).toEqual([]);
    expect(result.applied).toEqual(['weather']);
    expect(result.merged).toEqual({});
  });

  it('preserves a colleague\'s paragraph while accepting mine', () => {
    // The whole reason this exists: a diary has fourteen independent free-text
    // fields, and whole-row last-write-wins silently deletes somebody's work.
    const result = mergeFieldwise({
      base,
      incoming: { delays: 'crane booked late' },
      current: { ...base, notes: 'Ade: client walked the floor at 14:00' },
    });
    expect(result.merged).toEqual({ delays: 'crane booked late' });
    expect(result.merged).not.toHaveProperty('notes');
  });

  it('handles null moving to a value and back', () => {
    const nulls = { reason: null as string | null };
    expect(
      mergeFieldwise({ base: nulls, incoming: { reason: 'x' }, current: { reason: null } }).applied
    ).toEqual(['reason']);
    expect(
      mergeFieldwise({ base: nulls, incoming: { reason: 'x' }, current: { reason: 'y' } }).conflicted
    ).toEqual(['reason']);
  });

  it('compares objects by value rather than by identity', () => {
    const withObj = { tags: { a: 1 } };
    const result = mergeFieldwise({
      base: withObj,
      incoming: { tags: { a: 2 } },
      // A structurally identical object arriving from the database is not a
      // concurrent change, and reference equality would call it one every time.
      current: { tags: { a: 1 } },
    });
    expect(result.applied).toEqual(['tags']);
  });

  it('is a no-op for an empty edit', () => {
    const result = mergeFieldwise({ base, incoming: {}, current: base });
    expect(result).toEqual({ merged: {}, conflicted: [], applied: [] });
  });
});

describe('tombstoneVisibleTo', () => {
  it('tells a caller who could have read the record', () => {
    expect(tombstoneVisibleTo({ callerCouldHaveRead: true })).toBe(true);
  });

  it('tells nobody else, so it is never an oracle for another tenant\'s ids', () => {
    // Separating "gone" from "not yours" is the point of a tombstone and also the
    // way it becomes a disclosure if it is told carelessly.
    expect(tombstoneVisibleTo({ callerCouldHaveRead: false })).toBe(false);
  });
});

describe('the three timestamps', () => {
  it('names all three', () => {
    expect(Object.keys(CAPTURE_TIMESTAMPS).sort()).toEqual([
      'capturedAt',
      'effectiveDate',
      'recordedAt',
    ]);
  });

  it('attests to exactly one of them', () => {
    // A device clock is settable by the person holding it, and a project date is
    // a human's claim. Only the server's own timestamp is evidence.
    expect(isServerAttested('recordedAt')).toBe(true);
    expect(isServerAttested('capturedAt')).toBe(false);
    expect(isServerAttested('effectiveDate')).toBe(false);
  });
});

describe('mutationEnvelopeSchema', () => {
  it('accepts an empty envelope, so nothing existing becomes a migration', () => {
    expect(mutationEnvelopeSchema.safeParse({}).success).toBe(true);
  });

  it('refuses a client id that is not a uuid', () => {
    // Two clients choosing `batch-1` would collide, and the collision returns one
    // of them the other's response body.
    expect(mutationEnvelopeSchema.safeParse({ clientId: 'batch-1' }).success).toBe(false);
  });

  it('refuses a revision below 1, since an insert is 1', () => {
    expect(mutationEnvelopeSchema.safeParse({ expectedRevision: 0 }).success).toBe(false);
    expect(mutationEnvelopeSchema.safeParse({ expectedRevision: 1 }).success).toBe(true);
  });
});
