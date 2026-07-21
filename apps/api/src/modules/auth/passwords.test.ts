import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './passwords';

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('produces a bcrypt hash (cost 12) that differs from the plaintext', async () => {
    const hash = await hashPassword('another-secret');
    expect(hash).not.toBe('another-secret');
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
  });
});
