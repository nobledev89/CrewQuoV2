import type { MergeOutcome } from '@crewquo/shared';
import type { PoolClient } from 'pg';
import { query, queryOne } from '../../db';
import { decideMerge } from '../../authorization/policies';

/**
 * Placeholder → real company auto-merge (CREWQUO_V2_PLAN.md §3.6; owner decision
 * 2026-08-17).
 *
 * When a company invites a subcontractor or a client, it first creates a
 * *placeholder* company to hang the engagement off. If the invitee turns out to
 * already run a real company on CrewQuo, accepting the invite folds the
 * placeholder into it automatically — no confirmation prompt on either side.
 *
 * "Automatically" is not the same as "unconditionally": see `decideMerge` for the
 * collisions that make a merge lossy, in which case the placeholder is claimed
 * the old way and the reason is reported back. Nothing is ever discarded.
 */

/**
 * The real company to fold a placeholder into, or null when we can't tell.
 *
 * `preferredCompanyId` is the company the accepting user was acting as, which
 * disambiguates when they own several. With no preference and more than one
 * candidate we decline to guess — claiming the placeholder is always safe, while
 * merging into the wrong company is not.
 */
export async function resolveMergeTarget(
  userId: string,
  placeholderCompanyId: string,
  preferredCompanyId: string | null
): Promise<string | null> {
  const rows = await query<{ company_id: string }>(
    `select m.company_id
       from memberships m
       join companies c on c.id = m.company_id
      where m.user_id = $1 and m.status = 'ACTIVE'
        and not c.is_placeholder
        and c.id <> $2`,
    [userId, placeholderCompanyId]
  );
  if (rows.length === 0) return null;
  if (preferredCompanyId && rows.some((r) => r.company_id === preferredCompanyId)) {
    return preferredCompanyId;
  }
  return rows.length === 1 ? rows[0]!.company_id : null;
}

/**
 * Plan the merge: resolve a target and check it against the constraints that
 * would make re-pointing lossy — the engagement (client, provider) unique index,
 * the assignment (project, provider) unique index, and the client <> provider
 * check.
 */
export async function planMerge(args: {
  userId: string;
  placeholderCompanyId: string;
  counterpartyCompanyId: string;
  /** True when the placeholder sits on the provider side of the edge. */
  placeholderIsProvider: boolean;
  preferredCompanyId: string | null;
}): Promise<{ outcome: MergeOutcome['outcome']; targetCompanyId: string | null; reason: string | null }> {
  const targetCompanyId = await resolveMergeTarget(
    args.userId,
    args.placeholderCompanyId,
    args.preferredCompanyId
  );
  if (targetCompanyId === null) {
    return { outcome: 'CLAIMED', targetCompanyId: null, reason: null };
  }

  // Would an edge between the counterparty and the target already exist? The
  // unique index is on (client, provider), so orientation matters.
  const [clientId, providerId] = args.placeholderIsProvider
    ? [args.counterpartyCompanyId, targetCompanyId]
    : [targetCompanyId, args.counterpartyCompanyId];
  const edgeExists =
    (await queryOne(
      `select 1 from engagements where client_company_id = $1 and provider_company_id = $2`,
      [clientId, providerId]
    )) !== null;

  // Only the provider side appears in project_assignments.
  const assignmentClash = args.placeholderIsProvider
    ? (await queryOne(
        `select 1
           from project_assignments a
          where a.provider_company_id = $1
            and a.project_id in (select project_id from project_assignments where provider_company_id = $2)`,
        [targetCompanyId, args.placeholderCompanyId]
      )) !== null
    : false;

  const decision = decideMerge({
    targetCompanyId,
    placeholderCompanyId: args.placeholderCompanyId,
    counterpartyCompanyId: args.counterpartyCompanyId,
    edgeExists,
    assignmentClash,
  });
  return { ...decision, targetCompanyId };
}

/**
 * Re-point every row that names the placeholder at the real company, inside the
 * caller's transaction. Ordered so the engagement moves last: the work rows
 * reference it, and moving them first keeps each statement independently sane.
 */
export async function applyMerge(
  args: {
    placeholderCompanyId: string;
    targetCompanyId: string;
    engagementId: string;
    placeholderIsProvider: boolean;
  },
  client: PoolClient
): Promise<void> {
  const { placeholderCompanyId: from, targetCompanyId: to } = args;

  if (args.placeholderIsProvider) {
    await query(
      `update project_assignments set provider_company_id = $2, updated_at = now()
        where provider_company_id = $1`,
      [from, to],
      client
    );
    await query(
      `update time_logs set provider_company_id = $2, updated_at = now()
        where provider_company_id = $1`,
      [from, to],
      client
    );
    await query(
      `update expenses set provider_company_id = $2, updated_at = now()
        where provider_company_id = $1`,
      [from, to],
      client
    );
    await query(
      `update project_submissions set provider_company_id = $2, updated_at = now()
        where provider_company_id = $1`,
      [from, to],
      client
    );
    await query(
      `update engagements set provider_company_id = $2, updated_at = now() where id = $1`,
      [args.engagementId, to],
      client
    );
  } else {
    // The placeholder stood in for a client: projects point at it, and its rate
    // cards may name it as a counterparty.
    await query(
      `update projects set client_company_id = $2, updated_at = now()
        where client_company_id = $1`,
      [from, to],
      client
    );
    await query(
      `update engagements set client_company_id = $2, updated_at = now() where id = $1`,
      [args.engagementId, to],
      client
    );
  }

  await query(
    `update rate_cards set counterparty_company_id = $2, updated_at = now()
      where counterparty_company_id = $1`,
    [from, to],
    client
  );

  // The placeholder stays behind as a tombstone pointing at its real company, so
  // any id captured elsewhere (an old audit row, a cached response) still resolves.
  await query(
    `update companies set claimed_by_company_id = $2, updated_at = now() where id = $1`,
    [from, to],
    client
  );
}
