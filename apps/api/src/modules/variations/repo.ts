import {
  computeVariationTotals,
  variationMarginPct,
  type VariationLineKind,
  type VariationLineView,
  type PortalVariationView,
  type VariationStatus,
  type VariationView,
} from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

/**
 * `variations` + `variation_lines` reads and writes (§30.1, `0045`).
 *
 * One rule runs through the whole file: **the totals are derived here and nowhere
 * else.** `recalculateVariationTotals` is the only writer of
 * `sell_total_cents`/`cost_total_cents`, every line write is followed by it inside
 * the same transaction, and no insert or update statement in this file accepts a
 * header total from a caller. That is packet finding 5's half that a check
 * constraint cannot cover, because a `check` cannot aggregate.
 */

interface VariationRow {
  id: string;
  project_id: string;
  company_id: string;
  company_name: string | null;
  engagement_id: string | null;
  reference: string | null;
  description: string;
  reason: string | null;
  requested_by: string | null;
  requested_on: string;
  status: VariationStatus;
  sell_total_cents: number;
  cost_total_cents: number;
  client_approved_by: string | null;
  client_approved_at: Date | null;
  approval_evidence_file_id: string | null;
  reviewed_by_user_id: string | null;
  reviewed_by_name: string | null;
  reviewed_at: Date | null;
  reject_reason: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  revision: number;
  created_by_user_id: string | null;
  created_by_name: string | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface LineRow {
  id: string;
  variation_id: string;
  kind: VariationLineKind;
  description: string;
  quantity: string;
  unit_cost_cents: number;
  unit_sell_cents: number;
  cost_cents: number;
  sell_cents: number;
  role_id: string | null;
  role_name: string | null;
  shift_type: string | null;
  priced_from: VariationLineView['pricedFrom'];
  asset_id: string | null;
  created_at: Date;
}

const COLUMNS = `v.id, v.project_id, v.company_id, c.name as company_name, v.engagement_id,
  v.reference, v.description, v.reason, v.requested_by,
  to_char(v.requested_on, 'YYYY-MM-DD') as requested_on,
  v.status, v.sell_total_cents, v.cost_total_cents,
  v.client_approved_by, v.client_approved_at, v.approval_evidence_file_id,
  v.reviewed_by_user_id, ru.name as reviewed_by_name, v.reviewed_at, v.reject_reason,
  v.invoice_id, i.number as invoice_number, v.revision,
  v.created_by_user_id, cu.name as created_by_name,
  v.deleted_at, v.created_at, v.updated_at`;

const FROM = `from variations v
  left join companies c on c.id = v.company_id
  left join users ru on ru.id = v.reviewed_by_user_id
  left join users cu on cu.id = v.created_by_user_id
  left join invoices i on i.id = v.invoice_id`;

const LINE_COLUMNS = `l.id, l.variation_id, l.kind, l.description, l.quantity::text as quantity,
  l.unit_cost_cents, l.unit_sell_cents, l.cost_cents, l.sell_cents,
  l.role_id, r.name as role_name, l.shift_type, l.priced_from, l.asset_id, l.created_at`;

function toLineView(row: LineRow): VariationLineView {
  return {
    id: row.id,
    variationId: row.variation_id,
    kind: row.kind,
    description: row.description,
    quantity: Number(row.quantity),
    unitCostCents: row.unit_cost_cents,
    unitSellCents: row.unit_sell_cents,
    costCents: row.cost_cents,
    sellCents: row.sell_cents,
    roleId: row.role_id,
    roleName: row.role_name,
    assetId: row.asset_id,
    pricedFrom: row.priced_from,
    createdAt: row.created_at.toISOString(),
  };
}

function toView(row: VariationRow, lines: LineRow[]): VariationView {
  return {
    id: row.id,
    projectId: row.project_id,
    companyId: row.company_id,
    companyName: row.company_name,
    engagementId: row.engagement_id,
    reference: row.reference,
    description: row.description,
    reason: row.reason,
    requestedBy: row.requested_by,
    requestedOn: row.requested_on,
    status: row.status,
    sellTotalCents: row.sell_total_cents,
    costTotalCents: row.cost_total_cents,
    marginPct: variationMarginPct(row.sell_total_cents, row.cost_total_cents),
    clientApprovedBy: row.client_approved_by,
    clientApprovedAt: row.client_approved_at?.toISOString() ?? null,
    /*
     * Derived rather than stored, so it cannot disagree with the column it
     * describes. Packet §3: approval without the client's own agreement recorded is
     * permitted — the paperwork arrives on Friday and the crew works on Wednesday —
     * but it is never silent.
     */
    clientApprovalRecorded: row.client_approved_by !== null,
    approvalEvidenceFileId: row.approval_evidence_file_id,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedByName: row.reviewed_by_name,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    rejectReason: row.reject_reason,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    lines: lines.map(toLineView),
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name,
    revision: row.revision,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export type { VariationRow };

export async function findVariationRow(
  id: string,
  runner?: Queryable
): Promise<VariationRow | null> {
  return queryOne<VariationRow>(`select ${COLUMNS} ${FROM} where v.id = $1`, [id], runner);
}

export async function findVariation(
  id: string,
  runner?: Queryable
): Promise<VariationView | null> {
  const row = await findVariationRow(id, runner);
  if (!row) return null;
  const lines = await query<LineRow>(
    `select ${LINE_COLUMNS} from variation_lines l
       left join role_catalog r on r.id = l.role_id
      where l.variation_id = $1 order by l.created_at, l.id`,
    [id],
    runner
  );
  return toView(row, lines);
}

/**
 * A project's variations, scoped.
 *
 * `ownerScope` is the whole authorization of this read in one boolean: the project
 * owner sees every row, and a subcontractor sees **only its own**. Not a filter a
 * caller may skip — the parameter is required, which is the shape `activities.ts`
 * uses for the same reason. A variation row carries a price another business
 * quoted; a hiring company seeing its subcontractor's other variations would be
 * reading somebody else's commercial position.
 */
export async function listProjectVariations(args: {
  projectId: string;
  ownerScope: boolean;
  companyId: string;
  status?: VariationStatus;
  includeDeleted?: boolean;
  runner?: Queryable;
}): Promise<VariationView[]> {
  const rows = await query<VariationRow>(
    `select ${COLUMNS} ${FROM}
      where v.project_id = $1
        and ($2::boolean or v.company_id = $3)
        and ($4::boolean or v.deleted_at is null)
        and ($5::text is null or v.status = $5)
      order by v.requested_on desc, v.created_at desc`,
    [
      args.projectId,
      args.ownerScope,
      args.companyId,
      args.includeDeleted ?? false,
      args.status ?? null,
    ],
    args.runner
  );
  if (rows.length === 0) return [];

  // One query for every line on the page rather than one per variation: the panel
  // renders totals and lines together, and N+1 on a project with forty variations
  // is forty round trips for a screen.
  const lines = await query<LineRow>(
    `select ${LINE_COLUMNS} from variation_lines l
       left join role_catalog r on r.id = l.role_id
      where l.variation_id = any($1::uuid[]) order by l.created_at, l.id`,
    [rows.map((r) => r.id)],
    args.runner
  );
  const byVariation = new Map<string, LineRow[]>();
  for (const line of lines) {
    const list = byVariation.get(line.variation_id) ?? [];
    list.push(line);
    byVariation.set(line.variation_id, list);
  }
  return rows.map((row) => toView(row, byVariation.get(row.id) ?? []));
}

export interface InsertVariationInput {
  projectId: string;
  companyId: string;
  engagementId: string | null;
  reference: string | null;
  description: string;
  reason: string | null;
  requestedBy: string | null;
  requestedOn: string;
  clientId: string | null;
  createdByUserId: string;
}

export async function insertVariation(
  input: InsertVariationInput,
  runner: Queryable
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into variations
       (project_id, company_id, engagement_id, reference, description, reason,
        requested_by, requested_on, client_id, created_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10)
     returning id`,
    [
      input.projectId,
      input.companyId,
      input.engagementId,
      input.reference,
      input.description,
      input.reason,
      input.requestedBy,
      input.requestedOn,
      input.clientId,
      input.createdByUserId,
    ],
    runner
  );
  return row!.id;
}

export interface InsertLineInput {
  variationId: string;
  kind: VariationLineKind;
  description: string;
  quantity: number;
  unitCostCents: number;
  unitSellCents: number;
  costCents: number;
  sellCents: number;
  roleId: string | null;
  shiftType: string | null;
  pricedFrom: VariationLineView['pricedFrom'];
  assetId: string | null;
}

export async function insertVariationLine(
  input: InsertLineInput,
  runner: Queryable
): Promise<void> {
  await query(
    `insert into variation_lines
       (variation_id, kind, description, quantity, unit_cost_cents, unit_sell_cents,
        cost_cents, sell_cents, role_id, shift_type, priced_from, asset_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      input.variationId,
      input.kind,
      input.description,
      input.quantity,
      input.unitCostCents,
      input.unitSellCents,
      input.costCents,
      input.sellCents,
      input.roleId,
      input.shiftType,
      input.pricedFrom,
      input.assetId,
    ],
    runner
  );
}

export async function deleteVariationLines(
  variationId: string,
  runner: Queryable
): Promise<void> {
  await query(`delete from variation_lines where variation_id = $1`, [variationId], runner);
}

/**
 * Recompute the header from the lines. The **only** writer of the two totals.
 *
 * Summed in TypeScript through `computeVariationTotals` rather than with a SQL
 * `sum()`, and that is deliberate: the same function computes the totals a caller
 * is shown before saving, so the preview and the stored row cannot disagree about
 * rounding. The lines themselves are already exact — the database's own check
 * constraint guarantees `cost_cents = round(quantity * unit_cost_cents)` — so this
 * is a sum of integers either way.
 */
export async function recalculateVariationTotals(
  variationId: string,
  runner: Queryable
): Promise<{ costTotalCents: number; sellTotalCents: number }> {
  const lines = await query<{ quantity: string; unit_cost_cents: number; unit_sell_cents: number }>(
    `select quantity::text as quantity, unit_cost_cents, unit_sell_cents
       from variation_lines where variation_id = $1`,
    [variationId],
    runner
  );
  const totals = computeVariationTotals(
    lines.map((l) => ({
      quantity: Number(l.quantity),
      unitCostCents: l.unit_cost_cents,
      unitSellCents: l.unit_sell_cents,
    }))
  );
  await query(
    `update variations set cost_total_cents = $2, sell_total_cents = $3, updated_at = now()
      where id = $1`,
    [variationId, totals.costTotalCents, totals.sellTotalCents],
    runner
  );
  return totals;
}

export interface UpdateVariationFields {
  reference?: string | null;
  description?: string;
  reason?: string | null;
  requestedBy?: string | null;
  requestedOn?: string;
}

/**
 * Patch the editable header fields and bump the revision.
 *
 * The revision bump is unconditional on a successful patch, because the sync
 * contract's `expectedRevision` is about *"has anything moved since I read this"*
 * and a caller that replaced the lines without touching the description has still
 * changed the record. `detectConflict` is what compares them, in the route.
 */
export async function updateVariationFields(
  id: string,
  fields: UpdateVariationFields,
  updatedByUserId: string,
  runner: Queryable
): Promise<void> {
  await query(
    `update variations set
       reference     = case when $2::boolean then $3 else reference end,
       description   = coalesce($4, description),
       reason        = case when $5::boolean then $6 else reason end,
       requested_by  = case when $7::boolean then $8 else requested_by end,
       requested_on  = coalesce($9::date, requested_on),
       revision      = revision + 1,
       updated_by_user_id = $10,
       updated_at    = now()
     where id = $1`,
    [
      id,
      'reference' in fields,
      fields.reference ?? null,
      fields.description ?? null,
      'reason' in fields,
      fields.reason ?? null,
      'requestedBy' in fields,
      fields.requestedBy ?? null,
      fields.requestedOn ?? null,
      updatedByUserId,
    ],
    runner
  );
}

/**
 * Drive a transition, conditionally on the source state.
 *
 * **A conditional update rather than a read-then-write**, which is packet §3's
 * concurrency rule and `transitionInvoice`'s shape: two reviewers pressing Approve
 * on the same `SUBMITTED` row cannot both succeed, and the loser gets `null` back
 * so the route can answer 409 naming the state the row is actually in.
 */
export async function transitionVariation(args: {
  id: string;
  from: VariationStatus;
  to: VariationStatus;
  reviewedByUserId?: string | null;
  rejectReason?: string | null;
  clientApprovedBy?: string | null;
  clientApprovedAt?: string | null;
  approvalEvidenceFileId?: string | null;
  /** Set only by the invoice domain. */
  invoiceId?: string | null;
  clearInvoice?: boolean;
  runner: Queryable;
}): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `update variations set
       status = $3,
       reviewed_by_user_id = coalesce($4, reviewed_by_user_id),
       reviewed_at = case when $4::uuid is null then reviewed_at else now() end,
       -- Cleared on any transition away from REJECTED, so a resubmitted variation
       -- does not carry the reason it was refused last time as if it still applied.
       reject_reason = case when $3 = 'REJECTED' then $5 else null end,
       client_approved_by = case when $6::boolean then $7 else client_approved_by end,
       client_approved_at = case when $6::boolean then $8::timestamptz else client_approved_at end,
       approval_evidence_file_id =
         case when $9::boolean then $10 else approval_evidence_file_id end,
       invoice_id = case when $11::boolean then $12 else invoice_id end,
       updated_at = now()
     where id = $1 and status = $2
     returning id`,
    [
      args.id,
      args.from,
      args.to,
      args.reviewedByUserId ?? null,
      args.rejectReason ?? null,
      args.clientApprovedBy !== undefined,
      args.clientApprovedBy ?? null,
      args.clientApprovedAt ?? null,
      args.approvalEvidenceFileId !== undefined,
      args.approvalEvidenceFileId ?? null,
      args.invoiceId !== undefined || args.clearInvoice === true,
      args.invoiceId ?? null,
    ],
    args.runner
  );
  return row?.id ?? null;
}

