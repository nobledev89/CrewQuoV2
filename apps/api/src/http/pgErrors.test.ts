import { describe, expect, it } from 'vitest';
import { AppError } from './errors';
import { appErrorForPgError, isPgError } from './pgErrors';

/**
 * A malformed path parameter used to surface as `500 Internal server error` on
 * every `:id` route in the app — the id reached a `uuid` column and Postgres
 * raised 22P02. These pin the mapping that makes those honest 4xx responses.
 */

/** The shape node-postgres throws: a 5-char SQLSTATE plus `severity`. */
function pgError(code: string, extra: Record<string, unknown> = {}): unknown {
  return Object.assign(new Error(`pg error ${code}`), {
    code,
    severity: 'ERROR',
    ...extra,
  });
}

describe('isPgError', () => {
  it('recognises a driver error by SQLSTATE + severity', () => {
    expect(isPgError(pgError('22P02'))).toBe(true);
  });
  it('does not claim ordinary errors', () => {
    expect(isPgError(new Error('boom'))).toBe(false);
    expect(isPgError(new AppError('NOT_FOUND', 'nope'))).toBe(false);
  });
  it('does not claim a Node error whose `code` is not a SQLSTATE', () => {
    // ECONNREFUSED and friends must stay 500s — they are genuinely our problem.
    expect(isPgError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(false);
    expect(isPgError(Object.assign(new Error('x'), { code: '22P02' }))).toBe(false); // no severity
  });
  it('is safe on null and primitives', () => {
    expect(isPgError(null)).toBe(false);
    expect(isPgError(undefined)).toBe(false);
    expect(isPgError('22P02')).toBe(false);
  });
});

describe('appErrorForPgError', () => {
  it('maps a malformed uuid to 422, not 500', () => {
    const mapped = appErrorForPgError(pgError('22P02'));
    expect(mapped?.code).toBe('VALIDATION');
    expect(mapped?.status).toBe(422);
  });

  it('maps the other invalid-representation codes the same way', () => {
    for (const code of ['22003', '22007', '22008']) {
      expect(appErrorForPgError(pgError(code))?.status).toBe(422);
    }
  });

  it('maps a unique violation to 409', () => {
    const mapped = appErrorForPgError(pgError('23505', { constraint: 'companies_name_key' }));
    expect(mapped?.code).toBe('CONFLICT');
    expect(mapped?.status).toBe(409);
  });

  it('maps constraint violations to 422', () => {
    for (const code of ['23503', '23502', '23514']) {
      expect(appErrorForPgError(pgError(code))?.code).toBe('VALIDATION');
    }
  });

  it('leaves a genuine server fault unmapped so it stays a 500', () => {
    // 42P08 is the "could not determine data type of parameter" class — a bug in
    // our SQL, not the caller's request. It must not be dressed up as a 4xx.
    expect(appErrorForPgError(pgError('42P08'))).toBeNull();
    // 08006 connection_failure, 53300 too_many_connections: infrastructure.
    expect(appErrorForPgError(pgError('08006'))).toBeNull();
    expect(appErrorForPgError(pgError('53300'))).toBeNull();
  });

  it('never leaks the driver message to the client', () => {
    const mapped = appErrorForPgError(pgError('22P02', { detail: 'value "abc" at row 3' }));
    expect(mapped?.message).not.toContain('abc');
    expect(mapped?.message).not.toContain('row 3');
  });

  it('returns null for anything that is not a driver error', () => {
    expect(appErrorForPgError(new Error('boom'))).toBeNull();
    expect(appErrorForPgError(null)).toBeNull();
  });
});
