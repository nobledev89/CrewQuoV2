'use client';

import { useEffect, useMemo, useState } from 'react';
import type { InvoiceView, ProjectView } from '@crewquo/shared';
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Notice,
  PageHeader,
  Row,
  Section,
  Select,
  Stack,
  Table,
} from '@crewquo/ui';
import { api, ApiError } from '@/api/client';
import { useAuth, useSessionCtx } from '@/auth/AuthProvider';
import { FeatureNotice } from '@/components/FeatureLock';
import { Shell } from '@/components/Shell';
import { formatCents, formatDate, formatDateTime } from '@/lib/format';
import { useAsyncList } from '@/lib/useAsyncList';
import { useEntitlements } from '@/lib/useEntitlements';

export default function InvoicesPage() {
  return <Shell><Invoices /></Shell>;
}

function Invoices() {
  const ctx = useSessionCtx();
  const { activeMembership } = useAuth();
  const ent = useEntitlements();
  const list = useAsyncList<InvoiceView>(
    ctx ? () => api.listInvoices(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );
  const projects = useAsyncList<ProjectView>(
    ctx ? () => api.listProjects(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<InvoiceView | null>(null);
  const [creating, setCreating] = useState(false);

  const selected = useMemo(
    () => selectedSnapshot ?? list.items.find((invoice) => invoice.id === selectedId) ?? null,
    [list.items, selectedId, selectedSnapshot]
  );
  useEffect(() => {
    if (!selectedId) return;
    const fresh = list.items.find((invoice) => invoice.id === selectedId);
    if (fresh) setSelectedSnapshot(fresh);
  }, [list.items, selectedId]);

  const canManage = activeMembership ? activeMembership.role !== 'MEMBER' : false;
  const clientProjects = projects.items.filter((p) => p.clientCompanyId && p.engagementId);

  function accept(invoice: InvoiceView) {
    setSelectedId(invoice.id);
    setSelectedSnapshot(invoice);
    list.reload();
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Commercial"
        title="Invoices"
        description="Turn approved work into a frozen client invoice. Work-backed amounts always come from the same BILL-rate path as the project summary."
        actions={canManage && ent.has('invoicing') && !creating ? (
          <Button size="sm" onClick={() => setCreating(true)}>New invoice</Button>
        ) : null}
      />

      {!ent.loading && canManage && !ent.has('invoicing') ? <FeatureNotice feature="invoicing" /> : null}
      {creating ? (
        <NewInvoice
          projects={clientProjects}
          onCancel={() => setCreating(false)}
          onCreated={(invoice) => { setCreating(false); accept(invoice); }}
        />
      ) : null}

      <Section className="cq-section--table">
        <ErrorText>{list.error}</ErrorText>
        {list.loading ? <p className="cq-muted">Loading invoices…</p> : list.items.length === 0 ? (
          <EmptyState title="No invoices yet">
            Issuer-side drafts and invoices issued to this company will appear here.
          </EmptyState>
        ) : (
          <Table label="Invoices">
            <thead><tr><th>Number</th><th>Project</th><th>Counterparty</th><th>Status</th><th>Total</th><th>Issued</th></tr></thead>
            <tbody>{list.items.map((invoice) => (
              <tr key={invoice.id}>
                <td className="cq-table__primary">
                  <button className="cq-link-button" onClick={() => { setSelectedId(invoice.id); setSelectedSnapshot(invoice); }}>
                    {invoice.number ?? 'Draft'}
                  </button>
                </td>
                <td>{invoice.projectName ?? '—'}</td>
                <td>{invoice.issuerCompanyId === ctx?.companyId ? invoice.counterpartyCompanyName : invoice.issuerCompanyName}</td>
                <td><InvoiceBadge invoice={invoice} /></td>
                <td className="cq-numeric">{formatCents(invoice.totalCents, invoice.currency)}</td>
                <td>{invoice.issuedAt ? formatDateTime(invoice.issuedAt) : <span className="cq-muted">Not issued</span>}</td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Section>

      {selected ? (
        <InvoiceDetail
          invoice={selected}
          editable={selected.issuerCompanyId === ctx?.companyId && canManage && ent.has('invoicing')}
          onChange={accept}
          onDeleted={() => { setSelectedId(null); setSelectedSnapshot(null); list.reload(); }}
        />
      ) : null}
    </Stack>
  );
}

function InvoiceBadge({ invoice }: { invoice: InvoiceView }) {
  const tone = invoice.status === 'PAID' ? 'success' : invoice.status === 'ISSUED' ? 'accent' : invoice.status === 'VOID' ? 'warning' : 'neutral';
  return <Badge tone={tone}>{invoice.status.charAt(0) + invoice.status.slice(1).toLowerCase()}</Badge>;
}

function NewInvoice({ projects, onCancel, onCreated }: {
  projects: ProjectView[];
  onCancel: () => void;
  onCreated: (invoice: InvoiceView) => void;
}) {
  const ctx = useSessionCtx();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [dueOn, setDueOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx) return;
    setBusy(true); setError(null);
    try {
      const { invoice } = await api.createInvoice(ctx.accessToken, ctx.companyId, {
        projectId,
        dueAt: dueOn ? new Date(`${dueOn}T23:59:59`).toISOString() : null,
        taxCents: 0,
        includeApprovedWork: true,
      });
      onCreated(invoice);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the invoice');
    } finally { setBusy(false); }
  }

  return (
    <Section title="New invoice" description="Approved, not-yet-invoiced time and expenses are snapshotted automatically. Missing BILL rates stop the draft instead of silently billing zero.">
      {projects.length === 0 ? <EmptyState title="No client projects">Link a project to a client before invoicing it.</EmptyState> : (
        <form onSubmit={submit} className="cq-stack" aria-busy={busy}>
          <div className="cq-form-grid">
            <Field label="Project"><Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.clientCompanyName}</option>)}
            </Select></Field>
            <Field label="Due on"><Input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></Field>
          </div>
          <ErrorText>{error}</ErrorText>
          <Row><Button type="submit" disabled={busy || !projectId}>{busy ? 'Creating…' : 'Create from approved work'}</Button><Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button></Row>
        </form>
      )}
    </Section>
  );
}

function InvoiceDetail({ invoice, editable, onChange, onDeleted }: {
  invoice: InvoiceView;
  editable: boolean;
  onChange: (invoice: InvoiceView) => void;
  onDeleted: () => void;
}) {
  const ctx = useSessionCtx();
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitAmount, setUnitAmount] = useState('');
  const [tax, setTax] = useState((invoice.taxCents / 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDraft = invoice.status === 'DRAFT';

  useEffect(() => setTax((invoice.taxCents / 100).toFixed(2)), [invoice.id, invoice.taxCents]);

  async function act(fn: () => Promise<{ invoice: InvoiceView }>) {
    setBusy(true); setError(null);
    try { onChange((await fn()).invoice); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Invoice action failed'); }
    finally { setBusy(false); }
  }

  if (!ctx) return null;
  return (
    <Section
      title={invoice.number ?? `Draft · ${invoice.projectName ?? 'Invoice'}`}
      description={`${invoice.issuerCompanyName} bills ${invoice.counterpartyCompanyName}${invoice.dueAt ? ` · due ${formatDate(invoice.dueAt.slice(0, 10))}` : ''}`}
      actions={<InvoiceBadge invoice={invoice} />}
    >
      <Stack>
        <Table label="Invoice items">
          <thead><tr><th>Description</th><th>Source</th><th>Quantity</th><th>Unit</th><th>Amount</th><th /></tr></thead>
          <tbody>{invoice.items.map((item) => (
            <tr key={item.id}>
              <td className="cq-table__primary">{item.description}</td><td>{item.sourceType.replace('_', ' ')}</td>
              <td className="cq-numeric">{item.quantity}</td><td className="cq-numeric">{formatCents(item.unitAmountCents, invoice.currency)}</td>
              <td className="cq-numeric">{formatCents(item.amountCents, invoice.currency)}</td>
              <td>{editable && isDraft ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(() => api.deleteInvoiceItem(ctx.accessToken, ctx.companyId, invoice.id, item.id))}>Remove</Button> : null}</td>
            </tr>
          ))}</tbody>
        </Table>

        <div className="cq-metric-grid">
          <div className="cq-metric"><div className="cq-metric__label">Subtotal</div><div className="cq-metric__value">{formatCents(invoice.subtotalCents, invoice.currency)}</div></div>
          <div className="cq-metric"><div className="cq-metric__label">Tax</div><div className="cq-metric__value">{formatCents(invoice.taxCents, invoice.currency)}</div></div>
          <div className="cq-metric"><div className="cq-metric__label">Total</div><div className="cq-metric__value">{formatCents(invoice.totalCents, invoice.currency)}</div></div>
        </div>

        {editable && isDraft ? <>
          <Notice>Work-backed lines are read-only snapshots. Remove and re-add a source if it needs to be rebuilt; only manual lines accept client-entered amounts.</Notice>
          <form className="cq-stack" onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.addInvoiceItem(ctx.accessToken, ctx.companyId, invoice.id, {
              sourceType: 'MANUAL', description: description.trim(), quantity: Number(quantity), unitAmountCents: Math.round(Number(unitAmount) * 100),
            })).then(() => { setDescription(''); setQuantity('1'); setUnitAmount(''); });
          }}>
            <div className="cq-form-grid">
              <Field label="Manual line"><Input value={description} onChange={(e) => setDescription(e.target.value)} required /></Field>
              <Field label="Quantity"><Input type="number" min="0.01" step="0.01" value={quantity} onChange={(e) => setQuantity(e.target.value)} required /></Field>
              <Field label={`Unit amount (${invoice.currency})`}><Input type="number" min="0" step="0.01" value={unitAmount} onChange={(e) => setUnitAmount(e.target.value)} required /></Field>
            </div>
            <Row>
              <Button type="submit" size="sm" disabled={busy || !description.trim()}>Add manual line</Button>
              <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void act(() => api.importApprovedInvoiceItems(ctx.accessToken, ctx.companyId, invoice.id))}>Add newly approved work</Button>
            </Row>
          </form>
          <Row between>
            <Row>
              <Field label={`Tax (${invoice.currency})`}><Input type="number" min="0" step="0.01" value={tax} onChange={(e) => setTax(e.target.value)} /></Field>
              <Button variant="secondary" disabled={busy} onClick={() => void act(() => api.updateInvoice(ctx.accessToken, ctx.companyId, invoice.id, { taxCents: Math.round(Number(tax) * 100) }))}>Save tax</Button>
            </Row>
            <Row>
              <Button disabled={busy || invoice.items.length === 0} onClick={() => {
                if (window.confirm('Issue this invoice? Its lines and totals cannot be edited afterward.')) void act(() => api.issueInvoice(ctx.accessToken, ctx.companyId, invoice.id));
              }}>Issue invoice</Button>
              <Button variant="danger" disabled={busy} onClick={async () => {
                if (!window.confirm('Delete this draft invoice?')) return;
                setBusy(true); setError(null);
                try { await api.deleteInvoice(ctx.accessToken, ctx.companyId, invoice.id); onDeleted(); }
                catch (err) { setError(err instanceof ApiError ? err.message : 'Could not delete invoice'); }
                finally { setBusy(false); }
              }}>Delete draft</Button>
            </Row>
          </Row>
        </> : null}

        {editable && invoice.status === 'ISSUED' ? <Row>
          <Button disabled={busy} onClick={() => void act(() => api.markInvoicePaid(ctx.accessToken, ctx.companyId, invoice.id))}>Mark paid</Button>
          <Button variant="danger" disabled={busy} onClick={() => {
            if (window.confirm('Void this invoice? Approved work can then be invoiced again.')) void act(() => api.voidInvoice(ctx.accessToken, ctx.companyId, invoice.id));
          }}>Void invoice</Button>
        </Row> : null}
        <ErrorText>{error}</ErrorText>
      </Stack>
    </Section>
  );
}