/** Tombstone a draft. Never a hard delete — see the sync contract (0029). */
export async function tombstoneVariation(
  id: string,
  userId: string,
  runner: Queryable
): Promise<void> {
  await query(
    `update variations set deleted_at = now(), revision = revision + 1,
       updated_by_user_id = $2, updated_at = now()
      where id = $1 and deleted_at is null`,
    [id, userId],
    runner
  );
}

/** How many variations a project holds, for the project-delete refusal and the rail. */
export async function countProjectVariations(
  projectId: string,
  runner?: Queryable
): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `select count(*)::int as n from variations
      where project_id = $1 and deleted_at is null`,
    [projectId],
    runner
  );
  return Number(row?.n ?? 0);
}

/**
 * Approved variation totals for one project, for `computeProjectSummary`.
 *
 * **`APPROVED`, `COMPLETED` and `INVOICED` all count.** §30.1 says *"approved
 * variations feed project revenue"*, and the three later states are all *approved
 * and then something else*: work that was done, or work that was billed. Counting
 * only the literal `APPROVED` state would make a project's revenue **fall** the
 * moment somebody marked the works complete, which is the opposite of what both
 * words mean.
 */
export async function approvedVariationTotals(
  projectId: string,
  runner?: Queryable
): Promise<{ count: number; sellCents: number; costCents: number }> {
  const row = await queryOne<{ n: string; sell: string; cost: string }>(
    `select count(*)::int as n,
            coalesce(sum(sell_total_cents), 0)::bigint as sell,
            coalesce(sum(cost_total_cents), 0)::bigint as cost
       from variations
      where project_id = $1 and deleted_at is null
        and status in ('APPROVED','COMPLETED','INVOICED')`,
    [projectId],
    runner
  );
  return {
    count: Number(row?.n ?? 0),
    sellCents: Number(row?.sell ?? 0),
    costCents: Number(row?.cost ?? 0),
  };
}

