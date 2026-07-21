import { describe, expect, it } from 'vitest';
import { AppError } from '../../http/errors';
import {
  createRefreshToken,
  hashRefreshToken,
  signAccessToken,
  signPurposeToken,
  verifyAccessToken,
  verifyPurposeToken,
} from './tokens';

describe('access tokens', () => {
  it('round-trips userId and optional companyId', () => {
    const token = signAccessToken('user-1', 'company-1');
    const claims = verifyAccessToken(token);
    expect(claims.sub).toBe('user-1');
    expect(claims.companyId).toBe('company-1');
  });

  it('omits companyId when not provided', () => {
    const claims = verifyAccessToken(signAccessToken('user-2'));
    expect(claims.sub).toBe('user-2');
    expect(claims.companyId).toBeUndefined();
  });

  it('rejects a garbage token', () => {
    expect(() => verifyAccessToken('not-a-jwt')).toThrow(AppError);
  });
});

describe('refresh tokens', () => {
  it('produces a token whose hash is stable and matches the stored hash', () => {
    const { token, tokenHash, expiresAt } = createRefreshToken();
    expect(tokenHash).toBe(hashRefreshToken(token));
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('generates distinct tokens each call', () => {
    expect(createRefreshToken().token).not.toBe(createRefreshToken().token);
  });
});

describe('purpose tokens', () => {
  it('round-trips for the matching purpose', () => {
    const token = signPurposeToken('user-9', 'password_reset', 3600);
    expect(verifyPurposeToken(token, 'password_reset')).toBe('user-9');
  });

  it('rejects when the purpose does not match', () => {
    const token = signPurposeToken('user-9', 'password_reset', 3600);
    expect(() => verifyPurposeToken(token, 'email_verify')).toThrow(AppError);
  });
});
