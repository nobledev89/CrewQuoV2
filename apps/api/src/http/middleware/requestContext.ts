import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { log, routeTemplate } from '../../observability/log';

/**
 * Request correlation (`observability-data-lifecycle.md` §14 step 2).
 *
 * Mints one id per request, puts it on the response so a customer can quote it,
 * and logs the request's outcome once it has one. This is the thing that turns
 * "it says something went wrong" into a single row an operator can find, without
 * reading any of that customer's records — which is the only support model
 * `access.md` §13.3 left available.
 */

declare global {
  namespace Express {
    interface Request {
      /** Correlates every log line, and every outbox row, this request produces. */
      requestId?: string;
    }
  }
}

/** Response header a customer, a browser devtools pane and a support ticket share. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * **The id is always minted here and never taken from the caller.**
 *
 * Accepting an inbound `X-Request-Id` is the conventional thing to do and is wrong
 * for this API's position: it is the public edge, not an internal hop behind a
 * trusted gateway. A caller-supplied id lets anybody choose what their traffic is
 * filed under — reusing one id for ten thousand requests to make a support search
 * useless, or reusing *somebody else's* id to attach their own activity to another
 * tenant's investigation. Neither is exotic, and both are free.
 *
 * The cost of refusing is that a future internal caller cannot pass its trace
 * through. When there is one, it gets its own field alongside this one rather than
 * being allowed to overwrite it, so an operator can always tell which id the
 * platform chose.
 */
export const requestContext: RequestHandler = (req, res, next) => {
  const requestId = randomUUID();
  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  const startedAt = process.hrtime.bigint();

  /*
   * `finish` rather than wrapping `res.json`, because it fires for every way a
   * response can end — including the ones that skip the handler entirely, which
   * are the ones worth having a line for.
   *
   * The context is read *inside* the callback on purpose: `requireAuth` sets
   * `req.ctx` after this middleware runs, so reading it up front would log every
   * request as anonymous and lose the tenant field on all of them.
   */
  res.on('finish', () => {
    const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000n) / 1000;
    const level = res.statusCode >= 500 ? 'error' : 'info';

    log(level, 'request', {
      requestId,
      companyId: req.ctx?.companyId ?? undefined,
      userId: req.ctx?.userId ?? undefined,
      method: req.method,
      route: routeTemplate(req),
      status: res.statusCode,
      durationMs,
    });
  });

  next();
};
