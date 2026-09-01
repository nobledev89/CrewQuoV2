import { describe, expect, it } from 'vitest';
import {
  isSafeScratchDatabaseName,
  makeScratchDatabaseName,
  parseLocalDatabaseTarget,
  quoteIdentifier,
} from './localRestore';

describe('local restore rehearsal safety boundary', () => {
  it.each(['127.0.0.1', 'localhost', '[::1]'])('accepts the loopback host %s', (host) => {
    const target = parseLocalDatabaseTarget(`postgres://crewquo:secret@${host}:15432/crewquo`);
    expect(target.database).toBe('crewquo');
    expect(target.username).toBe('crewquo');
    expect(target.connectionStringFor('scratch')).toContain('/scratch');
  });

  it.each([
    'postgres://crewquo:secret@db.internal:5432/crewquo',
    'postgres://crewquo:secret@10.0.0.4:5432/crewquo',
    'postgres://crewquo:secret@render.com:5432/crewquo',
  ])('refuses a database that might be remote: %s', (url) => {
    expect(() => parseLocalDatabaseTarget(url)).toThrow(/non-loopback/);
  });

  it.each(['postgres', 'template0', 'template1', ''])('refuses a system database: %s', (database) => {
    expect(() =>
      parseLocalDatabaseTarget(`postgres://crewquo:secret@127.0.0.1:15432/${database}`)
    ).toThrow(/application database/);
  });

  it('creates only names the cleanup guard accepts', () => {
    const name = makeScratchDatabaseName(new Date('2026-09-01T02:03:04.000Z'));
    expect(name).toMatch(/^crewquo_restore_rehearsal_20260901020304_/);
    expect(isSafeScratchDatabaseName(name)).toBe(true);
  });

  it.each(['crewquo', 'postgres', 'crewquo_restore_rehearsal_', 'restore_20260901020304_deadbeef'])(
    'never accepts an ordinary database as scratch: %s',
    (name) => expect(isSafeScratchDatabaseName(name)).toBe(false)
  );

  it('quotes catalog identifiers rather than interpolating them raw', () => {
    expect(quoteIdentifier('ordinary')).toBe('"ordinary"');
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
  });
});

