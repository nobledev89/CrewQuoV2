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

async function loadDerivedItems(args: {
  projectId: string;
  ownerCompanyId: string;
  clientCompanyId: string;
  /** The unit this invoice is denominated in — the project's reporting currency. */
  invoiceCurrency: string;
  only?: { sourceType: 'TIME_LOG' | 'EXPENSE'; sourceId: string };
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

  if (args.only && logs.length + expenses.length === 0) {
    throw new AppError(
      'CONFLICT',
      'Source is not approved work on this project, or it is already invoiced'
    );
  }

  const labelRules = await getEffectiveTimeframeDefinitions(args.ownerCompanyId, args.runner);
  const items: DerivedItem[] = [];
  const missingRateIds: string[] = [];
  const unlikeCurrencies = new Set<string>();
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
    // A BILL card may declare its own unit since 0009. The rate IS what the
    // client is charged, so an unlike one is refused rather than converted:
    // converting would bill them a number nobody agreed, at a rate only the
    // owner has seen. §3.3 decision #5, money-boundary packet §4.
    const billCurrency = bill.currency ?? args.invoiceCurrency;
    if (billCurrency !== args.invoiceCurrency) {
      unlikeCurrencies.add(billCurrency);
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
  if (unlikeCurrencies.size > 0) {
    throw new AppError(
      'VALIDATION',
      `This project is invoiced in ${args.invoiceCurrency}, but a BILL rate for some ` +
        `approved time is in ${[...unlikeCurrencies].sort().join(', ')}. An agreed ` +
        `charge-out rate is what the client owes, so CrewQuo will not convert it. ` +
        `Agree the rate in ${args.invoiceCurrency}, or invoice this work separately.`,
      { currencies: [...unlikeCurrencies].sort() }
    );
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
  return items;
}

async function insertDerivedItems(invoiceId: string, items: DerivedItem[], runner: Queryable) {
  for (const item of items) await insertInvoiceItem({ invoiceId, ...item }, runner);
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
      // The *project's* unit, not `company.currency`. The company column is live
      // and an owner may change it; an invoice, its project summary and the
      // client portal must never disagree about what unit a figure is in.
      currency: project.reportingCurrency,
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
    return (await getInvoice(invoiceId, runner))!;
  });
}
