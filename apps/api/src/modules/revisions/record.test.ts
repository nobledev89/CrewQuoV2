import { describe, expect, it } from 'vitest';
import { changedFields } from './record';

/**
 * `changedFields` is the part of the §36 trail that has to be right without a
 * database: it decides what a "amended N times — view history" panel claims
 * actually changed. Computed from before/after rather than declared by the caller,
 * so these cases pin that a caller cannot over- or under-report a change.
 */
describe('changedFields', () => {
  it('reports nothing when the values are identical', () => {
    expect(changedFields({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toEqual([]);
  });

  it('reports only the keys whose value actually moved', () => {
    expect(changedFields({ a: 1, b: 'x' }, { a: 2, b: 'x' })).toEqual(['a']);
  });

  it('does not treat null → null as a change', () => {
    expect(changedFields({ a: null }, { a: null })).toEqual([]);
  });

  it('treats null → value and value → null as changes', () => {
    expect(changedFields({ a: null }, { a: 1 })).toEqual(['a']);
    expect(changedFields({ a: 1 }, { a: null })).toEqual(['a']);
  });

  it('compares by value, so 0 and false are distinct from null', () => {
    expect(changedFields({ a: 0 }, { a: null })).toEqual(['a']);
    expect(changedFields({ a: false }, { a: null })).toEqual(['a']);
    expect(changedFields({ a: 0 }, { a: 0 })).toEqual([]);
  });

  it('picks up a key present on only one side', () => {
    expect(changedFields({ a: 1 }, { a: 1, b: 2 })).toEqual(['b']);
    expect(changedFields({ a: 1, b: 2 }, { a: 1 })).toEqual(['b']);
  });

  it('compares nested values structurally', () => {
    expect(changedFields({ a: { x: 1 } }, { a: { x: 1 } })).toEqual([]);
    expect(changedFields({ a: { x: 1 } }, { a: { x: 2 } })).toEqual(['a']);
  });

  it('lists every key on a CREATE (no before) and a DELETE (no after)', () => {
    expect(changedFields(null, { b: 2, a: 1 })).toEqual(['a', 'b']);
    expect(changedFields({ b: 2, a: 1 }, null)).toEqual(['a', 'b']);
    expect(changedFields(null, null)).toEqual([]);
  });

  it('returns keys sorted, so a diff reads the same every time', () => {
    expect(changedFields({ z: 1, a: 1, m: 1 }, { z: 2, a: 2, m: 2 })).toEqual(['a', 'm', 'z']);
  });
});
