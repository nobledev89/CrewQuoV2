import type { EngagementStatus, UpdateEngagementTerms } from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';
import { AppError } from '../../http/errors';

/**
 * Engagement commercial terms and acceptance (Phase 6 commercial hardening).
 *
 * Terms live on the **edge**, not the project: payment days, the purchase-order
 * reference and its ceiling are what the two companies agreed, and every project on
 * that edge inherits them. Kept in its own file rather than growing
 * `engagements/repo.ts`, which is already the one-hop visibility surface.
 */

export interface EngagementTerms {
  engagementId: string;
  clientCompanyId: string;
  providerCompanyId: string;
  status: EngagementStatus;
  paymentTermsDays: number | null;
  purchaseOrderReference: string | null;
  purchaseOrderCeilingCents: number | null;
  termsUpdatedAt: string | null;
  providerAcceptedAt: string | null;
  decisionReason: string | null;
}

interface TermsRow {
  id: string;
  client_company_id: string;
  provider_company_id: string;
  status: EngagementStatus;
  payment_terms_days: number | null;
  purchase_order_reference: string | null;
  /** bigint comes back from pg as a string — a ceiling can exceed 2^31 cents. */
  purchase_order_ceiling_cents: string | null;
  terms_updated_at: Date | null;
  provider_accepted_at: Date | null;
  decision_reason: string | null;
}

const TERMS_SELECT = `
  select id, client_company_id, provider_company_id, status,
         payment_terms_days, purchase_order_reference, purchase_order_ceiling_cents,
         terms_updated_at, provider_accepted_at, decision_reason
    from engagements`;

function toTerms(row: TermsRow): EngagementTerms {
  return {
    engagementId: row.id,
    clientCompanyId: row.client_company_id,
    providerCompanyId: row.provider_company_id,
    status: row.status,
    paymentTermsDays: row.payment_terms_days,
    purchaseOrderReference: row.purchase_order_reference,
    purchaseOrderCeilingCents:
      row.purchase_order_ceiling_cents === null
        ? null
        : Number(row.purchase_order_ceiling_cents),
    termsUpdatedAt: row.terms_updated_at?.toISOString() ?? null,
    providerAcceptedAt: row.provider_accepted_at?.toISOString() ?? null,
    decisionReason: row.decision_reason,
  };
}

export async function getEngagementTerms(
  engagementId: string,
  runner?: Queryable
): Promise<EngagementTerms | null> {
  const row = await queryOne<TermsRow>(`${TERMS_SELECT} where id = $1`, [engagementId], runner);
  return row ? toTerms(row) : null;
}

export async function updateEngagementTerms(
  engagementId: string,
  patch: UpdateEngagementTerms,
  runner?: Queryable
): Promise<EngagementTerms> {
  const has = (key: keyof UpdateEngagementTerms) => key in patch;
  const row = await queryOne<TermsRow>(
    `update engagements set
       payment_terms_days = case when $2::boolean then $3 else payment_terms_days end,
       purchase_order_reference = case when $4::boolean then $5 else purchase_order_reference end,
       purchase_order_ceiling_cents =
         case when $6::boolean then $7::bigint else purchase_order_ceiling_cents end,
       terms_updated_at = now(),
       updated_at = now()
     where id = $1
     returning id, client_company_id, provider_company_id, status,
               payment_terms_days, purchase_order_reference, purchase_order_ceiling_cents,
               terms_updated_at, provider_accepted_at, decision_reason`,
    [
      engagementId,
      has('paymentTermsDays'),
      patch.paymentTermsDays ?? null,
      has('purchaseOrderReference'),
      patch.purchaseOrderReference ?? null,
      has('purchaseOrderCeilingCents'),
      patch.purchaseOrderCeilingCents ?? null,
    ],
    runner
  );
  if (!row) throw new AppError('NOT_FOUND', 'Engagement not found');
  return toTerms(row);
}

/**
 * Record the provider's decision on an engagement it has been offered.
 *
 * `PENDING → ACTIVE` on accept, `PENDING → ENDED` on decline. Conditional on the
 * source status so two managers deciding at once cannot both succeed, and so a
 * decision on an already-live edge is a conflict rather than a silent no-op.
 */
export async function decideEngagementAcceptance(
  args: {
    engagementId: string;
    accept: boolean;
    reason: string | null;
    actorUserId: string;
  },
  runner?: Queryable
): Promise<EngagementTerms> {
  const row = await queryOne<TermsRow>(
    `update engagements set
       status = $2,
       provider_accepted_at = case when $3::boolean then now() else null end,
       provider_accepted_by_user_id = case when $3::boolean then $4::uuid else null end,
       decision_reason = $5,
       updated_at = now()
     where id = $1 and status = 'PENDING'
     returning id, client_company_id, provider_company_id, status,
               payment_terms_days, purchase_order_reference, purchase_order_ceiling_cents,
               terms_updated_at, provider_accepted_at, decision_reason`,
    [
      args.engagementId,
      args.accept ? 'ACTIVE' : 'ENDED',
      args.accept,
      args.actorUserId,
      args.reason,
    ],
    runner
  );
  if (!row) {
    const current = await queryOne<{ status: EngagementStatus }>(
      `select status from engagements where id = $1`,
      [args.engagementId],
      runner
    );
    throw new AppError(
      'CONFLICT',
      current
        ? `This engagement is ${current.status.toLowerCase()} — only a pending one awaits a decision`
        : 'Engagement not found'
    );
  }
  return toTerms(row);
}

