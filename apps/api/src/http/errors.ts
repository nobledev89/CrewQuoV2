/** Error codes returned in the API error envelope (CREWQUO_V2_PLAN.md §7). */
export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'LIMIT_EXCEEDED'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 422,
  LIMIT_EXCEEDED: 402,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/** An error that maps directly to an API error envelope + HTTP status. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export const unauthenticated = (msg = 'Authentication required') =>
  new AppError('UNAUTHENTICATED', msg);
export const forbidden = (msg = 'You do not have access to this resource') =>
  new AppError('FORBIDDEN', msg);
export const notFound = (msg = 'Not found') => new AppError('NOT_FOUND', msg);
export const validation = (msg = 'Validation failed', details?: unknown) =>
  new AppError('VALIDATION', msg, details);
export const limitExceeded = (msg: string, details?: unknown) =>
  new AppError('LIMIT_EXCEEDED', msg, details);
export const conflict = (msg = 'Conflict') => new AppError('CONFLICT', msg);

/**
 * A 401 raised because the **bearer token itself** was rejected — missing, invalid,
 * expired, or naming a session or an account that no longer exists.
 *
 * A separate type because a client can do something about this one and nothing about
 * the others. `stepUp.ts` answers a mistyped password with 401 as well (§4 re-auth),
 * and to a client that treated every 401 alike, "your access token aged out" and "the
 * password you just typed is wrong" are the same event. It would then rotate its
 * refresh token on every typo — and, if that rotation lost a race, sign the person
 * out of a session that was never in question. Rotating credentials in response to a
 * step-up refusal also inverts what step-up is for: proof of a live human, not proof
 * that the client can mint another token.
 *
 * Carried to the caller as `WWW-Authenticate: Bearer` rather than as a new error
 * code, because that is the field RFC 9110 §11.6.1 already reserves for exactly this
 * ("the 401 response ... MUST send a WWW-Authenticate header field") and the §7
 * envelope stays precisely as specified. The API had been omitting it on every 401,
 * so this is conformance rather than invention.
 */
export class TokenRejected extends AppError {
  constructor(message: string) {
    super('UNAUTHENTICATED', message);
    this.name = 'TokenRejected';
  }
}