/**
 * §13.2's notice: approved timesheets falling inside a variation's dates.
 *
 * The product cannot know whether a lump sum was quoted *instead of* or *in
 * addition to* the hours behind it, so it declines to guess and counts them for the
 * person creating the invoice — who is the only one who does know.
 *
 * The window is the variation's `requested_on` through the latest `requested_on` of
 * anything on the project… which would be arbitrary. It is the requested date ± 14
 * days instead, and the number is stated rather than derived because a variation
 * carries no end date at all: §30.1 gives it one date, and the works happen around
 * it. Two weeks is the interval a fortnightly timesheet run would land in.
 */
export async function approvedTimeLogsNearVariation(
  variationId: string,
  runner?: Queryable
): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `select count(*)::int as n
       from time_logs t
       join variations v on v.id = $1
      where t.project_id = v.project_id
        and t.status = 'APPROVED'
        and t.work_date between v.requested_on - interval '14 days'
                            and v.requested_on + interval '14 days'`,
    [variationId],
    runner
  );
  return Number(row?.n ?? 0);
}

/** Does this variation grant its parties access to a file? For the storage registry. */
export async function variationGrantsFileAccess(
  fileId: string,
  companyId: string
): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `select true as ok
       from variations v
       join projects p on p.id = v.project_id
      where v.approval_evidence_file_id = $1
        and v.deleted_at is null
        and (v.company_id = $2 or p.owner_company_id = $2)
      limit 1`,
    [fileId, companyId]
  );
  return row?.ok === true;
}

