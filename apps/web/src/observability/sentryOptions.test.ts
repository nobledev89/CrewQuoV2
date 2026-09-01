import * as Sentry from '@sentry/nextjs';
import { describe, expect, it } from 'vitest';
import { createWebSentryOptions, parseTraceSampleRate } from './sentryOptions';

const SECRET = 'MUST-NOT-LEAK';

function options(dsn: string | undefined = 'https://public@example.invalid/1') {
  return createWebSentryOptions({
    dsn,
    environment: 'test',
    release: 'web@test',
    runtime: 'browser',
    tracesSampleRate: '0.2',
  });
}

describe('web error tracking policy', () => {
  it.each([
    [undefined, 0],
    ['', 0],
    ['0', 0],
    ['0.25', 0.25],
    ['1', 1],
    ['-0.1', 0],
    ['1.1', 0],
    ['not-a-number', 0],
  ] as const)('parses trace sample rate %s as %s', (input, expected) => {
    expect(parseTraceSampleRate(input)).toBe(expected);
  });

  it('is inert without a DSN', () => {
    expect(
      createWebSentryOptions({ environment: 'test', runtime: 'browser' }).enabled
    ).toBe(false);
  });

  it('turns off PII, logs and breadcrumbs before collection', () => {
    const configured = options();
    expect(configured.sendDefaultPii).toBe(false);
    expect(configured.enableLogs).toBe(false);
    expect(configured.maxBreadcrumbs).toBe(0);
    expect(configured.beforeBreadcrumb()).toBeNull();
    expect(
      configured.integrations([
        { name: 'Breadcrumbs' },
        { name: 'LocalVariables' },
        { name: 'RequestData' },
        { name: 'GlobalHandlers' },
      ])
    ).toEqual([{ name: 'GlobalHandlers' }]);
  });

  it('rebuilds browser errors from the shared allowlist', () => {
    const event = options().beforeSend({
      event_id: 'event-1',
      message: `Customer ${SECRET}`,
      request: {
        url: `/projects/${SECRET}`,
        headers: { authorization: `Bearer ${SECRET}` },
        data: { password: SECRET },
      },
      breadcrumbs: [{ message: `clicked ${SECRET}` }],
      extra: { localStorage: SECRET },
      exception: {
        values: [
          {
            type: 'Error',
            value: SECRET,
            stacktrace: { frames: [{ filename: 'page.tsx', lineno: 42, vars: { token: SECRET } }] },
          },
        ],
      },
      tags: { requestId: 'req-1', invented: SECRET },
    });

    const wire = JSON.stringify(event);
    expect(wire).not.toContain(SECRET);
    expect(wire).toContain('req-1');
    expect(wire).toContain('page.tsx');
  });

  it('applies the same scrubber to performance transactions', () => {
    const event = options().beforeSendTransaction({
      transaction: `/projects/${SECRET}-123`,
      spans: [{ description: SECRET }],
      contexts: { trace: { trace_id: 'trace-1', data: SECRET } },
    });
    expect(JSON.stringify(event)).not.toContain(SECRET);
  });

  it('reaches the scrubber through the real SDK before transport', async () => {
    const sent: unknown[] = [];
    Sentry.init({
      ...options(),
      defaultIntegrations: false,
      transport: () => ({
        send: async (envelope: unknown) => {
          sent.push(envelope);
          return {};
        },
        flush: async () => true,
      }),
    });

    Sentry.captureException(new Error(`customer value: ${SECRET}`));
    await Sentry.flush(2_000);

    expect(sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(sent)).not.toContain(SECRET);
  });
});
