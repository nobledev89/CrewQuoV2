import type {
  InvoiceItemView,
  InvoiceSourceType,
  InvoiceStatus,
  InvoiceView,
  UpdateInvoice,
  UpdateInvoiceItem,
} from '@crewquo/shared';
import { calculateInvoiceItemAmount } from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';
import { AppError } from '../../http/errors';

interface InvoiceRow {
  id: string;
  engagement_id: string;
  issuer_company_id: string;
  issuer_company_name: string;
  counterparty_company_id: string;
  counterparty_company_name: string;
  project_id: string | null;
  project_name: string | null;
  number: string | null;
  status: InvoiceStatus;
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  issued_at: Date | null;
  due_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface InvoiceItemRow {
  id: string;
  invoice_id: string;
  description: string;
  quantity: string;
  unit_amount_cents: number;
  amount_cents: number;
  source_type: InvoiceSourceType;
  source_id: string | null;
  created_at: Date;
}

const INVOICE_SELECT = `
  select i.id, i.engagement_id, i.issuer_company_id, issuer.name as issuer_company_name,
         i.counterparty_company_id, counterparty.name as counterparty_company_name,
         i.project_id, p.name as project_name, i.number, i.status,
         -- The project's snapshot is the label. An invoice no longer stores its
         -- own: it could only ever have been a copy of this.
         p.reporting_currency as currency,
         i.subtotal_cents, i.tax_cents, i.total_cents, i.issued_at, i.due_at,
         i.created_at, i.updated_at
    from invoices i
    join companies issuer on issuer.id = i.issuer_company_id
    join companies counterparty on counterparty.id = i.counterparty_company_id
    left join projects p on p.id = i.project_id`;

const ITEM_SELECT = `id, invoice_id, description, quantity, unit_amount_cents, amount_cents,
  source_type, source_id, created_at`;

function toItem(row: InvoiceItemRow): InvoiceItemView {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    description: row.description,
    quantity: Number(row.quantity),
    unitAmountCents: row.unit_amount_cents,
    amountCents: row.amount_cents,
    sourceType: row.source_type,
    sourceId: row.source_id,
    createdAt: row.created_at.toISOString(),
  };
}

function toView(row: InvoiceRow, items: InvoiceItemView[]): InvoiceView {
  return {
    id: row.id,
    engagementId: row.engagement_id,
    issuerCompanyId: row.issuer_company_id,
    issuerCompanyName: row.issuer_company_name,
    counterpartyCompanyId: row.counterparty_company_id,
    counterpartyCompanyName: row.counterparty_company_name,
    projectId: row.project_id,
    projectName: row.project_name,
    number: row.number,
    status: row.status,
    currency: row.currency,
    subtotalCents: row.subtotal_cents,
    taxCents: row.tax_cents,
    totalCents: row.total_cents,
    issuedAt: row.issued_at?.toISOString() ?? null,
    dueAt: row.due_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    items,
  };
}

export async function listInvoices(companyId: string): Promise<InvoiceView[]> {
  const rows = await query<InvoiceRow>(
    `${INVOICE_SELECT}
      where i.issuer_company_id = $1
         or (i.counterparty_company_id = $1 and i.status <> 'DRAFT')
      order by i.created_at desc`,
    [companyId]
  );
  if (rows.length === 0) return [];
  const itemRows = await query<InvoiceItemRow>(
    `select ${ITEM_SELECT} from invoice_items where invoice_id = any($1::uuid[])
      order by created_at, id`,
    [rows.map((row) => row.id)]
  );
  const byInvoice = new Map<string, InvoiceItemView[]>();
  for (const row of itemRows) {
    const items = byInvoice.get(row.invoice_id) ?? [];
    items.push(toItem(row));
    byInvoice.set(row.invoice_id, items);
  }
  return rows.map((row) => toView(row, byInvoice.get(row.id) ?? []));
}

export async function getInvoice(id: string, runner?: Queryable): Promise<InvoiceView | null> {
  const row = await queryOne<InvoiceRow>(`${INVOICE_SELECT} where i.id = $1`, [id], runner);
  if (!row) return null;
  const items = await query<InvoiceItemRow>(
    `select ${ITEM_SELECT} from invoice_items where invoice_id = $1 order by created_at, id`,
    [id],
    runner
  );
  return toView(row, items.map(toItem));
}

export async function insertInvoice(input: {
  engagementId: string;
  issuerCompanyId: string;
  counterpartyCompanyId: string;
  projectId: string;
  dueAt: string | null;
  taxCents: number;
}, runner: Queryable): Promise<string> {
  // No `currency`: the label is the project's snapshot, read back on every select.
  const row = await queryOne<{ id: string }>(
    `insert into invoices (engagement_id, issuer_company_id, counterparty_company_id,
                           project_id, due_at, tax_cents, total_cents)
     values ($1,$2,$3,$4,$5,$6,$6) returning id`,
    [input.engagementId, input.issuerCompanyId, input.counterpartyCompanyId, input.projectId,
      input.dueAt, input.taxCents],
    runner
  );
  return row!.id;
}

