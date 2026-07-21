import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../env';
import { AppError } from '../../http/errors';

/**
 * Token utilities (§5). The access token is a short-lived JWT carrying only
 * `userId` (and optionally the active companyId) — everything else is resolved
 * from `memberships` per request, so there is no stale-claims problem. Refresh
 * tokens are opaque random strings; only their SHA-256 hash is stored.
 */

export interface AccessTokenClaims {
  sub: string; // userId
  companyId?: string; // optional active company hint
}

export function signAccessToken(userId: string, companyId?: string): string {
  const payload: AccessTokenClaims = { sub: userId, ...(companyId ? { companyId } : {}) };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (typeof decoded === 'string' || typeof decoded.sub !== 'string') {
      throw new AppError('UNAUTHENTICATED', 'Invalid access token');
    }
    return {
      sub: decoded.sub,
      companyId: typeof decoded.companyId === 'string' ? decoded.companyId : undefined,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('UNAUTHENTICATED', 'Invalid or expired access token');
  }
}

/** A fresh opaque refresh token plus the hash to persist and its expiry. */
export function createRefreshToken(): { token: string; tokenHash: string; expiresAt: Date } {
  const token = randomBytes(48).toString('base64url');
  return {
    token,
    tokenHash: hashRefreshToken(token),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_SECONDS * 1000),
  };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

type PurposeToken = 'password_reset' | 'email_verify';

/** Signed, single-purpose, expiring token for reset/verify links. */
export function signPurposeToken(userId: string, purpose: PurposeToken, ttlSeconds: number): string {
  return jwt.sign({ sub: userId, purpose }, env.JWT_REFRESH_SECRET, { expiresIn: ttlSeconds });
}

export function verifyPurposeToken(token: string, purpose: PurposeToken): string {
  try {
    const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET);
    if (typeof decoded === 'string' || decoded.purpose !== purpose || typeof decoded.sub !== 'string') {
      throw new AppError('VALIDATION', 'Invalid token');
    }
    return decoded.sub;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('VALIDATION', 'Invalid or expired token');
  }
}
