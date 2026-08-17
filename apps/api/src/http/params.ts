import type { Request } from 'express';
import { AppError } from './errors';

/** Read a required string path parameter, narrowing away undefined/array types. */
export function param(req: Request, name: string): string {
  const value = (req.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('VALIDATION', `Missing path parameter: ${name}`);
  }
  return value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read a path parameter that will be compared against a `uuid` column.
 *
 * Rejecting at the edge beats letting Postgres raise `22P02` mid-query: the
 * request never reaches the database, and the response says "not found" rather
 * than distinguishing "malformed id" from "id that isn't yours" — the same answer
 * every scoped lookup already gives for someone else's row.
 *
 * `errorHandler` also maps `22P02` for the routes still using plain `param`, so
 * a malformed id is never a 500 either way.
 */
export function uuidParam(req: Request, name: string): string {
  const value = param(req, name);
  if (!UUID_RE.test(value)) {
    throw new AppError('NOT_FOUND', 'Not found');
  }
  return value;
}