export async function insertInvoiceItem(input: {
  invoiceId: string;
  description: string;
  quantity: number;
  unitAmountCents: number;
  sourceType: InvoiceSourceType;
  sourceId: string | null;
}, runner: Queryable): Promise<string> {
  const amount = calculateInvoiceItemAmount(input.quantity, input.unitAmountCents);
  const row = await queryOne<{ id: string }>(
    `insert into invoice_items (invoice_id, description, quantity, unit_amount_cents,
                                amount_cents, source_type, source_id)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [input.invoiceId, input.description, input.quantity, input.unitAmountCents, amount,
      input.sourceType, input.sourceId],
    runner
  );
  return row!.id;
}

export async function recalculateInvoiceTotals(id: string, runner: Queryable): Promise<void> {
  await query(
    `update invoices i set
       subtotal_cents = totals.subtotal,
       total_cents = totals.subtotal + i.tax_cents,
       updated_at = now()
     from (select coalesce(sum(amount_cents), 0)::integer as subtotal
             from invoice_items where invoice_id = $1) totals
     where i.id = $1`,
    [id],
    runner
  );
}

export async function updateInvoiceDraft(
  id: string,
  patch: UpdateInvoice,
  runner: Queryable
): Promise<void> {
  const row = await queryOne(
    `update invoices set
       due_at = case when $2::boolean then $3::timestamptz else due_at end,
       tax_cents = coalesce($4, tax_cents),
       total_cents = subtotal_cents + coalesce($4, tax_cents), updated_at = now()
     where id = $1 and status = 'DRAFT' returning id`,
    [id, 'dueAt' in patch, patch.dueAt ?? null, patch.taxCents ?? null],
    runner
  );
  if (!row) throw new AppError('CONFLICT', 'Only a draft invoice can be edited');
}

export async function updateManualItem(
  invoiceId: string,
  itemId: string,
  patch: UpdateInvoiceItem,
  runner: Queryable
): Promise<void> {
  const row = await queryOne<{ quantity: string; unit_amount_cents: number }>(
    `select quantity, unit_amount_cents from invoice_items
      where id = $1 and invoice_id = $2 and source_type = 'MANUAL' for update`,
    [itemId, invoiceId],
    runner
  );
  if (!row) throw new AppError('NOT_FOUND', 'Editable invoice item not found');
  const nextQuantity = patch.quantity ?? Number(row.quantity);
  const nextUnit = patch.unitAmountCents ?? row.unit_amount_cents;
  await query(
    `update invoice_items set description = coalesce($3, description), quantity = $4,
       unit_amount_cents = $5, amount_cents = $6 where id = $1 and invoice_id = $2`,
    [itemId, invoiceId, patch.description ?? null, nextQuantity, nextUnit,
      calculateInvoiceItemAmount(nextQuantity, nextUnit)],
    runner
  );
}

export async function deleteInvoiceItem(invoiceId: string, itemId: string, runner: Queryable) {
  const row = await queryOne(
    `delete from invoice_items where id = $1 and invoice_id = $2 returning id`,
    [itemId, invoiceId],
    runner
  );
  if (!row) throw new AppError('NOT_FOUND', 'Invoice item not found');
}

export async function deleteInvoice(id: string, runner: Queryable): Promise<void> {
  const row = await queryOne(
    `delete from invoices where id = $1 and status = 'DRAFT' returning id`,
    [id],
    runner
  );
  if (!row) throw new AppError('CONFLICT', 'Only a draft invoice can be deleted');
}

export async function issueInvoice(id: string, runner: Queryable): Promise<void> {
  const invoice = await queryOne<{ issuer_company_id: string }>(
    `select issuer_company_id from invoices where id = $1 and status = 'DRAFT' for update`,
    [id],
    runner
  );
  if (!invoice) throw new AppError('CONFLICT', 'Only a draft invoice can be issued');
  const hasItem = await queryOne(`select 1 from invoice_items where invoice_id = $1 limit 1`, [id], runner);
  if (!hasItem) throw new AppError('VALIDATION', 'An invoice needs at least one item');

  await query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`invoice-number:${invoice.issuer_company_id}`], runner);
  const next = await queryOne<{ value: number; year: number }>(
    `select count(*)::integer + 1 as value, extract(year from now())::integer as year from invoices
      where issuer_company_id = $1 and issued_at >= date_trunc('year', now())`,
    [invoice.issuer_company_id], runner
  );
  const number = `CQ-${next!.year}-${String(next!.value).padStart(6, '0')}`;
  await query(
    `update invoices set status = 'ISSUED', number = $2, issued_at = now(), updated_at = now()
      where id = $1`,
    [id, number],
    runner
  );
}

export async function transitionInvoice(
  id: string,
  from: InvoiceStatus,
  to: 'PAID' | 'VOID',
  runner: Queryable
): Promise<void> {
  const row = await queryOne(
    `update invoices set status = $3, updated_at = now()
      where id = $1 and status = $2 returning id`,
    [id, from, to], runner
  );
  if (!row) throw new AppError('CONFLICT', `Invoice cannot transition to ${to}`);
}
