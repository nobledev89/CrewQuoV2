import { describe, expect, it } from 'vitest';
import { hasIdentifierSegment, scrubEvent, type RawEvent } from './scrub';

/**
 * Every value below that must not survive is the same string, so a single search of a
 * serialised event answers "did anything leak" without enumerating where it might be.
 */
const SECRET = 'MUST-NOT-LEAK';

/**
 * A Sentry event with personal or commercial data in every place the SDK puts it by
 * default. Built as one fixture rather than several so the "nothing leaks" assertion is
 * over the whole event at once — a per-field test passes while the field next to it leaks.
 */
function hostileEvent(): RawEvent {
  return {
    event_id: 'abc123',
    timestamp: 1_755_000_000,
    level: 'error',
    platform: 'node',
    environment: 'production',
    release: 'crewquo@1.4.2',
    server_name: 'api-7f9c',
    transaction: 'POST /v1/rate-cards',
    logger: 'express',
    sdk: { name: 'sentry.javascript.node', version: '8.0.0' },

    // The message. Postgres and Zod both quote the data that failed.
    exception: {
      values: [
        {
          type: 'DatabaseError',
          value: `duplicate key value violates unique constraint: Key (email)=(${SECRET}@example.com) already exists`,
          stacktrace: {
            frames: [
              {
                filename: '/app/src/modules/rates/routes.ts',
                function: 'createRateCard',
                lineno: 88,
                colno: 12,
                in_app: true,
                // The worst of the three, and default-on: whatever was in scope.
                vars: { password: SECRET, email: `${SECRET}@example.com`, rateCents: 9200 },
                pre_context: [`const secret = '${SECRET}'`],
                context_line: `await hash('${SECRET}')`,
                post_context: [`return ${SECRET}`],
              },
            ],
          },
        },
      ],
    },

    // Bodies, headers and cookies.
    request: {
      url: `https://api.crewquo.com/v1/rate-cards?email=${SECRET}@example.com`,
      method: 'POST',
      data: { password: SECRET, baseCents: 9200 },
      headers: { authorization: `Bearer ${SECRET}`, cookie: `session=${SECRET}` },
      cookies: { session: SECRET },
      query_string: `email=${SECRET}@example.com`,
      env: { REMOTE_ADDR: '203.0.113.7' },
    },

    user: {
      id: 'user-uuid-1',
      email: `${SECRET}@example.com`,
      username: SECRET,
      ip_address: '203.0.113.7',
    },

    tags: {
      requestId: 'req-1',
      companyId: 'co-1',
      userId: 'user-uuid-1',
      method: 'POST',
      route: '/v1/rate-cards',
      status: 500,
      errorCode: 'INTERNAL',
      errorClass: 'DatabaseError',
      // Not on the allowlist.
      customerEmail: `${SECRET}@example.com`,
      companyName: SECRET,
    },

    extra: { requestBody: { password: SECRET }, note: SECRET },
    breadcrumbs: [
      { category: 'fetch', message: `GET /v1/users?email=${SECRET}@example.com` },
      { category: 'console', message: SECRET },
    ],
    contexts: {
      trace: { trace_id: 't1', span_id: 's1', op: 'http.server' },
      runtime: { name: 'node', version: '22.10.0' },
      // Not on the allowlist.
      state: { state: { form: { password: SECRET } } },
      device: { name: SECRET },
    },
    modules: { [`pkg-${SECRET}`]: '1.0.0' },
    fingerprint: [SECRET],
  };
}

