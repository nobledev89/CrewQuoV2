import { AppError } from './errors';

/**
 * Map a Postgres error to the API error envelope (CREWQUO_V2_PLAN.md §7).
 *
 * Without this, a caller who sends `/v1/projects/not-a-uuid` gets a 500: the id
 * reaches a `uuid` column, Postgres raises `22P02`, and an unrecognised throw
 * falls through to "Internal server error". That is a lie — nothing internal
 * went wrong, the request was malformed — and it is true of every `:id` route in
 * the app, so the fix belongs here rather than in forty handlers.
 *
 * Mapped codes are still **logged** by the error handler. A `23505` usually means
 * a repo skipped a uniqueness pre-check, and turning it into a clean 409 without
 * a log line would hide the missing guard.
 *
 * Duck-typed rather than `instanceof pg.DatabaseError` so the HTTP layer keeps no
 * dependency on the driver; `severity` + a 5-character SQLSTATE is a shape only
 * Postgres produces.
 */
interface PgErrorShape {
  code: string;
  severity: string;
  constraint?: string;
  detail?: string;
}

export function isPgError(err: unknown): err is PgErrorShape {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  return (
    typeof e.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(e.code) &&
    typeof e.severity === 'string'
  );
}

/**
 * A unique violation, optionally from one named constraint.
 *
 * For the callers who use an index *as* their concurrency control rather than
 * pre-checking — a partial unique index on (subject, non-terminal status) is what
 * makes two clicks one closure request, the same shape
 * `company_creation_requests_one_open_per_user` uses. Those callers need to turn one
 * specific collision into one specific sentence, which the generic mapping above
 * cannot: "That record already exists" is not an answer to "close my account".
 *
 * **`constraintContains` is not optional in spirit.** Catching every `23505` and
 * reporting it as the collision you were expecting is how an unrelated uniqueness
 * bug gets reported to a customer as "a closure is already scheduled", and then
 * never found.
 */
export function isUniqueViolation(err: unknown, constraintContains?: string): boolean {
  if (!isPgError(err) || err.code !== '23505') return false;
  if (constraintContains === undefined) return true;
  return (err.constraint ?? '').includes(constraintContains);
}

/** Returns an AppError for the SQLSTATEs a caller can provoke, else null. */
export function appErrorForPgError(err: unknown): AppError | null {
  if (!isPgError(err)) return null;

  switch (err.code) {
    // 22P02 invalid_text_representation, 22003 numeric_value_out_of_range,
    // 22007/22008 invalid or out-of-range datetime. All mean "that value can
    // never be this column's type" — a malformed request, not a server fault.
    case '22P02':
    case '22003':
    case '22007':
    case '22008':
      return new AppError('VALIDATION', 'Malformed value in the request');

    // 23505 unique_violation — the row already exists.
    case '23505':
      return new AppError('CONFLICT', 'That record already exists');

    // 23503 foreign_key_violation, 23502 not_null_violation,
    // 23514 check_violation — the request references or omits something invalid.
    case '23503':
    case '23502':
    case '23514':
      return new AppError('VALIDATION', 'The request references invalid data');

    default:
      return null; // genuinely unexpected — let it be a 500
  }
}
