/**
 * The error-event scrubber.
 *
 * Operating-model packet: `docs/operating-model/observability-data-lifecycle.md`
 * §7, §10 and §14 step 3, and owner decision §13.3 — *"Sentry, scrubber first."*
 *
 * **The ordering is the decision, not an implementation note.** The failure mode of
 * adopting an error tracker is not failing to adopt one; it is one release sending
 * request bodies to a third party before anybody notices, and that cannot be sent back.
 * So this file and its tests exist with no tracker installed, and the tracker is wired to
 * it rather than the other way round. Nothing here imports a Sentry package — the shape
 * below is deliberately structural, so the scrubber can be proved exhaustively offline
 * and cannot be made to depend on the version of an SDK it is defending against.
 *
 * **It is an allowlist that rebuilds the event, not a filter that deletes from it.** That
 * distinction is the whole design. A denylist of known-bad keys (`password`, `token`,
 * `authorization`, …) has to be extended by whoever adds the next field, who is exactly
 * the person who has not read this comment — and worse, it has to be extended by whoever
 * upgrades the SDK, because a tracker's value *is* the context it attaches without being
 * asked. `scrubEvent` therefore constructs a new object from named fields and drops
 * everything it was not explicitly told to keep, including keys that did not exist when
 * it was written. That property has its own test.
 *
 * Sentry's three richest sources of personal and commercial data are all default-on and
 * all dropped here:
 *   - **request bodies** (`request.data`) — a rate card, an invoice line, a password;
 *   - **headers and cookies** (`request.headers`, `request.cookies`) — the bearer token
 *     that authenticated the request, which would turn an error report into a credential;
 *   - **stack-frame local variables** (`…frames[].vars`) — the least obvious and the
 *     worst, because it captures whatever happened to be in scope at the throw. The
 *     frame that hashes a password has the password in scope.
 */

/** What a tracker hands `beforeSend`: unknown shape, hostile by default. */
export type RawEvent = Record<string, unknown>;

/** A stack frame, reduced to what points at a line of code and nothing else. */
export interface ScrubbedFrame {
  filename?: string;
  function?: string;
  module?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}

export interface ScrubbedException {
  /** The error's constructor name — `TypeError`, `AppError`, `DatabaseError`. */
  type?: string;
  stacktrace?: { frames: ScrubbedFrame[] };
}

/**
 * An event with nothing in it that identifies a person or discloses a record.
 *
 * `tags` carries the §7 log fields so an operator can pivot from a customer's quoted
 * request id to the event, which is the entire point of minting that id.
 */
export interface ScrubbedEvent {
  event_id?: string;
  timestamp?: number | string;
  level?: string;
  platform?: string;
  environment?: string;
  release?: string;
  server_name?: string;
  transaction?: string;
  logger?: string;
  sdk?: { name?: string; version?: string };
  exception?: { values: ScrubbedException[] };
  /** Identifier only. Never an email, a username or an IP. */
  user?: { id: string };
  tags?: Record<string, string>;
  contexts?: { trace?: Record<string, string | number>; runtime?: { name?: string; version?: string } };
}

/**
 * The tags a scrubbed event may carry, and the reason the list is short.
 *
 * These are precisely `log.ts`'s `LogFields` minus the counters: the same allowlist,
 * because an operator correlating a Sentry event with a log line needs the two to agree
 * on what a request is called. Adding one here without adding it there produces a pivot
 * that works in one direction only.
 */
const ALLOWED_TAGS = [
  'requestId',
  'jobId',
  'job',
  'companyId',
  'userId',
  'method',
  'route',
  'status',
  'errorCode',
  'errorClass',
] as const;

/**
 * Trace fields kept for performance correlation. Ids and numbers, no names.
 *
 * `trace` is allowed where every other context is not, because span ids are generated
 * by the tracer and describe the shape of a request rather than its content — and
 * without them a performance event cannot be joined to the transaction it belongs to.
 */
