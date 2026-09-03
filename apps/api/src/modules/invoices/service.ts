import type {
  CreateInvoice,
  CreateInvoiceItem,
  InvoiceSourceType,
  InvoiceView,
  ShiftType,
  UpdateInvoice,
  UpdateInvoiceItem,
} from '@crewquo/shared';
import { dueDateFromPaymentTerms, purchaseOrderCeilingRefusal } from '@crewquo/shared';
import { query, queryOne, withTransaction, type Queryable } from '../../db';
import { AppError } from '../../http/errors';
import { findCompanyById } from '../companies/repo';
import { findEngagementEdge } from '../engagements/repo';
import { getEngagementTerms, listCommittedInvoiceCents } from '../engagements/terms.repo';
import { resolveBillCentsForLog } from '../projects/billing';
import { getProject } from '../projects/repo';
import { getEffectiveTimeframeDefinitions } from '../rates/repo';
import {
  deleteInvoice,
  deleteInvoiceItem,
  getInvoice,
  insertInvoice,
  insertInvoiceItem,
  issueInvoice,
  recalculateInvoiceTotals,
  transitionInvoice,
  updateInvoiceDraft,
  updateManualItem,
} from './repo';

interface DerivedItem {
  description: string;
  quantity: number;
  unitAmountCents: number;
  sourceType: InvoiceSourceType;
  sourceId: string;
}

interface ApprovedTimeRow {
  id: string;
  role_name: string;
  role_id: string;
  shift_type: ShiftType;
  work_date: string;
  hours_regular: string;
  hours_ot: string;
}

interface ApprovedExpenseRow {
  id: string;
  amount_cents: number;
  category: string | null;
  description: string | null;
}

/**
 * §30.1's third source, and the Phase 6 hook coming due.
 *
 * PROGRESS recorded it on 2026-08-17 when this file shipped: *"Phase 11 hook:
 * approved variation lines join this same source builder when the variations domain
 * exists; no variation table or calculation exists yet to duplicate here."*
 *
 * **The double bill is prevented by the mechanism that already prevents it for a
 * timesheet, not by a second one.** `createProjectInvoice` takes
 * `pg_advisory_xact_lock` on `invoice-project:<id>`, this query selects `for
 * update`, and the `not exists` clause excludes anything already cited by a
 * non-void invoice. Two invoices racing for the same variation: the second finds
 * nothing to claim. That is the whole reason this is a third branch here rather
 * than a route of its own.
 */
interface ApprovedVariationRow {
  id: string;
  reference: string | null;
  description: string;
  sell_total_cents: number;
  requested_on: string;
}

