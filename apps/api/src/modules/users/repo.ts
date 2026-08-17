import type { PublicUser } from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  google_sub: string | null;
  name: string;
  avatar_url: string | null;
  is_super_admin: boolean;
  email_verified_at: Date | null;
}

const COLUMNS =
  'id, email, password_hash, google_sub, name, avatar_url, is_super_admin, email_verified_at';

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    isSuperAdmin: row.is_super_admin,
    emailVerified: row.email_verified_at !== null,
  };
}

export function findUserById(id: string, runner?: Queryable): Promise<UserRow | null> {
  return queryOne<UserRow>(`select ${COLUMNS} from users where id = $1`, [id], runner);
}

export function findUserByEmail(email: string, runner?: Queryable): Promise<UserRow | null> {
  return queryOne<UserRow>(`select ${COLUMNS} from users where email = $1`, [email], runner);
}

export function findUserByGoogleSub(sub: string, runner?: Queryable): Promise<UserRow | null> {
  return queryOne<UserRow>(`select ${COLUMNS} from users where google_sub = $1`, [sub], runner);
}

export async function updatePasswordHash(
  userId: string,
  passwordHash: string,
  runner?: Queryable
): Promise<void> {
  await query(
    `update users set password_hash = $1, updated_at = now() where id = $2`,
    [passwordHash, userId],
    runner
  );
}

/**
 * Update the caller's own profile (§7 PATCH /v1/me).
 *
 * `avatarUrl` distinguishes "leave it" from "clear it": `undefined` keeps the
 * current value, an explicit `null` erases it. `coalesce` cannot express that on
 * its own, so the nullable column takes a separate "was this key present" flag.
 */
export async function updateUserProfile(
  userId: string,
  patch: { name?: string; avatarUrl?: string | null },
  runner?: Queryable
): Promise<UserRow> {
  const rows = await query<UserRow>(
    `update users set
       name = coalesce($2, name),
       avatar_url = case when $3 then $4 else avatar_url end,
       updated_at = now()
     where id = $1
     returning ${COLUMNS}`,
    [userId, patch.name ?? null, 'avatarUrl' in patch, patch.avatarUrl ?? null],
    runner
  );
  return rows[0]!;
}

export async function markEmailVerified(userId: string, runner?: Queryable): Promise<void> {
  await query(
    `update users set email_verified_at = coalesce(email_verified_at, now()), updated_at = now()
      where id = $1`,
    [userId],
    runner
  );
}

export async function insertUser(
  input: {
    email: string;
    name: string;
    passwordHash: string | null;
    googleSub: string | null;
    avatarUrl: string | null;
    emailVerified: boolean;
  },
  runner?: Queryable
): Promise<UserRow> {
  const rows = await query<UserRow>(
    `insert into users (email, name, password_hash, google_sub, avatar_url, email_verified_at)
     values ($1, $2, $3, $4, $5, case when $6 then now() else null end)
     returning ${COLUMNS}`,
    [
      input.email,
      input.name,
      input.passwordHash,
      input.googleSub,
      input.avatarUrl,
      input.emailVerified,
    ],
    runner
  );
  return rows[0]!;
}
