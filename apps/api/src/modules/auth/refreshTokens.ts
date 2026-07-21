import { query, queryOne, type Queryable } from '../../db';
import { hashRefreshToken } from './tokens';

interface RefreshTokenRow {
  id: string;
  user_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}

export async function storeRefreshToken(
  input: { userId: string; tokenHash: string; expiresAt: Date },
  runner?: Queryable
): Promise<void> {
  await query(
    `insert into refresh_tokens (user_id, token_hash, expires_at)
     values ($1, $2, $3)`,
    [input.userId, input.tokenHash, input.expiresAt],
    runner
  );
}

/** Return the row for a live (unrevoked, unexpired) refresh token, or null. */
export function findLiveRefreshToken(
  token: string,
  runner?: Queryable
): Promise<RefreshTokenRow | null> {
  return queryOne<RefreshTokenRow>(
    `select id, user_id, expires_at, revoked_at
       from refresh_tokens
      where token_hash = $1 and revoked_at is null and expires_at > now()`,
    [hashRefreshToken(token)],
    runner
  );
}

export async function revokeRefreshToken(token: string, runner?: Queryable): Promise<void> {
  await query(
    `update refresh_tokens set revoked_at = now()
      where token_hash = $1 and revoked_at is null`,
    [hashRefreshToken(token)],
    runner
  );
}

/** Revoke every live refresh token for a user (used on password reset). */
export async function revokeAllRefreshTokens(userId: string, runner?: Queryable): Promise<void> {
  await query(
    `update refresh_tokens set revoked_at = now()
      where user_id = $1 and revoked_at is null`,
    [userId],
    runner
  );
}
