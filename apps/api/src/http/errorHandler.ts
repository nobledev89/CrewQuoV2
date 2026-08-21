import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { captureException } from '../observability/errorTracking';
import { log, routeTemplate } from '../observability/log';
import { AppError, TokenRejected, type ErrorCode } from './errors';
import { appErrorForPgError } from './pgErrors';

/** 404 for unmatched routes — emits the standard error envelope. */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Route not found', ...reference(req) },
  });
};

/**
 * The correlation id, as an envelope fragment.
 *
 * Spread rather than assigned so a request that somehow has none omits the key
 * instead of publishing `"requestId": null`, which would read as an assertion
 * that the request had no id rather than that this response could not name it.
 */
function reference(req: Request): { requestId?: string } {
  return req.requestId === undefined ? {} : { requestId: req.requestId };
}

function envelope(req: Request, code: ErrorCode, message: string, details?: unknown) {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      ...reference(req),
    },
  };
}

/**
 * What the log line says about a failure, beside the request fields.
 *
 * **The message is logged, the details are not.** An `AppError` message is written
 * for the person who hit it and is safe; `details` is a Zod flatten, which is a
 * map of field names to the values that failed validation — customer input, and
 * therefore exactly the personal and commercial data §7 keeps out of a log line.
 * The field name is in the response the caller already has.
 */
function logFailure(req: Request, status: number, code: string, err: unknown): void {
  log(status >= 500 ? 'error' : 'warn', 'request_failed', requestFields(req, status, code, err));
}

/** The §7 fields describing one failed request. Shared so the log line and the tracker
 *  cannot disagree about what a request is called — an operator pivots between them by
 *  `requestId`, and a pivot only works if both sides spell it the same way. */
function requestFields(req: Request, status: number, code: string, err: unknown) {
  return {
    requestId: req.requestId,
    companyId: req.ctx?.companyId ?? undefined,
    userId: req.ctx?.userId ?? undefined,
    method: req.method,
    route: routeTemplate(req),
    status,
    errorCode: code,
    errorClass: err instanceof Error ? err.constructor.name : typeof err,
  };
}

/** Terminal error middleware: maps AppError / ZodError / unknown to the envelope. */
export const errorHandler: ErrorRequestHandler = (err, req: Request, res, _next) => {
  if (err instanceof AppError) {
    /*
     * The one 401 a client can act on says so in the field reserved for it.
     *
     * Without this, "your fifteen minutes are up" and "the password you typed into
     * this form is wrong" are the same response, and a client that recovers from the
     * first would rotate its refresh token over the second. See `TokenRejected`.
     *
     * No `realm` and no `error=` parameter: a realm names a protection space this API
     * does not partition, and the RFC 6750 error codes would put the reason a token
     * failed on the wire — which §9 keeps off it deliberately, since "expired" versus
     * "revoked" tells whoever holds a stolen one whether the theft was noticed.
     */
    if (err instanceof TokenRejected) res.setHeader('WWW-Authenticate', 'Bearer');
    // Not logged as a failure. An AppError is the API working: a 403 on a route
    // somebody may not use, a 409 on a resubmit. Logging every one at warn would
    // bury the lines that mean something under the ones that mean the rules held,
    // and the request line from `requestContext` already carries the status.
    res.status(err.status).json(envelope(req, err.code, err.message, err.details));
    return;
  }

  if (err instanceof ZodError) {
    res.status(422).json(envelope(req, 'VALIDATION', 'Validation failed', err.flatten()));
    return;
  }

  // A caller-provokable Postgres error (a malformed uuid, a unique violation)
  // is a 4xx, not a 500. Still logged: a mapped 23505 usually means a repo
  // skipped its uniqueness pre-check, and a silent 409 would hide that.
  const fromPg = appErrorForPgError(err);
  if (fromPg) {
    logFailure(req, fromPg.status, fromPg.code, err);
    res.status(fromPg.status).json(envelope(req, fromPg.code, fromPg.message));
    return;
  }

  // Unexpected. Logged with the request that caused it rather than as a bare
  // stack trace: before this, an operator had the trace and no way to learn which
  // tenant hit it, how often, or whether it was the customer who just wrote in.
  logFailure(req, 500, 'INTERNAL', err);
  /*
   * Reported to the tracker as well, and only from this branch.
   *
   * The three branches above are the API working — a refused permission, a rejected
   * body, a caller-provokable Postgres error — and sending them would fill the tracker
   * with the rules holding. What arrives here is only what nothing anticipated, which is
   * the population "how many, since when" is a useful question about.
   */
  captureException(err, requestFields(req, 500, 'INTERNAL', err));
  // The stack itself, on its own line and only here. It is the one payload worth
  // more than the structure, and it is never a customer's data.
  console.error(`[api] unhandled error (request ${req.requestId ?? 'unknown'}):`, err);
  res.status(500).json(envelope(req, 'INTERNAL', 'Internal server error'));
};