const ALLOWED_TRACE_FIELDS = ['trace_id', 'span_id', 'parent_span_id', 'op', 'status'] as const;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A frame's location, with `vars` and everything else structurally unable to survive.
 *
 * `pre_context`/`context_line`/`post_context` are dropped along with `vars`, and that is
 * deliberate rather than incidental: they are the source lines around the throw, so on a
 * minified server build they are noise and on an unminified one they are this
 * repository's source code being copied into a third party's storage.
 */
function scrubFrame(raw: unknown): ScrubbedFrame | null {
  const frame = asRecord(raw);
  if (!frame) return null;
  const out: ScrubbedFrame = {};
  const filename = asString(frame.filename);
  if (filename !== undefined) out.filename = filename;
  const fn = asString(frame.function);
  if (fn !== undefined) out.function = fn;
  const mod = asString(frame.module);
  if (mod !== undefined) out.module = mod;
  const lineno = asNumber(frame.lineno);
  if (lineno !== undefined) out.lineno = lineno;
  const colno = asNumber(frame.colno);
  if (colno !== undefined) out.colno = colno;
  if (typeof frame.in_app === 'boolean') out.in_app = frame.in_app;
  return out;
}

/**
 * One exception, reduced to its class and its stack.
 *
 * **`value` — the error message — is deliberately not kept, and it is the most expensive
 * line in this file.** It is also the one §7 already settled: a log line carries "the
 * error code and class", and a message is neither. The reason is that the messages worth
 * reading are exactly the ones that quote data. Postgres embeds the conflicting value in
 * a unique-violation (`Key (email)=(sam@example.com) already exists`), Zod embeds the
 * input it rejected, and a hand-written `throw new Error(\`no rate card for ${roleName}\`)`
 * embeds a customer's role catalog. There is no way to keep the useful ones and drop the
 * rest, because they are the same messages.
 *
 * What is lost is real: grouping gets coarser and an operator reads a stack rather than a
 * sentence. What replaces it is the `errorCode` tag — the envelope's own stable code,
 * which is the part of a refusal that was always meant to be published.
 */
function scrubException(raw: unknown): ScrubbedException | null {
  const value = asRecord(raw);
  if (!value) return null;
  const out: ScrubbedException = {};
  const type = asString(value.type);
  if (type !== undefined) out.type = type;
  const stack = asRecord(value.stacktrace);
  const frames = stack?.frames;
  if (Array.isArray(frames)) {
    const scrubbed = frames.map(scrubFrame).filter((f): f is ScrubbedFrame => f !== null);
    out.stacktrace = { frames: scrubbed };
  }
  return out;
}

/**
 * Rebuild `raw` as an event containing only allowlisted fields.
 *
 * Shaped to be passed straight to a tracker's `beforeSend`. It never throws and never
 * returns the object it was given: a scrubber that could throw would, in the hands of an
 * SDK that swallows `beforeSend` errors, fail open and send the unscrubbed event — the
 * one outcome this file exists to make impossible.
 */
