import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The wiring, proved against the real SDK rather than against the scrubber alone.
 *
 * `packages/shared/src/scrub.test.ts` already proves the policy exhaustively as a pure
 * function. What it cannot prove is that the policy is *reached*: a `beforeSend` attached
 * to the wrong option name, an integration collecting locals, or `sendDefaultPii` left on
 * would all pass every one of those 35 tests and still put a bearer token in a third
 * party's storage.
 *
 * So this initialises Sentry for real with a stub transport, throws an error with secrets
 * in its message and in the scope, and asserts nothing sensitive reaches the wire. The
 * assertion is over the whole serialised envelope, not over fields, because the field
 * that leaks will be one nobody thought to check.
 *
 * `vi.resetModules()` and dynamic imports because `env` is parsed once at import time —
 * the same technique the signing-key ring test uses, and for the same reason: a boot-time
 * configuration read can only be tested by re-booting the module.
 */

const SECRET = 'MUST-NOT-LEAK';
/** A syntactically valid DSN pointing at a host nothing will contact — the stub
 *  transport replaces the network entirely, so this only has to parse. */
const FAKE_DSN = 'https://0123456789abcdef0123456789abcdef@o0.ingest.sentry.io/0';

const ORIGINAL_ENV = { ...process.env };

/** Envelopes the SDK tried to send, captured instead of transmitted. */
let sent: unknown[] = [];

beforeEach(() => {
  sent = [];
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/**
 * Boot the module under a given environment and hand back its exports.
 *
 * `initErrorTracking` takes a transport, and that is the only thing this test
 * substitutes. Patching the SDK's own `init` was the first attempt and is not possible —
 * an ES module namespace object's exports are non-configurable, so `vi.spyOn` throws
 * "Cannot redefine property" — but the narrow seam is the better answer anyway: every
 * other option, and in particular `beforeSend` and the reduced integration list, is the
 * production configuration while these assertions run against it.
 */
const capturingTransport = () => ({
  send: async (envelope: unknown) => {
    sent.push(envelope);
    return {};
  },
  flush: async () => true,
});

async function bootWith(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const Sentry = await import('@sentry/node');
  const mod = await import('./errorTracking');
  return { mod, Sentry };
}

describe('error tracking', () => {
  it('is skipped, with a reason, when no DSN is configured', async () => {
    const { mod } = await bootWith({ SENTRY_DSN: undefined });
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(mod.initErrorTracking(capturingTransport)).toBe('skipped');
    expect(mod.errorTrackingState()).toBe('skipped');
    // Silence and "not configured" are indistinguishable to an operator otherwise,
    // and the difference matters most after a deploy that dropped the DSN.
    expect(info.mock.calls.flat().join(' ')).toContain('error_tracking_skipped');
    info.mockRestore();
  });

  it('sends nothing at all while skipped, so an unconfigured deploy cannot leak', async () => {
    const { mod } = await bootWith({ SENTRY_DSN: undefined });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mod.initErrorTracking(capturingTransport);

    mod.captureException(new Error(SECRET), { requestId: 'r1', companyId: 'c1' });
    expect(sent).toHaveLength(0);
  });

  it('initialises when a DSN is present', async () => {
    const { mod } = await bootWith({ SENTRY_DSN: FAKE_DSN });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(mod.initErrorTracking(capturingTransport)).toBe('enabled');
    expect(mod.errorTrackingState()).toBe('enabled');
  });

  it('lets nothing sensitive reach the wire, from message, scope or locals', async () => {
    const { mod, Sentry } = await bootWith({ SENTRY_DSN: FAKE_DSN, SENTRY_RELEASE: 'test@1' });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mod.initErrorTracking(capturingTransport);

    /*
     * A function that has secrets in scope when it throws, which is the case the
     * `localVariables` integration exists to capture and the reason it is removed.
     */
    function hashAndFail(): never {
      const password = SECRET;
      const email = `${SECRET}@example.com`;
      void password;
      void email;
      // Message quoting data, exactly as Postgres and Zod do.
      throw new Error(`duplicate key: Key (email)=(${SECRET}@example.com) already exists`);
    }

    try {
      hashAndFail();
    } catch (err) {
      mod.captureException(err, {
        requestId: 'req-1',
        companyId: 'co-1',
        userId: 'user-1',
        method: 'POST',
        route: '/v1/rate-cards',
        status: 500,
        errorCode: 'INTERNAL',
        errorClass: 'Error',
      });
    }

    await Sentry.flush(2000);

    expect(sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(sent)).not.toContain(SECRET);
  });

  it('still carries the identifiers an operator pivots on', async () => {
    const { mod, Sentry } = await bootWith({ SENTRY_DSN: FAKE_DSN });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mod.initErrorTracking(capturingTransport);

    mod.captureException(new Error('boom'), { requestId: 'req-42', companyId: 'co-7', userId: 'user-9' });
    await Sentry.flush(2000);

    // A scrubbed event that kept nothing would pass the leak test and be useless; the
    // request id is the whole reason it is minted, so its presence is asserted too.
    const wire = JSON.stringify(sent);
    expect(wire).toContain('req-42');
    expect(wire).toContain('co-7');
  });

  it('does not send the request object, breadcrumbs or frame locals', async () => {
    const { mod, Sentry } = await bootWith({ SENTRY_DSN: FAKE_DSN });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mod.initErrorTracking(capturingTransport);

    Sentry.addBreadcrumb({ category: 'fetch', message: `GET /v1/users?email=${SECRET}@x.com` });
    mod.captureException(new Error('boom'), { requestId: 'r1' });
    await Sentry.flush(2000);

    const wire = JSON.stringify(sent);
    expect(wire).not.toContain('breadcrumbs');
    expect(wire).not.toContain('"vars"');
    expect(wire).not.toContain(SECRET);
  });
});
