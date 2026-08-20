import { afterEach, describe, expect, it, vi } from 'vitest';
import { log, routeTemplate } from './log';

describe('routeTemplate', () => {
  it('joins the router mount to the pattern inside it', () => {
    expect(routeTemplate({ baseUrl: '/v1/projects', route: { path: '/:id/summary' } }))
      .toBe('/v1/projects/:id/summary');
  });

  it('keeps the pattern rather than the populated path', () => {
    // The whole point of the field. A populated path is a record of which
    // resources a person touched, which is the movement log access.md §7
    // refused to build in the session table.
    const template = routeTemplate({ baseUrl: '/v1/projects', route: { path: '/:id' } });
    expect(template).toBe('/v1/projects/:id');
    expect(template).not.toMatch(/[0-9a-f]{8}-/);
  });

  it('does not leave a trailing slash for a router root', () => {
    expect(routeTemplate({ baseUrl: '/v1/me', route: { path: '/' } })).toBe('/v1/me');
  });

  it('still names a route mounted at the app root', () => {
    expect(routeTemplate({ baseUrl: '', route: { path: '/healthz' } })).toBe('/healthz');
  });

  it('is null for a request that matched no route', () => {
    // Null is the real answer. Reporting the URL instead would put a populated
    // path into the one field whose purpose is not to hold one.
    expect(routeTemplate({ baseUrl: '', route: undefined })).toBeNull();
    expect(routeTemplate({})).toBeNull();
  });
});

describe('log', () => {
  afterEach(() => vi.restoreAllMocks());

  function capture(level: 'log' | 'warn' | 'error'): () => Record<string, unknown> {
    const spy = vi.spyOn(console, level).mockImplementation(() => {});
    return () => JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>;
  }

  it('emits one line of JSON carrying the level and the message', () => {
    const read = capture('log');
    log('info', 'request', { requestId: 'r-1', status: 200 });
    expect(read()).toEqual({ level: 'info', msg: 'request', requestId: 'r-1', status: 200 });
  });

  it('omits an absent field rather than asserting null', () => {
    // `"userId": null` claims there was no user; omitting it says nothing either
    // way, which is what an unauthenticated request should look like.
    const read = capture('log');
    log('info', 'request', { requestId: 'r-2', userId: undefined, companyId: undefined });
    expect(read()).toEqual({ level: 'info', msg: 'request', requestId: 'r-2' });
  });

  it('keeps an explicit null, because "no tenant" is a different claim', () => {
    const read = capture('log');
    log('info', 'request', { companyId: null });
    expect(read()).toHaveProperty('companyId', null);
  });

  it('routes errors and warnings to their own streams', () => {
    const readError = capture('error');
    log('error', 'request_failed', { status: 500 });
    expect(readError()).toHaveProperty('level', 'error');

    const readWarn = capture('warn');
    log('warn', 'request_failed', { status: 409 });
    expect(readWarn()).toHaveProperty('level', 'warn');
  });

  it('survives a field value that would forge a second log line', () => {
    // A company name is customer-supplied text and must not be able to write a
    // log entry. Nothing here interpolates, so the newline is escaped by
    // JSON.stringify rather than ending the line — asserted because the day
    // somebody swaps this for a template string is the day it stops being true.
    const read = capture('log');
    log('info', 'request', { requestId: 'r-3\n{"level":"info","msg":"forged"}' });
    const spy = vi.mocked(console.log);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0]).split('\n')).toHaveLength(1);
    expect(read()).toHaveProperty('msg', 'request');
  });
});