describe('scrubEvent', () => {
  it('lets nothing sensitive through, from anywhere in a hostile event', () => {
    const scrubbed = scrubEvent(hostileEvent());
    expect(JSON.stringify(scrubbed)).not.toContain(SECRET);
  });

  it('drops the whole request object — body, headers, cookies, query and url', () => {
    const scrubbed = scrubEvent(hostileEvent()) as Record<string, unknown>;
    // Not "the body is empty": the container is gone, so a future SDK field inside it
    // has nowhere to arrive.
    expect(scrubbed.request).toBeUndefined();
  });

  it('drops stack-frame locals and source context while keeping the location', () => {
    const scrubbed = scrubEvent(hostileEvent());
    const frame = scrubbed?.exception?.values[0]?.stacktrace?.frames[0] as Record<string, unknown>;
    expect(frame.filename).toBe('/app/src/modules/rates/routes.ts');
    expect(frame.function).toBe('createRateCard');
    expect(frame.lineno).toBe(88);
    expect(frame.vars).toBeUndefined();
    expect(frame.pre_context).toBeUndefined();
    expect(frame.context_line).toBeUndefined();
    expect(frame.post_context).toBeUndefined();
  });

  it('keeps the exception class and drops the message', () => {
    const scrubbed = scrubEvent(hostileEvent());
    const ex = scrubbed?.exception?.values[0] as Record<string, unknown>;
    expect(ex.type).toBe('DatabaseError');
    // §7 allows "the error code and class". A message is neither, and the messages worth
    // reading are the ones that quote data.
    expect(ex.value).toBeUndefined();
  });

  it('reduces the user to an id, dropping email, username and IP', () => {
    const scrubbed = scrubEvent(hostileEvent());
    expect(scrubbed?.user).toEqual({ id: 'user-uuid-1' });
  });

  it('keeps only allowlisted tags, and coerces numbers to strings', () => {
    const scrubbed = scrubEvent(hostileEvent());
    expect(scrubbed?.tags).toEqual({
      requestId: 'req-1',
      companyId: 'co-1',
      userId: 'user-uuid-1',
      method: 'POST',
      route: '/v1/rate-cards',
      status: '500',
      errorCode: 'INTERNAL',
      errorClass: 'DatabaseError',
    });
  });

  it('drops extra, breadcrumbs, modules and fingerprint entirely', () => {
    const scrubbed = scrubEvent(hostileEvent()) as Record<string, unknown>;
    expect(scrubbed.extra).toBeUndefined();
    expect(scrubbed.breadcrumbs).toBeUndefined();
    expect(scrubbed.modules).toBeUndefined();
    expect(scrubbed.fingerprint).toBeUndefined();
  });

  it('keeps trace and runtime contexts and drops every other context', () => {
    const scrubbed = scrubEvent(hostileEvent());
    expect(scrubbed?.contexts?.trace).toEqual({ trace_id: 't1', span_id: 's1', op: 'http.server' });
    expect(scrubbed?.contexts?.runtime).toEqual({ name: 'node', version: '22.10.0' });
    const contexts = scrubbed?.contexts as Record<string, unknown>;
    expect(contexts.state).toBeUndefined();
    expect(contexts.device).toBeUndefined();
  });

  it('keeps the operational envelope an operator navigates by', () => {
    const scrubbed = scrubEvent(hostileEvent());
    expect(scrubbed?.event_id).toBe('abc123');
    expect(scrubbed?.level).toBe('error');
    expect(scrubbed?.environment).toBe('production');
    expect(scrubbed?.release).toBe('crewquo@1.4.2');
    expect(scrubbed?.transaction).toBe('POST /v1/rate-cards');
  });

  /**
   * The property that makes the allowlist real rather than a longer denylist.
   *
   * A tracker's whole value is the context it attaches without being asked, so the field
   * that leaks will be one nobody has heard of yet — added by an SDK upgrade, in a minor
   * version, in a release nobody read the changelog for. A denylist cannot be written
   * against a key that does not exist; a rebuild does not have to be.
   */
  it('drops keys it has never heard of, including at the top level', () => {
    const scrubbed = scrubEvent({
      level: 'error',
      some_future_sdk_field: SECRET,
      attachments: [{ filename: 'body.json', data: SECRET }],
      screenshot: SECRET,
      profile: { samples: [SECRET] },
    }) as Record<string, unknown>;
    expect(JSON.stringify(scrubbed)).not.toContain(SECRET);
    expect(Object.keys(scrubbed)).toEqual(['level']);
  });

  it('never returns the object it was given, so a caller cannot leak by reference', () => {
    const raw = hostileEvent();
    const scrubbed = scrubEvent(raw);
    expect(scrubbed).not.toBe(raw);
    expect(scrubbed?.exception?.values[0]).not.toBe((raw.exception as { values: unknown[] }).values[0]);
  });

  /*
   * Failing closed matters more than any single field. An SDK that catches a throwing
   * `beforeSend` and falls back to sending the original event would turn one malformed
   * input into a full unscrubbed disclosure, so malformed input returns null or a
   * minimal event and never raises.
   */
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'not an event' as unknown as RawEvent],
    ['a number', 42 as unknown as RawEvent],
    ['an array', [] as unknown as RawEvent],
  ])('returns null rather than throwing for %s', (_label, input) => {
    expect(() => scrubEvent(input as RawEvent)).not.toThrow();
    expect(scrubEvent(input as RawEvent)).toBeNull();
  });

  it.each([
    ['an exception with no values array', { exception: {} }],
    ['values holding junk', { exception: { values: [null, 'x', 7] } }],
    ['a stacktrace with no frames', { exception: { values: [{ type: 'E', stacktrace: {} }] } }],
    ['frames holding junk', { exception: { values: [{ type: 'E', stacktrace: { frames: [null, 3] } }] } }],
    ['tags that are objects', { tags: { requestId: { nested: SECRET } } }],
    ['a user that is a string', { user: SECRET }],
    ['contexts that are arrays', { contexts: [SECRET] }],
  ])('survives %s without throwing or leaking', (_label, input) => {
    let scrubbed: unknown;
    expect(() => { scrubbed = scrubEvent(input as RawEvent); }).not.toThrow();
    expect(JSON.stringify(scrubbed ?? null)).not.toContain(SECRET);
  });

  it('drops an empty event down to an empty object rather than null', () => {
    // `{}` is a real event the SDK can produce; null would tell the caller "do not send",
    // which is a different decision from "there was nothing worth keeping".
    expect(scrubEvent({})).toEqual({});
  });
});

describe('hasIdentifierSegment', () => {
  it.each([
    '/v1/projects/:id',
    '/v1/rate-cards',
    '/v1/me/memberships',
    '/healthz',
    '/',
  ])('accepts the route template %s', (path) => {
    expect(hasIdentifierSegment(path)).toBe(false);
  });

  it.each([
    '/v1/projects/8f2c1e40-1111-4222-8333-444455556666',
    '/v1/invoices/1042',
    '/v1/companies/co42/members',
    '/v1/invites/V1StGXR8Z5jdHi6BmyT',
  ])('rejects the populated path %s', (path) => {
    expect(hasIdentifierSegment(path)).toBe(true);
  });

  it('drops a transaction whose path has been populated', () => {
    const scrubbed = scrubEvent({
      transaction: 'GET /v1/projects/8f2c1e40-1111-4222-8333-444455556666',
    });
    expect(scrubbed?.transaction).toBeUndefined();
  });

  it('drops a route tag that has been populated, even though call sites pass templates', () => {
    // Checked here as well as at the call site: a tag is a string anybody can set, and
    // "it is a template by construction" is a claim about today's callers.
    const scrubbed = scrubEvent({ tags: { requestId: 'r1', route: '/v1/invoices/1042' } });
    expect(scrubbed?.tags).toEqual({ requestId: 'r1' });
  });
});