/**
 * Invoice value already committed against this edge, for the purchase-order
 * ceiling check.
 *
 * `ISSUED` and `PAID` count; `DRAFT` and `VOID` do not. A draft is a working
 * document, and letting one block a colleague's issue would make the refusal depend
 * on what somebody happened to leave open. A void has been withdrawn, and the same
 * reasoning already makes its source work re-invoiceable (§3.5).
 */
export async function listCommittedInvoiceCents(
  engagementId: string,
  runner?: Queryable
): Promise<number> {
  const row = await queryOne<{ total: string }>(
    `select coalesce(sum(total_cents), 0)::bigint as total from invoices
      where engagement_id = $1 and status in ('ISSUED','PAID')`,
    [engagementId],
    runner
  );
  return Number(row?.total ?? 0);
}

// ── Assignment acceptance ─────────────────────────────────────────────────────

export interface AssignmentAcceptanceRow {
  id: string;
  projectId: string;
  projectName: string;
  providerCompanyId: string;
  engagementId: string;
  acceptance: 'PENDING' | 'ACCEPTED' | 'DECLINED';
  acceptedAt: string | null;
  decisionReason: string | null;
}

/** An assignment plus the edge it hangs off, for the acceptance handlers. */
export async function findAssignmentForDecision(
  assignmentId: string,
  runner?: Queryable
): Promise<AssignmentAcceptanceRow | null> {
  const row = await queryOne<{
    id: string;
    project_id: string;
    project_name: string;
    provider_company_id: string;
    engagement_id: string;
    acceptance: 'PENDING' | 'ACCEPTED' | 'DECLINED';
    accepted_at: Date | null;
    decision_reason: string | null;
  }>(
    `select a.id, a.project_id, p.name as project_name, a.provider_company_id,
            a.engagement_id, a.acceptance, a.accepted_at, a.decision_reason
       from project_assignments a
       join projects p on p.id = a.project_id
      where a.id = $1`,
    [assignmentId],
    runner
  );
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    providerCompanyId: row.provider_company_id,
    engagementId: row.engagement_id,
    acceptance: row.acceptance,
    acceptedAt: row.accepted_at?.toISOString() ?? null,
    decisionReason: row.decision_reason,
  };
}

/**
 * Record the provider's decision on a project assignment.
 *
 * Unlike the engagement transition this is *not* conditional on `PENDING`: a
 * provider that declined and changed its mind should be able to accept, and a
 * provider that accepted should be able to withdraw from work it can no longer
 * staff. What it must not do is silently move without a record, which is why the
 * decision reason and timestamp are rewritten on every call.
 */
export async function decideAssignmentAcceptance(
  args: {
    assignmentId: string;
    accept: boolean;
    reason: string | null;
    actorUserId: string;
  },
  runner?: Queryable
): Promise<AssignmentAcceptanceRow> {
  const target = args.accept ? 'ACCEPTED' : 'DECLINED';
  const row = await queryOne<{ id: string }>(
    `update project_assignments set
       acceptance = $2,
       accepted_at = case when $3::boolean then now() else null end,
       accepted_by_user_id = case when $3::boolean then $4::uuid else null end,
       decision_reason = $5,
       updated_at = now()
     where id = $1 and acceptance <> $2
     returning id`,
    [args.assignmentId, target, args.accept, args.actorUserId, args.reason],
    runner
  );
  if (!row) {
    throw new AppError('CONFLICT', `This assignment is already ${target.toLowerCase()}`);
  }
  return (await findAssignmentForDecision(args.assignmentId, runner))!;
}

/** Every assignment the active provider company has been offered but not decided. */
export async function listPendingAssignmentsForProvider(
  providerCompanyId: string
): Promise<AssignmentAcceptanceRow[]> {
  const rows = await query<{
    id: string;
    project_id: string;
    project_name: string;
    provider_company_id: string;
    engagement_id: string;
    acceptance: 'PENDING' | 'ACCEPTED' | 'DECLINED';
    accepted_at: Date | null;
    decision_reason: string | null;
  }>(
    `select a.id, a.project_id, p.name as project_name, a.provider_company_id,
            a.engagement_id, a.acceptance, a.accepted_at, a.decision_reason
       from project_assignments a
       join projects p on p.id = a.project_id
      where a.provider_company_id = $1 and a.acceptance = 'PENDING'
      order by a.created_at desc`,
    [providerCompanyId]
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    providerCompanyId: row.provider_company_id,
    engagementId: row.engagement_id,
    acceptance: row.acceptance,
    acceptedAt: row.accepted_at?.toISOString() ?? null,
    decisionReason: row.decision_reason,
  }));
}