/**
 * And the client's narrower grant: *"a variation you approved cites this."*
 *
 * `APPROVED` and later only, and only on a project whose client is this company.
 * The same shape `reportFileDisclosedToClient` has — narrower than publishing the
 * photograph generally, and it expires with nothing, because the agreement does
 * not expire.
 */
export async function variationFileDisclosedToClient(
  fileId: string,
  companyId: string
): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `select true as ok
       from variations v
       join projects p on p.id = v.project_id
      where v.approval_evidence_file_id = $1
        and v.deleted_at is null
        and v.status in ('APPROVED','COMPLETED','INVOICED')
        and p.client_company_id = $2
      limit 1`,
    [fileId, companyId]
  );
  return row?.ok === true;
}

/**
 * The client's half — `APPROVED` and later, **sell only** (packet §13.6).
 *
 * The `select` list is the guarantee rather than a convention: `PortalVariationView`
 * has no field a cost figure, a margin or a provider name could occupy, so there is
 * nothing for a later edit to widen. That is `reporting-signoff.md` finding 3's
 * mechanism — an exclusion that lives in a `select` list is an exclusion somebody
 * forgets, and one that lives in a *type* is not.
 */
export async function listPortalVariations(
  projectId: string,
  runner?: Queryable
): Promise<PortalVariationView[]> {
  const rows = await query<{
    id: string;
    reference: string | null;
    description: string;
    requested_on: string;
    status: 'APPROVED' | 'COMPLETED' | 'INVOICED';
    sell_total_cents: number;
    client_approved_by: string | null;
    client_approved_at: Date | null;
    reviewed_at: Date | null;
  }>(
    `select v.id, v.reference, v.description,
            to_char(v.requested_on, 'YYYY-MM-DD') as requested_on,
            v.status, v.sell_total_cents,
            v.client_approved_by, v.client_approved_at, v.reviewed_at
       from variations v
      where v.project_id = $1 and v.deleted_at is null
        and v.status in ('APPROVED','COMPLETED','INVOICED')
      order by v.requested_on desc, v.created_at desc`,
    [projectId],
    runner
  );
  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    description: row.description,
    requestedOn: row.requested_on,
    status: row.status,
    sellTotalCents: row.sell_total_cents,
    clientApprovedBy: row.client_approved_by,
    clientApprovedAt: row.client_approved_at?.toISOString() ?? null,
    approvedAt: row.reviewed_at?.toISOString() ?? null,
  }));
}
