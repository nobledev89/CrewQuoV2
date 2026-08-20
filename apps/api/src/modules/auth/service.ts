import { randomBytes } from 'node:crypto';
import {
  DEFAULT_CURRENCY,
  type AuthResponse,
  type AuthTokens,
  type GoogleRequest,
  type LoginChallenge,
  type LoginRequest,
  type RegisterRequest,
} from '@crewquo/shared';
import { env } from '../../env';
import { withTransaction } from '../../db';
import { AppError } from '../../http/errors';
import { createCompanyAtRegistration } from '../company-creation/service';
import { insertMembership, listMembershipSummaries } from '../memberships/repo';
import {
  findUserByEmail,
  findUserByGoogleSub,
  findUserById,
  insertUser,
  toPublicUser,
  type UserRow,
} from '../users/repo';
import { verifyGoogleIdToken } from './google';
import { hashPassword, verifyPassword } from './passwords';
import {
  findPresentedToken,
  revokeSession,
  rotateRefreshToken,
  startSession,
} from './sessions.repo';
import { reportTokenReuse } from './securityEvents';
import { countRecoveryCodes, findFactor } from './mfa.repo';
import { MFA_CHALLENGE_TTL_SECONDS } from './mfa.service';
import {
  createRefreshToken,
  signAccessToken,
  signPurposeToken,
  verifyPurposeToken,
} from './tokens';

/**
 * Where a sign-in came from, as far as this domain is willing to know.
 *
 * A coarse device label and nothing else — no address, no precise User-Agent. See
 * `deviceLabelFromUserAgent` and the packet's §7 for why the obvious extra fields
 * are absent rather than pending.
 */
export interface SessionOrigin {
  deviceLabel: string | null;
}

/**
 * Open a new session and issue its first token pair.
 *
 * The access token carries the session id, so from here on every request the
 * client makes can be traced to the device that signed in — which is what a device
 * list needs to mark "this device", and what lets `requireAuth` notice a session
 * that has been ended.
 */
async function openSession(userId: string, origin: SessionOrigin): Promise<AuthTokens> {
  const refresh = createRefreshToken();
  const { sessionId } = await startSession({
    userId,
    deviceLabel: origin.deviceLabel,
    tokenHash: refresh.tokenHash,
    expiresAt: refresh.expiresAt,
  });
  return {
    accessToken: signAccessToken({ userId, sessionId }),
    refreshToken: refresh.token,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  };
}

async function buildAuthResponse(
  user: UserRow,
  tokens: AuthTokens | Promise<AuthTokens>
): Promise<AuthResponse> {
  const [memberships, resolved] = await Promise.all([listMembershipSummaries(user.id), tokens]);
  return { user: toPublicUser(user), memberships, tokens: resolved };
}

export async function register(
  input: RegisterRequest,
  origin: SessionOrigin
): Promise<AuthResponse> {
  const existing = await findUserByEmail(input.email);
  if (existing) {
    throw new AppError('CONFLICT', 'An account with that email already exists');
  }
  const passwordHash = await hashPassword(input.password);

  const user = await withTransaction(async (client) => {
    const created = await insertUser(
      {
        email: input.email,
        name: input.name,
        passwordHash,
        googleSub: null,
        avatarUrl: null,
        emailVerified: false,
      },
      client
    );
    if (input.companyName) {
      // Goes through the creation service, not `insertCompany`, so registration's
      // company consumes the §3.1.1 first-company allowance like any other. A
      // signup path that quietly skipped the ledger would hand every account a
      // free extra tenant.
      await createCompanyAtRegistration(client, {
        userId: created.id,
        name: input.companyName,
        currency: DEFAULT_CURRENCY,
      });
    }
    return created;
  });

  return buildAuthResponse(user, openSession(user.id, origin));
}

/**
 * A bcrypt hash of a value nobody knows, verified against when no account exists.
 *
 * The cost has to match the one real hashes were written with, or the decoy is
 * faster than the real path and the timing signal survives in the other
 * direction. Generated once at module load rather than per request — hashing on
 * every unknown address would hand an attacker a cheap CPU-exhaustion lever.
 */
const DECOY_PASSWORD_HASH = hashPassword(randomBytes(32).toString('base64url'));

