import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  buildSigningKeyring,
  parseRetiredSecrets,
  verificationKeysFor,
  type SigningKeyring,
} from './signingKeys';
import { env } from '../../env';
import { AppError } from '../../http/errors';

/**
 * Token utilities (§5). The access token is a short-lived JWT carrying only
 * `userId` (and optionally the active companyId) — everything else is resolved
 * from `memberships` per request, so there is no stale-claims problem. Refresh
 * tokens are opaque random strings; only their SHA-256 hash is stored.
 *
 * Both JWT kinds carry a `kid` header naming the key that signed them, and are
 * verified against a ring rather than a single secret
 * (`docs/operating-model/access.md` §14 step 4). Rotation is therefore a deploy
 * with two keys live and nobody signed out, instead of an event that logs the
 * whole platform out at once — which is the reason the secret had never been
 * rotated in the first place.
 */

/**
 * **The algorithm is named on both sides, and never read from the token.**
 * `jsonwebtoken` infers it from the key type on signing, which is fine, and on
 * verification it would otherwise accept any algorithm the token itself asks for
 * — the classic confusion where a header is allowed to choose how it is checked.
 * One symmetric algorithm is all this codebase uses, so it is stated once.
 */
const JWT_ALGORITHM = 'HS256' as const;

/**
 * The two rings (`docs/operating-model/access.md` §14 step 4), built once at boot
 * because the environment does not change under a running process — a rotation is
 * a deploy, which is a new process reading a new environment.
 *
 * They are separate rings for separate secrets, and neither can verify the
 * other's tokens. That is worth keeping: an access token and a password-reset
 * link have different lifetimes and very different consequences, and a single
 * ring would let a leak of one secret mint both.
 */
const accessKeyring = buildSigningKeyring(
  env.JWT_ACCESS_SECRET,
  parseRetiredSecrets(env.JWT_ACCESS_SECRET_RETIRED)
);

const purposeKeyring = buildSigningKeyring(
  env.JWT_REFRESH_SECRET,
  parseRetiredSecrets(env.JWT_REFRESH_SECRET_RETIRED)
);

/** The kid new access tokens are signed under. Exposed for verification scripts. */
export function currentAccessKid(): string {
  return accessKeyring.current.kid;
}

/**
 * Verify against every key the token's `kid` header permits, in ring order.
 *
 * The kid is read from the *unverified* header, which is safe because it selects
 * a key rather than granting anything: the signature is still checked against
 * that key, so naming one buys an attacker nothing they could not get by trying
 * both. What it buys the honest caller is a single HMAC instead of one per key,
 * and an operator the ability to see which key is still carrying traffic.
 */
function verifyWithKeyring(token: string, ring: SigningKeyring): jwt.JwtPayload {
  const kid = readKid(token);
  const candidates = verificationKeysFor(ring, kid);
  let lastError: unknown = new Error('no signing key matches this token');

  for (const key of candidates) {
    try {
      const payload = jwt.verify(token, key.secret, { algorithms: [JWT_ALGORITHM] });
      // A string payload means the token was signed over a bare string rather
      // than a claims object. Nothing here mints those, so it is a token from
      // somewhere else and is refused rather than coerced.
      if (typeof payload === 'string') break;
      return payload;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError;
}

/** The `kid` header, or undefined for a malformed token or one minted before kids. */
function readKid(token: string): string | undefined {
  try {
    const decoded = jwt.decode(token, { complete: true });
    return typeof decoded?.header.kid === 'string' ? decoded.header.kid : undefined;
  } catch {
    return undefined;
  }
}

export interface AccessTokenClaims {
  sub: string; // userId
  companyId?: string; // optional active company hint
  /**
   * The session this token was minted in (`access.md` §3), when there is one.
   *
   * Two things need it. A device list has to be able to say **"this device"** —
   * without it, the one row a person is certain about is the one row the screen
   * cannot identify. And `requireAuth` checks the session is still live, which is
   * what turns "end that device" from *eventual* (the packet's honest bound: the
   * device's next refresh, up to a whole access-token lifetime away) into
   * immediate.
   *
   * **Optional, and it has to stay optional.** Every access token minted before
   * this claim existed is still valid for its remaining fifteen minutes, and a
   * verifier that required `sid` would sign out every user on the platform at
   * deployment — the same forced-logout failure §10 objects to about rotating a
   * signing secret, arriving through a different door.
   */
  sessionId?: string;
}

/**
 * The wire form. `sid` is the conventional short name for a session claim, and
 * the application calls it `sessionId`; the two are kept apart here rather than
 * renamed at each call site, so a claim name never has to change in two places.
 */
interface AccessTokenPayload {
  sub: string;
  companyId?: string;
  sid?: string;
}

export function signAccessToken(input: {
  userId: string;
  sessionId?: string;
  companyId?: string;
}): string {
  const payload: AccessTokenPayload = {
    sub: input.userId,
    ...(input.companyId ? { companyId: input.companyId } : {}),
    ...(input.sessionId ? { sid: input.sessionId } : {}),
  };
  return jwt.sign(payload, accessKeyring.current.secret, {
    algorithm: JWT_ALGORITHM,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    // `keyid` is jsonwebtoken's name for the `kid` header. Only ever the current
    // key: a ring that signed with more than one would have no way to retire any
    // of them.
    keyid: accessKeyring.current.kid,
  });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const decoded = verifyWithKeyring(token, accessKeyring);
    if (typeof decoded.sub !== 'string') {
      throw new AppError('UNAUTHENTICATED', 'Invalid access token');
    }
    return {
      sub: decoded.sub,
      companyId: typeof decoded.companyId === 'string' ? decoded.companyId : undefined,
      sessionId: typeof decoded.sid === 'string' ? decoded.sid : undefined,
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

/**
 * Single-purpose tokens. The `purpose` claim is checked on verification, so a reset
 * link can never be spent as a verification link or as half a sign-in.
 *
 * `mfa_challenge` is the second half of a two-step login: the password has been
 * accepted and nothing has been issued yet. It is deliberately one of these rather
 * than a stored row — it must expire on its own, it grants nothing, and a
 * server-side row would be state to clean up for every abandoned sign-in.
 */
type PurposeToken = 'password_reset' | 'email_verify' | 'mfa_challenge';

/** Signed, single-purpose, expiring token for reset/verify links. */
export function signPurposeToken(userId: string, purpose: PurposeToken, ttlSeconds: number): string {
  return jwt.sign({ sub: userId, purpose }, purposeKeyring.current.secret, {
    algorithm: JWT_ALGORITHM,
    expiresIn: ttlSeconds,
    keyid: purposeKeyring.current.kid,
  });
}

export function verifyPurposeToken(token: string, purpose: PurposeToken): string {
  try {
    const decoded = verifyWithKeyring(token, purposeKeyring);
    if (decoded.purpose !== purpose || typeof decoded.sub !== 'string') {
      throw new AppError('VALIDATION', 'Invalid token');
    }
    return decoded.sub;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('VALIDATION', 'Invalid or expired token');
  }
}