async function loadDerivedItems(args: {
  projectId: string;
  ownerCompanyId: string;
  clientCompanyId: string;
  /** The unit this invoice is denominated in — the project's reporting currency. */
  invoiceCurrency: string;
  only?: { sourceType: 'TIME_LOG' | 'EXPENSE' | 'VARIATION'; sourceId: string };
  runner: Queryable;
}): Promise<DerivedItem[]> {
  const sourceType = args.only?.sourceType ?? null;
  const sourceId = args.only?.sourceId ?? null;
  const logs = sourceType === 'EXPENSE' ? [] : await query<ApprovedTimeRow>(
    `select t.id, r.name as role_name, t.role_id, t.shift_type,
            to_char(t.work_date, 'YYYY-MM-DD') as work_date,
            t.hours_regular, t.hours_ot
       from time_logs t
       join role_catalog r on r.id = t.role_id
      where t.project_id = $1 and t.status = 'APPROVED'
        and ($2::uuid is null or t.id = $2)
        and not exists (
          select 1 from invoice_items ii join invoices i on i.id = ii.invoice_id
           where ii.source_type = 'TIME_LOG' and ii.source_id = t.id and i.status <> 'VOID'
        )
      order by t.work_date, t.created_at
      for update of t`,
    [args.projectId, sourceType === 'TIME_LOG' ? sourceId : null],
    args.runner
  );
  const expenses = sourceType === 'TIME_LOG' ? [] : await query<ApprovedExpenseRow>(
    `select e.id, e.amount_cents, e.category, e.description
       from expenses e
      where e.project_id = $1 and e.status = 'APPROVED'
        and ($2::uuid is null or e.id = $2)
        and not exists (
          select 1 from invoice_items ii join invoices i on i.id = ii.invoice_id
           where ii.source_type = 'EXPENSE' and ii.source_id = e.id and i.status <> 'VOID'
        )
      order by e.created_at
      for update of e`,
    [args.projectId, sourceType === 'EXPENSE' ? sourceId : null],
    args.runner
  );

  /*
   * `APPROVED` and `COMPLETED`, never `INVOICED` — and the `not exists` guard is
   * belt to that braces: `variations_invoiced_pairing` already makes the status and
   * the `invoice_id` one fact, so a variation cited by a live invoice cannot be in
   * a claimable state. Both are kept because the pairing is a constraint about the
   * row and this is a fact about the invoice, and a voided invoice returns the
   * variation to `APPROVED` while leaving its `invoice_items` row standing.
   */
  const variations = sourceType === 'TIME_LOG' || sourceType === 'EXPENSE'
    ? []
    : await query<ApprovedVariationRow>(
        `select v.id, v.reference, v.description, v.sell_total_cents,
                to_char(v.requested_on, 'YYYY-MM-DD') as requested_on
           from variations v
          where v.project_id = $1 and v.deleted_at is null
            and v.status in ('APPROVED','COMPLETED')
            and ($2::uuid is null or v.id = $2)
            and not exists (
              select 1 from invoice_items ii join invoices i on i.id = ii.invoice_id
               where ii.source_type = 'VARIATION' and ii.source_id = v.id and i.status <> 'VOID'
            )
          order by v.requested_on, v.created_at
          for update of v`,
        [args.projectId, sourceType === 'VARIATION' ? sourceId : null],
        args.runner
      );

  if (args.only && logs.length + expenses.length + variations.length === 0) {
    throw new AppError(
      'CONFLICT',
      'Source is not approved work on this project, or it is already invoiced'
    );
  }

  const labelRules = await getEffectiveTimeframeDefinitions(args.ownerCompanyId, args.runner);
  const items: DerivedItem[] = [];
  const missingRateIds: string[] = [];
  for (const log of logs) {
    const hoursRegular = Number(log.hours_regular);
    const hoursOt = Number(log.hours_ot);
    const bill = await resolveBillCentsForLog({
      ownerCompanyId: args.ownerCompanyId,
      clientCompanyId: args.clientCompanyId,
      roleId: log.role_id,
      shiftType: log.shift_type,
      workDate: log.work_date,
      hoursRegular,
      hoursOt,
      labelRules,
      runner: args.runner,
    });
    if (bill === null) {
      missingRateIds.push(log.id);
      continue;
    }
    const hours = `${hoursRegular}h${hoursOt ? ` + ${hoursOt}h OT` : ''}`;
    items.push({
      description: `${log.role_name} - ${log.work_date} (${hours})`,
      quantity: 1,
      unitAmountCents: bill.amountCents,
      sourceType: 'TIME_LOG',
      sourceId: log.id,
    });
  }
  if (missingRateIds.length > 0) {
    throw new AppError('VALIDATION', 'Some approved time cannot be billed because a BILL rate is missing', {
      timeLogIds: missingRateIds,
    });
  }

  for (const expense of expenses) {
    const label = expense.description || expense.category || 'Approved expense';
    items.push({
      description: label,
      quantity: 1,
      unitAmountCents: expense.amount_cents,
      sourceType: 'EXPENSE',
      sourceId: expense.id,
    });
  }

  /*
   * The variation's SELL total, at quantity 1.
   *
   * Not its lines. A variation is one agreed sum — §30.1's `sell_total_cents` is
   * what the client said yes to — and exploding it into six invoice lines would
   * show a client the internal breakdown of a price they agreed as a lump, which is
   * both more information than they were given and more disagreement than the
   * agreement contains. The lines are how the contractor arrived at the figure and
   * they stay on the variation, where §36's revision trail keeps them.
   *
   * The description names the reference, because *"why is this invoice bigger than
   * the quote?"* is the question this line exists to answer and a reference is what
   * a client looks it up by.
   */
  for (const variation of variations) {
    const label = variation.reference
      ? `Variation ${variation.reference} - ${variation.description}`
      : `Variation - ${variation.description}`;
    items.push({
      description: label.slice(0, 500),
      quantity: 1,
      unitAmountCents: variation.sell_total_cents,
      sourceType: 'VARIATION',
      sourceId: variation.id,
    });
  }
  return items;
}

async function insertDerivedItems(invoiceId: string, items: DerivedItem[], runner: Queryable) {
  for (const item of items) await insertInvoiceItem({ invoiceId, ...item }, runner);
  await markVariationsInvoiced(invoiceId, items, runner);
}

/**
 * `APPROVED | COMPLETED → INVOICED`, inside the transaction that created the line.
 *
 * **There is no route to this transition and no actor a caller could name** —
 * `VARIATION_TRANSITIONS` gives both of its edges the actor `SYSTEM`, and this
 * function is that actor. A `PATCH /v1/variations/:id/status` that could set
 * `INVOICED` would let somebody mark a variation billed without an invoice
 * existing, which `variations_invoiced_pairing` refuses at the database anyway;
 * doing it here means the status and the `invoice_id` are one write.
 *
 * Conditional on the source state for the reason every other transition is: two
 * invoices racing lose the race in the `for update` above, and this is the second
 * lock on the same door.
 */