export async function login(
  input: LoginRequest,
  origin: SessionOrigin
): Promise<AuthResponse | LoginChallenge> {
  const user = await findUserByEmail(input.email);

  /*
   * **Verify against a decoy when there is no account.** The previous version
   * carried the comment "Constant-ish: still run verify to avoid trivial
   * user-enumeration timing" and then did the opposite — it returned immediately
   * when no user was found, and only reached bcrypt when one existed.
   *
   * bcrypt is deliberately slow (~800ms in this project's own test output), so an
   * unknown address answered in milliseconds and a known one took most of a
   * second. That is not a subtle side channel: it is an account-existence oracle
   * with a hundredfold signal, readable from a browser, on an endpoint that until
   * this slice had no rate limit either. The bodies always matched; the clock gave
   * it away.
   *
   * A Google-only account (`password_hash` null) takes the same path for the same
   * reason — "that address exists but has no password" is the same disclosure
   * wearing a different hat.
   */
  const hash = user?.password_hash ?? (await DECOY_PASSWORD_HASH);
  const ok = await verifyPassword(input.password, hash);

  if (!user || !user.password_hash || !ok) {
    throw new AppError('UNAUTHENTICATED', 'Invalid email or password');
  }

  /*
   * **The password was right; that is now only half of it.**
   *
   * A challenge is issued instead of tokens when the account holds a confirmed
   * factor. Nothing is minted here — no session, no access token — so an attacker
   * who has the password and stops at this point holds a five-minute string that
   * can do exactly one thing: carry a correct code back. A `PENDING` factor is
   * deliberately *not* a challenge: it is an unfinished form, and treating it as
   * protection would lock somebody out of their own account over a QR code they
   * never scanned.
   */
  const factor = await findFactor(user.id);
  if (factor?.status === 'ACTIVE') {
    const challenge: LoginChallenge = {
      status: 'mfa_required',
      challengeToken: signPurposeToken(user.id, 'mfa_challenge', MFA_CHALLENGE_TTL_SECONDS),
      // Offered honestly: a screen that suggests recovery codes to somebody who has
      // none sends them looking for a piece of paper that was never printed.
      recoveryAvailable: (await countRecoveryCodes(user.id)) > 0,
    };
    return challenge;
  }

  return buildAuthResponse(user, openSession(user.id, origin));
}

/**
 * Finish a two-step sign-in. The code has already been checked by the caller.
 *
 * Separate from `login` because the two are reached by different routes with
 * different rate-limit budgets — a code is guessed a million ways and a password is
 * not — and because this path must not re-check the password it never sees.
 */
export async function completeChallenge(
  challengeToken: string,
  origin: SessionOrigin
): Promise<AuthResponse> {
  const userId = verifyPurposeToken(challengeToken, 'mfa_challenge');
  const user = await findUserById(userId);
  if (!user) throw new AppError('UNAUTHENTICATED', 'Account no longer exists');
  return buildAuthResponse(user, openSession(user.id, origin));
}

/** The user a challenge names, without minting anything. */
export function userIdFromChallenge(challengeToken: string): string {
  return verifyPurposeToken(challengeToken, 'mfa_challenge');
}

export async function loginWithGoogle(
  input: GoogleRequest,
  origin: SessionOrigin
): Promise<AuthResponse> {
  const identity = await verifyGoogleIdToken(input.idToken);

  // 1) Existing google-linked user. 2) Existing email → link google_sub.
  // 3) New user.
  let user = await findUserByGoogleSub(identity.googleSub);
  if (!user) {
    const byEmail = await findUserByEmail(identity.email);
    if (byEmail) {
      user = await withTransaction(async (client) => {
        const rows = await client.query<UserRow>(
          `update users set google_sub = $1,
                  avatar_url = coalesce(avatar_url, $2),
                  email_verified_at = coalesce(email_verified_at, case when $3 then now() else null end),
                  updated_at = now()
            where id = $4
            returning id, email, password_hash, google_sub, name, avatar_url, is_super_admin, email_verified_at`,
          [identity.googleSub, identity.avatarUrl, identity.emailVerified, byEmail.id]
        );
        return rows.rows[0]!;
      });
    } else {
      user = await insertUser({
        email: identity.email,
        name: identity.name,
        passwordHash: null,
        googleSub: identity.googleSub,
        avatarUrl: identity.avatarUrl,
        emailVerified: identity.emailVerified,
      });
    }
  }

  return buildAuthResponse(user, openSession(user.id, origin));
}