export function scrubEvent(raw: RawEvent | null | undefined): ScrubbedEvent | null {
  const event = asRecord(raw);
  if (!event) return null;

  const out: ScrubbedEvent = {};

  const eventId = asString(event.event_id);
  if (eventId !== undefined) out.event_id = eventId;
  const timestamp = asNumber(event.timestamp) ?? asString(event.timestamp);
  if (timestamp !== undefined) out.timestamp = timestamp;
  const level = asString(event.level);
  if (level !== undefined) out.level = level;
  const platform = asString(event.platform);
  if (platform !== undefined) out.platform = platform;
  const environment = asString(event.environment);
  if (environment !== undefined) out.environment = environment;
  const release = asString(event.release);
  if (release !== undefined) out.release = release;
  const serverName = asString(event.server_name);
  if (serverName !== undefined) out.server_name = serverName;
  const logger = asString(event.logger);
  if (logger !== undefined) out.logger = logger;

  /*
   * `transaction` is a route template where the tracker was given one, and a populated
   * path where it was not — `/v1/projects/8f2c…` is a record of which resource somebody
   * touched, which §7 refuses in a log line and cannot be allowed in a tag either. So it
   * survives only if it contains no path segment that looks like an identifier. The
   * check is on shape rather than on a list of known id formats, because the next id
   * format will not be on the list.
   */
  const transaction = asString(event.transaction);
  if (transaction !== undefined && !hasIdentifierSegment(transaction)) out.transaction = transaction;

  const sdk = asRecord(event.sdk);
  if (sdk) {
    const name = asString(sdk.name);
    const version = asString(sdk.version);
    if (name !== undefined || version !== undefined) {
      out.sdk = {};
      if (name !== undefined) out.sdk.name = name;
      if (version !== undefined) out.sdk.version = version;
    }
  }

  const exception = asRecord(event.exception);
  if (exception && Array.isArray(exception.values)) {
    out.exception = {
      values: exception.values
        .map(scrubException)
        .filter((v): v is ScrubbedException => v !== null),
    };
  }

  /*
   * The user is an id and nothing else. Sentry populates `ip_address` with `{{auto}}` by
   * default and `email`/`username` from any `setUser` call, and all three are dropped
   * here rather than by remembering not to set them.
   */
  const user = asRecord(event.user);
  const userId = user ? asString(user.id) : undefined;
  if (userId !== undefined) out.user = { id: userId };

  const tags = asRecord(event.tags);
  if (tags) {
    const kept: Record<string, string> = {};
    for (const key of ALLOWED_TAGS) {
      const value = tags[key];
      if (typeof value === 'string' && value !== '') kept[key] = value;
      else if (typeof value === 'number' && Number.isFinite(value)) kept[key] = String(value);
    }
    // A `route` tag is a template by construction at the call site, but a tag is a string
    // somebody can set, so it is checked here too rather than trusted twice.
    if (kept.route !== undefined && hasIdentifierSegment(kept.route)) delete kept.route;
    if (Object.keys(kept).length > 0) out.tags = kept;
  }

  const contexts = asRecord(event.contexts);
  if (contexts) {
    const trace = asRecord(contexts.trace);
    const runtime = asRecord(contexts.runtime);
    const keptContexts: NonNullable<ScrubbedEvent['contexts']> = {};
    if (trace) {
      const keptTrace: Record<string, string | number> = {};
      for (const key of ALLOWED_TRACE_FIELDS) {
        const value = trace[key];
        if (typeof value === 'string' && value !== '') keptTrace[key] = value;
        else if (typeof value === 'number' && Number.isFinite(value)) keptTrace[key] = value;
      }
      if (Object.keys(keptTrace).length > 0) keptContexts.trace = keptTrace;
    }
    if (runtime) {
      const name = asString(runtime.name);
      const version = asString(runtime.version);
      if (name !== undefined || version !== undefined) {
        keptContexts.runtime = {};
        if (name !== undefined) keptContexts.runtime.name = name;
        if (version !== undefined) keptContexts.runtime.version = version;
      }
    }
    if (Object.keys(keptContexts).length > 0) out.contexts = keptContexts;
  }

  return out;
}

/**
 * Does this path contain a segment that looks like an identifier rather than a word?
 *
 * Shape, not a list of formats. A uuid, a 20-character nanoid and a numeric id have
 * nothing in common except *not looking like a route word*, and a list of known formats
 * would need extending the first time an id style changes — which is the denylist
 * mistake this whole file is written against, in miniature.
 *
 * So a segment fails if it contains a digit and is not a version prefix like `v1`, or if
 * it is long and has no separator a human word would have. `/v1/projects/:id` passes,
 * `/v1/projects/8f2c1e40-…` does not, and `/v1/invoices/1042` does not.
 */
export function hasIdentifierSegment(path: string): boolean {
  for (const segment of path.split('/')) {
    if (segment === '' || segment.startsWith(':')) continue;
    if (/^v\d+$/.test(segment)) continue;
    if (/\d/.test(segment)) return true;
    if (segment.length >= 21 && !/[-_.]/.test(segment)) return true;
  }
  return false;
}