async function markVariationsInvoiced(
  invoiceId: string,
  items: readonly DerivedItem[],
  runner: Queryable
): Promise<void> {
  const ids = items.filter((i) => i.sourceType === 'VARIATION').map((i) => i.sourceId);
  if (ids.length === 0) return;
  await query(
    `update variations set status = 'INVOICED', invoice_id = $2, updated_at = now()
      where id = any($1::uuid[]) and status in ('APPROVED','COMPLETED')`,
    [ids, invoiceId],
    runner
  );
}

/**
 * And the reverse, when an invoice is voided.
 *
 * §3.5's rule for a time log — *"voided sources become eligible again"* — with a
 * variation as the noun. The `invoice_items` row is deliberately left standing: a
 * void is a record of a document that existed, not an erasure of it, and the
 * `not exists` guard in `loadDerivedItems` filters on `i.status <> 'VOID'` rather
 * than on the row's absence for exactly this reason.
 *
 * `COMPLETED` is **not** restored, and that is not a loss: the state a variation
 * returns to is `APPROVED`, which is the state the transition table declares
 * (`INVOICED → APPROVED`), and whether the works were finished is a fact somebody
 * re-asserts rather than one a void should infer.
 */
async function restoreVoidedVariations(invoiceId: string, runner: Queryable): Promise<void> {
  await query(
    `update variations set status = 'APPROVED', invoice_id = null, updated_at = now()
      where invoice_id = $1 and status = 'INVOICED'`,
    [invoiceId],
    runner
  );
}

export async function createProjectInvoice(
  issuerCompanyId: string,
  input: CreateInvoice
): Promise<InvoiceView> {
  return withTransaction(async (runner) => {
    await query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`invoice-project:${input.projectId}`], runner);
    const project = await getProject(issuerCompanyId, input.projectId, runner);
    if (!project || !project.clientCompanyId || !project.engagementId) {
      throw new AppError('VALIDATION', 'Project must be linked to a client before it can be invoiced');
    }
    const edge = await findEngagementEdge(project.engagementId, runner);
    if (!edge || edge.provider_company_id !== issuerCompanyId ||
        edge.client_company_id !== project.clientCompanyId) {
      throw new AppError('VALIDATION', 'Project client engagement is inconsistent');
    }
    const company = await findCompanyById(issuerCompanyId, runner);
    if (!company) throw new AppError('NOT_FOUND', 'Company not found');

    // Payment terms agreed on the engagement default the due date. Terms that never
    // reach an invoice are a text field, not terms — so the edge's agreed days are
    // applied whenever the caller did not name a date itself.
    const terms = await getEngagementTerms(edge.id, runner);
    const dueAt =
      input.dueAt ?? dueDateFromPaymentTerms(new Date().toISOString(), terms?.paymentTermsDays ?? null);

    const invoiceId = await insertInvoice({
      engagementId: edge.id,
      issuerCompanyId,
      counterpartyCompanyId: project.clientCompanyId,
      projectId: project.id,
      // No currency: it is read back from the project's snapshot on every select.
      // The company column is live and an owner may change it, so the invoice, the
      // project summary and the client portal all read the one snapshot rather than
      // three copies that could disagree.
      dueAt,
      taxCents: input.taxCents,
    }, runner);
    if (input.includeApprovedWork) {
      const items = await loadDerivedItems({
        projectId: project.id,
        ownerCompanyId: issuerCompanyId,
        clientCompanyId: project.clientCompanyId,
        invoiceCurrency: project.reportingCurrency,
        runner,
      });
      await insertDerivedItems(invoiceId, items, runner);
      await recalculateInvoiceTotals(invoiceId, runner);
    }
    return (await getInvoice(invoiceId, runner))!;
  });
}

export async function addInvoiceItem(invoice: InvoiceView, input: CreateInvoiceItem) {
  return withTransaction(async (runner) => {
    await lockDraft(invoice.id, runner);
    if (!invoice.projectId) throw new AppError('VALIDATION', 'Invoice has no project');
    await query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`invoice-project:${invoice.projectId}`], runner);
    if (input.sourceType === 'MANUAL') {
      await insertInvoiceItem({
        invoiceId: invoice.id,
        description: input.description,
        quantity: input.quantity,
        unitAmountCents: input.unitAmountCents,
        sourceType: 'MANUAL',
        sourceId: null,
      }, runner);
    } else {
      const items = await loadDerivedItems({
        projectId: invoice.projectId,
        ownerCompanyId: invoice.issuerCompanyId,
        clientCompanyId: invoice.counterpartyCompanyId,
        invoiceCurrency: invoice.currency,
        only: input,
        runner,
      });
      await insertDerivedItems(invoice.id, items, runner);
    }
    await recalculateInvoiceTotals(invoice.id, runner);
    return (await getInvoice(invoice.id, runner))!;
  });
}