/**
 * The generic refusal. **One sentence for every way a refresh can fail**, because
 * the alternatives are all disclosures: "that token was already used" tells a thief
 * their copy is the stale one and the victim is still active, and "that session was
 * revoked" tells them the theft was noticed. The holder learns which it was by
 * email and from their own device list, neither of which the person holding a
 * stolen string can read.
 */
const REFRESH_REFUSED = 'Invalid or expired refresh token';

/**
 * Exchange a refresh token for a successor — and notice when the same one comes
 * back twice.
 *
 * Four outcomes, from `classifyRefreshToken`:
 *
 *  - **LIVE** — the ordinary path. Retire it, mint its successor in the same
 *    session, slide the session's expiry.
 *  - **GRACE** — presented within seconds of being retired. Two devices refreshing
 *    at once is a phone waking while a laptop polls, and this product's own web app
 *    does it on every sign-in that crosses a route group. Rotating again is right;
 *    raising the alarm here would teach people to ignore it.
 *  - **REUSE** — presented long after it was retired. A thief or a badly broken
 *    client, and there is no third explanation. **The whole family goes**, because
 *    the one thing worse than a stolen token is a stolen token whose thief keeps
 *    the session alive after being noticed.
 *  - **DEAD** — unknown, expired, or already ended. A 401 and nothing else.
 *
 * The reuse arm ends the *victim's* session too, and that is the intended cost: the
 * product cannot tell which of the two presentations was the legitimate one — the
 * thief may well have refreshed first — so it stops trusting both and makes the
 * holder sign in with the factor a stolen token does not include.
 */
export async function refresh(
  refreshToken: string,
  origin: SessionOrigin
): Promise<AuthResponse> {
  const presented = await findPresentedToken(refreshToken);

  if (presented.presentation === 'REUSE' && presented.token?.sessionId) {
    await reportTokenReuse({
      userId: presented.token.userId,
      sessionId: presented.token.sessionId,
      deviceLabel: origin.deviceLabel,
    });
    throw new AppError('UNAUTHENTICATED', REFRESH_REFUSED);
  }

  if (presented.presentation === 'DEAD' || !presented.token?.sessionId) {
    throw new AppError('UNAUTHENTICATED', REFRESH_REFUSED);
  }

  const user = await findUserById(presented.token.userId);
  if (!user) {
    // The token outlived the account. Nothing to revoke — a deleted user's rows
    // went with them — and nothing to tell anybody.
    throw new AppError('UNAUTHENTICATED', 'Account no longer exists');
  }

  const successor = createRefreshToken();
  const rotated = await rotateRefreshToken({
    tokenId: presented.token.id,
    sessionId: presented.token.sessionId,
    userId: presented.token.userId,
    newTokenHash: successor.tokenHash,
    expiresAt: successor.expiresAt,
    // A grace-window token is already retired; asking the conditional update to
    // retire it again would report a race that never happened.
    expectRetire: presented.presentation === 'LIVE',
  });
  if (!rotated) {
    // Lost the race to another refresh of the same token. The winner already holds
    // a successor and the loser's client retries with what it is handed — so this
    // is a refusal, not an alarm: the very next attempt inside the grace window
    // succeeds.
    throw new AppError('UNAUTHENTICATED', REFRESH_REFUSED);
  }

  return buildAuthResponse(user, {
    accessToken: signAccessToken({
      userId: user.id,
      sessionId: presented.token.sessionId,
    }),
    refreshToken: successor.token,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  });
}

/**
 * Sign out — which ends the **session**, not merely the token presented.
 *
 * Revoking one token would leave the device able to carry on using its unexpired
 * access token and, worse, leave a live row in the holder's device list for a
 * device that has signed out. Idempotent by construction: a second call finds
 * nothing live and revokes nothing.
 */
export async function logout(refreshToken: string): Promise<void> {
  const presented = await findPresentedToken(refreshToken);
  if (!presented.token?.sessionId) return;
  await revokeSession(presented.token.sessionId, presented.token.userId, {
    cause: 'SIGNED_OUT',
  });
}
