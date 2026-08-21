import * as Sentry from '@sentry/node';
import type { NodeOptions } from '@sentry/node';
import { scrubEvent, type RawEvent } from '@crewquo/shared';
import { env } from '../env';
import { log, type LogFields } from './log';

/**
 * Error tracking (§13.3, §14 step 3 of
 * `docs/operating-model/observability-data-lifecycle.md`).
 *
 * **The scrubber was written and proved before this file existed, and that ordering is
 * the owner's decision rather than a preference.** The failure mode of adopting an error
 * tracker is not failing to adopt one — it is one release sending request bodies to a
 * third party before anybody notices, and that cannot be sent back. So
 * `packages/shared/src/scrub.ts` carries the policy with 35 tests and no SDK import, and
 * this file is the wiring that cannot send anything the scrubber has not rebuilt.
 *
 * **Three defaults are turned off, and each one is default-*on* in the SDK.**
 *   - `sendDefaultPii: false` — otherwise the SDK attaches the client IP and, with the
 *     Express integration, request headers and cookies.
 *   - `beforeSend: scrubEvent` — the allowlist rebuild, which is the actual guarantee.
 *     Everything above it is belt to the scrubber's braces: if `sendDefaultPii` were
 *     flipped by a later edit, the scrubber still drops what it adds.
 *   - `beforeSendTransaction` gets the same treatment, because a performance event
 *     carries `transaction` — a populated path where the tracer could not name a route,
 *     which §7 refuses in a log line and cannot allow in a span name either.
 *
 * `integrations` is *reduced*, not extended. The default set includes
 * `localVariables`, which attaches the locals of every frame in a stack — the single
 * richest source of secrets in the process, since the frame that hashes a password has
 * the password in scope. The scrubber drops frame `vars` anyway; removing the
 * integration means they are never collected, so there is no window in which a
 * misconfigured `beforeSend` could pass them on.
 */

/** Why tracking is or is not running, decided once at boot and logged once. */
export type TrackingState = 'enabled' | 'skipped';

let state: TrackingState = 'skipped';

/**
 * Initialise error tracking, or say why it is not running.
 *
 * Called from the API bootstrap. Returns the state so the caller and the tests can
 * assert it rather than inferring it from a log line.
 *
 * **Unconfigured is `skipped` with a reason, not silence** — the same rule the email
 * adapter follows. A tracker that is not running looks exactly like a tracker with
 * nothing to report, and the difference matters most in the week after a deploy that
 * dropped the DSN.
 */
export function initErrorTracking(transport?: NodeOptions['transport']): TrackingState {
  if (!env.SENTRY_DSN) {
    state = 'skipped';
    log('info', 'error_tracking_skipped');
    return state;
  }

  Sentry.init({
    /*
     * The only injectable seam, and deliberately the *only* one.
     *
     * A test has to be able to see what would go on the wire, and the alternative — a
     * `Partial<Options>` override — would let a test replace `beforeSend` and then prove
     * nothing at all. Narrowing the seam to the transport means every line below is the
     * shipped configuration when the suite runs against it. Production passes nothing.
     */
    ...(transport ? { transport } : {}),
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    release: env.SENTRY_RELEASE,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    sendDefaultPii: false,
    /*
     * The default integration list minus the ones that collect what §7 forbids.
     *
     * `localVariables` is the important removal. `requestData` is removed as well: its
     * job is to attach the request — headers, cookies, query, body — and while the
     * scrubber deletes the whole `request` object, not collecting it at all is the
     * difference between a policy and a habit. What is kept is the machinery that turns
     * a Node error into a stack trace.
     */
    integrations: (defaults) =>
      defaults.filter((i) => i.name !== 'LocalVariables' && i.name !== 'RequestData'),
    beforeSend: (event) => scrubEvent(event as unknown as RawEvent) as never,
    beforeSendTransaction: (event) => scrubEvent(event as unknown as RawEvent) as never,
  });

  state = 'enabled';
  log('info', 'error_tracking_enabled', { errorClass: env.SENTRY_RELEASE ? 'released' : 'unreleased' });
  return state;
}

/** What the tracker is currently doing. Exported for the operator console and tests. */
export function errorTrackingState(): TrackingState {
  return state;
}

/**
 * Report an unexpected failure, tagged with the fields an operator navigates by.
 *
 * The tags are set on an isolated scope rather than globally: a global `setTag` on a
 * shared process leaks one request's `companyId` onto the next request's event, which is
 * a cross-tenant disclosure produced entirely by the diagnostics.
 *
 * A no-op when tracking is skipped, so the caller never has to ask. The log line is
 * written either way by `errorHandler` — a tracker is an addition to the operational
 * record, never a replacement for it, because the record is what §13.3 promised support
 * would be run from.
 */
export function captureException(err: unknown, fields: LogFields = {}): void {
  if (state !== 'enabled') return;
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(fields)) {
      // Stringified because a Sentry tag is a string, and numbers arriving as numbers
      // are silently dropped by some SDK versions rather than coerced.
      if (value !== undefined && value !== null) scope.setTag(key, String(value));
    }
    if (fields.userId !== undefined && fields.userId !== null) scope.setUser({ id: fields.userId });
    Sentry.captureException(err);
  });
}
