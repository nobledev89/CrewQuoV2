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
