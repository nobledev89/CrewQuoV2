import { randomBytes } from 'node:crypto';
import {
  DEFAULT_CURRENCY,
  type AuthResponse,
  type AuthTokens,
  type GoogleRequest,
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
  findLiveRefreshToken,
  revokeRefreshToken,
  storeRefreshToken,
} from './refreshTokens';
import { createRefreshToken, signAccessToken } from './tokens';

/** Issue a fresh access+refresh pair for a user and persist the refresh hash. */
async function issueTokens(userId: string): Promise<AuthTokens> {
  const accessToken = signAccessToken(userId);
  const refresh = createRefreshToken();
  await storeRefreshToken({
    userId,
    tokenHash: refresh.tokenHash,
    expiresAt: refresh.expiresAt,
  });
  return {
    accessToken,
    refreshToken: refresh.token,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  };
}

async function buildAuthResponse(user: UserRow): Promise<AuthResponse> {
  const [memberships, tokens] = await Promise.all([
    listMembershipSummaries(user.id),
    issueTokens(user.id),
  ]);
  return { user: toPublicUser(user), memberships, tokens };
}

export async function register(input: RegisterRequest): Promise<AuthResponse> {
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

  return buildAuthResponse(user);
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

export async function login(input: LoginRequest): Promise<AuthResponse> {
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
  return buildAuthResponse(user);
}

export async function loginWithGoogle(input: GoogleRequest): Promise<AuthResponse> {
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

  return buildAuthResponse(user);
}

/** Rotate a refresh token: revoke the old, issue a new pair. */
export async function refresh(refreshToken: string): Promise<AuthResponse> {
  const row = await findLiveRefreshToken(refreshToken);
  if (!row) {
    throw new AppError('UNAUTHENTICATED', 'Invalid or expired refresh token');
  }
  await revokeRefreshToken(refreshToken);
  const user = await findUserById(row.user_id);
  if (!user) {
    throw new AppError('UNAUTHENTICATED', 'Account no longer exists');
  }
  return buildAuthResponse(user);
}

export async function logout(refreshToken: string): Promise<void> {
  await revokeRefreshToken(refreshToken);
}