/** Pull newly approved, still-unbilled work into an existing draft. */
export async function importApprovedInvoiceItems(invoice: InvoiceView) {
  return withTransaction(async (runner) => {
    await lockDraft(invoice.id, runner);
    if (!invoice.projectId) throw new AppError('VALIDATION', 'Invoice has no project');
    await query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`invoice-project:${invoice.projectId}`], runner);
    const items = await loadDerivedItems({
      projectId: invoice.projectId,
      ownerCompanyId: invoice.issuerCompanyId,
      clientCompanyId: invoice.counterpartyCompanyId,
      invoiceCurrency: invoice.currency,
      runner,
    });
    await insertDerivedItems(invoice.id, items, runner);
    await recalculateInvoiceTotals(invoice.id, runner);
    return (await getInvoice(invoice.id, runner))!;
  });
}

async function lockDraft(id: string, runner: Queryable) {
  const row = await queryOne(
    `select 1 from invoices where id = $1 and status = 'DRAFT' for update`, [id], runner
  );
  if (!row) throw new AppError('CONFLICT', 'Only a draft invoice can be edited');
}

export async function editInvoice(invoiceId: string, patch: UpdateInvoice) {
  return withTransaction(async (runner) => {
    await updateInvoiceDraft(invoiceId, patch, runner);
    return (await getInvoice(invoiceId, runner))!;
  });
}

export async function editInvoiceItem(
  invoiceId: string,
  itemId: string,
  patch: UpdateInvoiceItem
) {
  return withTransaction(async (runner) => {
    await lockDraft(invoiceId, runner);
    await updateManualItem(invoiceId, itemId, patch, runner);
    await recalculateInvoiceTotals(invoiceId, runner);
    return (await getInvoice(invoiceId, runner))!;
  });
}

export async function removeInvoiceItem(invoiceId: string, itemId: string) {
  return withTransaction(async (runner) => {
    await lockDraft(invoiceId, runner);
    await deleteInvoiceItem(invoiceId, itemId, runner);
    await recalculateInvoiceTotals(invoiceId, runner);
    return (await getInvoice(invoiceId, runner))!;
  });
}

export async function removeInvoice(invoiceId: string) {
  return withTransaction((runner) => deleteInvoice(invoiceId, runner));
}

/**
 * Issue a draft.
 *
 * This is where the engagement's purchase-order ceiling is enforced: issue is the
 * point the amount becomes a claim on the PO, and a ceiling nobody checks is
 * decoration. Drafts are excluded from the committed total on purpose — see
 * `listCommittedInvoiceCents`.
 */
export async function issueDraftInvoice(invoiceId: string) {
  return withTransaction(async (runner) => {
    const invoice = await getInvoice(invoiceId, runner);
    if (!invoice) throw new AppError('NOT_FOUND', 'Invoice not found');

    // Serialize against other issues on the same edge, so two invoices cannot each
    // read a committed total that excludes the other and both slip under the cap.
    await query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`invoice-ceiling:${invoice.engagementId}`], runner);

    const terms = await getEngagementTerms(invoice.engagementId, runner);
    const refusal = purchaseOrderCeilingRefusal({
      ceilingCents: terms?.purchaseOrderCeilingCents ?? null,
      committedCents: await listCommittedInvoiceCents(invoice.engagementId, runner),
      incomingCents: invoice.totalCents,
      currency: invoice.currency,
    });
    if (refusal) {
      throw new AppError('VALIDATION', refusal, {
        purchaseOrderReference: terms?.purchaseOrderReference ?? null,
        purchaseOrderCeilingCents: terms?.purchaseOrderCeilingCents ?? null,
      });
    }

    await issueInvoice(invoiceId, runner);
    return (await getInvoice(invoiceId, runner))!;
  });
}

export async function markInvoicePaid(invoiceId: string) {
  return withTransaction(async (runner) => {
    await transitionInvoice(invoiceId, 'ISSUED', 'PAID', runner);
    return (await getInvoice(invoiceId, runner))!;
  });
}

export async function voidIssuedInvoice(invoiceId: string) {
  return withTransaction(async (runner) => {
    await transitionInvoice(invoiceId, 'ISSUED', 'VOID', runner);
    // Same transaction as the void, so a variation is never left INVOICED against a
    // document that no longer claims it.
    await restoreVoidedVariations(invoiceId, runner);
    return (await getInvoice(invoiceId, runner))!;
  });
}
