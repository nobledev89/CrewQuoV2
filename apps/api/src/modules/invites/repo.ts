import { randomBytes } from 'node:crypto';
import type { InviteKind, InviteStatus, InviteView, MembershipRole } from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

/**
 * Invite persistence (CREWQUO_V2_PLAN.md §3.6). One unified table for MEMBER,
 * ENGAGEMENT and CLIENT_PORTAL invites; the token is an opaque capability used
 * on the public accept endpoints.
 */

const INVITE_TTL_DAYS = 14;

export interface InviteRow {
  id: string;
  invite_token: string;
  kind: InviteKind;
  target_company_id: string;
  email: string;
  role: MembershipRole | null;
  engagement_id: string | null;
  status: InviteStatus;
  invited_by_user_id: string | null;
  expires_at: Date;
}

export function newInviteToken(): string {
  return randomBytes(24).toString('base64url');
}

export async function insertInvite(
  input: {
    kind: InviteKind;
    targetCompanyId: string;
    email: string;
    role?: MembershipRole | null;
    engagementId?: string | null;
    invitedByUserId: string;
  },
  runner?: Queryable
): Promise<InviteRow> {
  const token = newInviteToken();
  const rows = await query<InviteRow>(
    `insert into invites (invite_token, kind, target_company_id, email, role, engagement_id,
                          invited_by_user_id, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' days')::interval)
     returning id, invite_token, kind, target_company_id, email, role, engagement_id, status,
               invited_by_user_id, expires_at`,
    [
      token,
      input.kind,
      input.targetCompanyId,
      input.email,
      input.role ?? null,
      input.engagementId ?? null,
      input.invitedByUserId,
      String(INVITE_TTL_DAYS),
    ],
    runner
  );
  return rows[0]!;
}

interface InviteViewRow extends InviteRow {
  target_company_name: string;
}

export async function findInviteView(token: string): Promise<InviteView | null> {
  const row = await queryOne<InviteViewRow>(
    `select i.*, c.name as target_company_name
       from invites i join companies c on c.id = i.target_company_id
      where i.invite_token = $1`,
    [token]
  );
  if (!row) return null;
  return {
    token: row.invite_token,
    kind: row.kind,
    targetCompanyId: row.target_company_id,
    targetCompanyName: row.target_company_name,
    email: row.email,
    role: row.role,
    engagementId: row.engagement_id,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
  };
}

export function findInviteRowByToken(token: string, runner?: Queryable): Promise<InviteRow | null> {
  return queryOne<InviteRow>(
    `select id, invite_token, kind, target_company_id, email, role, engagement_id, status,
            invited_by_user_id, expires_at
       from invites where invite_token = $1`,
    [token],
    runner
  );
}

export async function markInviteAccepted(id: string, runner?: Queryable): Promise<void> {
  await query(
    `update invites set status = 'ACCEPTED', updated_at = now() where id = $1`,
    [id],
    runner
  );
}
