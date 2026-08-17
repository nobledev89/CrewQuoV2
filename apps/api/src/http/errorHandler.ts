import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, type ErrorCode } from './errors';
import { appErrorForPgError } from './pgErrors';

/** 404 for unmatched routes — emits the standard error envelope. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
};

function envelope(code: ErrorCode, message: string, details?: unknown) {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/** Terminal error middleware: maps AppError / ZodError / unknown to the envelope. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json(envelope(err.code, err.message, err.details));
    return;
  }

  if (err instanceof ZodError) {
    res.status(422).json(envelope('VALIDATION', 'Validation failed', err.flatten()));
    return;
  }

  // A caller-provokable Postgres error (a malformed uuid, a unique violation)
  // is a 4xx, not a 500. Still logged: a mapped 23505 usually means a repo
  // skipped its uniqueness pre-check, and a silent 409 would hide that.
  const fromPg = appErrorForPgError(err);
  if (fromPg) {
    console.error('[api] database error mapped to', fromPg.code, '-', err);
    res.status(fromPg.status).json(envelope(fromPg.code, fromPg.message));
    return;
  }

  // Unexpected: log server-side, never leak internals to the client.
  console.error('[api] unhandled error:', err);
  res.status(500).json(envelope('INTERNAL', 'Internal server error'));
};
