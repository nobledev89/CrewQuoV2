import { query } from '../../db';

/**
 * Expo push-token persistence (CREWQUO_V2_PLAN.md §3.4). Tokens are per-device;
 * we notify a user's devices, or the manager cohort of a company (the approvers).
 */

export async function upsertPushToken(
  userId: string,
  token: string,
  platform: string | null
): Promise<void> {
  await query(
    `insert into push_tokens (user_id, token, platform)
     values ($1, $2, $3)
     on conflict (token) do update set user_id = excluded.user_id,
       platform = excluded.platform, updated_at = now()`,
    [userId, token, platform]
  );
}

export async function tokensForUser(userId: string): Promise<string[]> {
  const rows = await query<{ token: string }>(
    `select token from push_tokens where user_id = $1`,
    [userId]
  );
  return rows.map((r) => r.token);
}

/** Push tokens of the manager cohort (approvers) of a company. */
export async function tokensForCompanyManagers(companyId: string): Promise<string[]> {
  const rows = await query<{ token: string }>(
    `select pt.token
       from push_tokens pt
       join memberships m on m.user_id = pt.user_id
      where m.company_id = $1 and m.status = 'ACTIVE'
        and m.role in ('OWNER','ADMIN','MANAGER')`,
    [companyId]
  );
  return rows.map((r) => r.token);
}
