/**
 * Structured logging (CREWQUO_V2_PLAN.md §787).
 * Operating-model packet: `docs/operating-model/observability-data-lifecycle.md`
 * §7 and §14 step 2.
 *
 * **The support model already committed to this file existing.** `access.md` §13.3
 * refused platform support access — no impersonation, no per-tenant operator read
 * — on the strength of the sentence that followed it: a customer problem is
 * diagnosed from audit rows and logs. That makes a log line the *entire*
 * diagnostic surface an operator has, rather than a convenience, and it makes the
 * previous state of it a real gap: an unhandled error was logged as a bare stack
 * trace, so the one permitted tool could not answer which tenant hit this or how
 * often.
 *
 * **The field set is an allowlist in the type system, not a convention.** Every
 * field a log line may carry is a named property of `LogFields` below; there is no
 * index signature and no `extra`, so adding a field is a deliberate edit to this
 * file rather than something a call site can do on its own. That is the shape §7
 * asks for, and the reason is that the way a log line stops being operational data
 * and becomes personal data is one useful-looking field at a time — an email here
 * to save a lookup, a request body there to debug a validation error. A denylist
 * of known-bad keys would have to be extended by whoever adds the next field,
 * which is exactly the person who did not read this comment.
 *
 * So: no bodies, no headers, no tokens, no secrets, no email addresses, no names,
 * and no populated paths. A populated path is a record of which resources a person
 * touched, which is the movement log `access.md` §7 already refused to build in the
 * session table — refusing it there and rebuilding it in the log directory would be
 * the same mistake with a different storage engine.
 */

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Everything a log line may contain. Identifiers, never the human behind them.
 *
 * All optional because the emitters differ: a request has a route and a status, a
 * job has a name and an attempt, and a boot message has neither.
 */
export interface LogFields {
  /** Correlates every line produced while serving one request. */
  requestId?: string;
  /** Correlates the deferred work a request caused, across processes. */
  jobId?: string;
  /** The queue or job name, for scheduled work. */
  job?: string;
  attempt?: number;

  /** Tenant and actor as identifiers. Never the email, never the name. */
  companyId?: string | null;
  userId?: string | null;

  method?: string;
  /**
   * The route **template** (`/v1/projects/:id`), never the populated path.
   * Null for a request that matched no route.
   */
  route?: string | null;
  status?: number;
  durationMs?: number;

  /** The error's own code from the envelope, and its constructor name. */
  errorCode?: string;
  errorClass?: string;

  /** Counts and durations for a job pass. Numbers only, by design. */
  claimed?: number;
  succeeded?: number;
  failed?: number;
  deadLettered?: number;
}

/**
 * One line of JSON on stdout, which is what every host this deploys to collects.
 *
 * Not a logging library: the whole behaviour is "serialise an allowlisted object
 * and write it", the interesting part is the allowlist above, and a dependency
 * whose defaults capture more than they are asked to is the specific risk §10 of
 * the packet names about error trackers. `console` is the transport for the same
 * reason it already is everywhere else in this codebase.
 */
export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  const line: Record<string, unknown> = { level, msg: message };

  // Undefined keys are dropped rather than serialised as null: a line that says
  // `"userId": null` asserts there was no user, and a line that omits it says
  // nothing either way. An unauthenticated request should look like the second.
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) line[key] = value;
  }

  const serialised = JSON.stringify(line);
  if (level === 'error') console.error(serialised);
  else if (level === 'warn') console.warn(serialised);
  else console.log(serialised);
}

/**
 * The `route` field for a request, as a template.
 *
 * Express exposes the matched path in two halves — `baseUrl` is where the router
 * was mounted and `route.path` is the pattern inside it — and neither alone is
 * the template. Joined here rather than at each call site so the populated path
 * has no route into a log line by accident.
 *
 * **Null is a real answer**, and it is what an unmatched request gets: there is no
 * template, and reporting the URL instead would put a populated path in the field
 * whose whole purpose is not to hold one.
 */
export function routeTemplate(req: {
  baseUrl?: string;
  route?: { path?: string | string[] } | undefined;
}): string | null {
  const path = req.route?.path;
  if (path === undefined) return null;
  // A route registered with an array of paths matched one of them; which one is
  // not recoverable here, and joining them describes the registration rather
  // than the request. Nothing in this API registers arrays today.
  const suffix = Array.isArray(path) ? path.join('|') : path;
  const base = req.baseUrl ?? '';
  const joined = `${base}${suffix}`;
  // A router mounted at '/v1/me' with a route at '/' joins to '/v1/me/'.
  return joined.length > 1 && joined.endsWith('/') ? joined.slice(0, -1) : joined;
}
