'use client';

import { useMemo, useState } from 'react';
import type {
  ClientPeriodSnapshot,
  ClientView,
  GeneratedReportDetail,
  GeneratedReportView,
} from '@crewquo/shared';
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
import { Shell } from '@/components/Shell';
import { FeatureLocked } from '@/components/FeatureLock';
import { api, ApiError, refusedFeature } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useCapabilities } from '@/lib/useCapabilities';
import { useEntitlements } from '@/lib/useEntitlements';
import { useAsyncData } from '@/lib/useAsyncData';
import { formatDate, formatDateTime } from '@/lib/format';
import { formatCarbonKg, formatMassKg, formatRate } from '@crewquo/shared';

function yearRange(year: number) { return { from: `${year}-01-01`, to: `${year}-12-31` }; }
function quarterRange(year: number, quarter: number) {
  const month = (quarter - 1) * 3;
  const from = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const toDate = new Date(Date.UTC(year, month + 3, 0));
  return { from, to: toDate.toISOString().slice(0, 10) };
}

export default function ClientReportingPage() {
  return <Shell><ClientReporting /></Shell>;
}

function ClientReporting() {
  const ctx = useSessionCtx();
  const ent = useEntitlements();
  const caps = useCapabilities();
  const currentYear = new Date().getFullYear();
  const initial = useMemo(() => yearRange(currentYear), [currentYear]);
  const [clientId, setClientId] = useState('');
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<GeneratedReportDetail | null>(null);

  const clients = useAsyncData<ClientView[]>(
    ctx ? () => api.listClients(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );
  const reports = useAsyncData<GeneratedReportView[]>(
    ctx ? () => api.listClientPeriodReports(ctx.accessToken, ctx.companyId).then((r) => r.reports) : null,
    [ctx?.companyId]
  );

  if (!ent.loading && !ent.has('client_reporting')) return <FeatureLocked feature="client_reporting" />;
  if (!caps.loading && (!caps.can('report.generate') || !caps.can('sustainability.read'))) {
    return <Stack><PageHeader eyebrow="Reports" title="Client reporting" /><Notice>Your job function needs report generation and sustainability access.</Notice></Stack>;
  }
  const locked = refusedFeature(clients.error ?? reports.error);
  if (locked === 'client_reporting') return <FeatureLocked feature="client_reporting" />;

  async function generate() {
    if (!ctx || !clientId) return;
    setBusy(true); setError(null);
    try {
      const result = await api.generateClientPeriodReport(ctx.accessToken, ctx.companyId, {
        audience: 'CLIENT', clientCompanyId: clientId, periodStart: from, periodEnd: to,
        sections: ['PERIOD_SUMMARY','PERIOD_PROJECTS','PERIOD_MATERIALS','PERIOD_CARBON'],
      });
      const loaded = await api.reportDetail(ctx.accessToken, ctx.companyId, result.report.id);
      setDetail(loaded); reports.reload();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not generate that client report'); }
    finally { setBusy(false); }
  }

  async function selectReport(report: GeneratedReportView) {
    if (!ctx) return;
    setBusy(true); setError(null);
    try { setDetail(await api.reportDetail(ctx.accessToken, ctx.companyId, report.id)); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not open that report'); }
    finally { setBusy(false); }
  }

  async function download(report: GeneratedReportView) {
    if (!ctx) return;
    try {
      const blob = await api.downloadReport(ctx.accessToken, ctx.companyId, report.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${report.title}.pdf`; anchor.click(); URL.revokeObjectURL(url);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not download that report'); }
  }

  async function share(report: GeneratedReportView) {
    if (!ctx) return;
    setBusy(true); setError(null);
    try { await api.setReportVisibility(ctx.accessToken, ctx.companyId, report.id, !report.clientVisible); reports.reload(); if (detail?.report.id === report.id) setDetail(await api.reportDetail(ctx.accessToken, ctx.companyId, report.id)); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not change client visibility'); }
    finally { setBusy(false); }
  }

  const body = detail?.snapshot.body.kind === 'CLIENT_PERIOD' ? detail.snapshot.body as ClientPeriodSnapshot : null;
  return <Stack>
    <PageHeader eyebrow="Reports" title="Client reporting" description="Quarterly and annual sustainability roll-ups built from the same project metrics, then frozen for reproducible download." />
    <ErrorText>{error ?? clients.error ?? reports.error}</ErrorText>
    <Section title="New client period" description="Projects that overlap the dates are included. Placeholder identities already claimed by this client are followed automatically.">
      <div className="cq-form-grid">
        <Field label="Client"><Select value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">Choose a client</option>{clients.data?.map((client) => <option key={client.clientCompanyId} value={client.clientCompanyId}>{client.name}</option>)}</Select></Field>
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <Row>
        <Button variant="secondary" size="sm" onClick={() => { const r = yearRange(currentYear); setFrom(r.from); setTo(r.to); }}>This year</Button>
        {[1,2,3,4].map((quarter) => <Button key={quarter} variant="secondary" size="sm" onClick={() => { const r = quarterRange(currentYear, quarter); setFrom(r.from); setTo(r.to); }}>Q{quarter}</Button>)}
        <Button disabled={busy || !clientId || !from || !to || to < from} onClick={() => void generate()}>{busy ? 'Generating…' : 'Generate frozen report'}</Button>
      </Row>
    </Section>

    {body && detail ? <Section title={detail.report.title} description={`${formatDate(detail.report.periodStart)} – ${formatDate(detail.report.periodEnd)}`}>
      {body.mixedFactorYears ? <Notice><strong>Mixed factor years:</strong> {body.factorYears.join(', ')}. Figures from different factor sets are disclosed together and should not be read as like-for-like.</Notice> : null}
      <div className="cq-metrics">
        <div className="cq-metric"><span className="cq-overline">Projects</span><div className="cq-metric__value">{body.projectCount}</div></div>
        <div className="cq-metric"><span className="cq-overline">Material managed</span><div className="cq-metric__value">{formatMassKg(body.totalMassKg, detail.snapshot.meta.display.massUnit)}</div></div>
        <div className="cq-metric"><span className="cq-overline">Diversion</span><div className="cq-metric__value">{body.rates.diversionPct === null ? '—' : formatRate(body.rates.diversionPct / 100)}</div></div>
        <div className="cq-metric"><span className="cq-overline">Retained in use</span><div className="cq-metric__value">{body.rates.retainedInUsePct === null ? '—' : formatRate(body.rates.retainedInUsePct / 100)}</div></div>
        <div className="cq-metric"><span className="cq-overline">Project emissions</span><div className="cq-metric__value">{body.carbon.projectEmissionsKgCo2e === null ? '—' : formatCarbonKg(body.carbon.projectEmissionsKgCo2e, detail.snapshot.meta.display.carbonUnit)}</div></div>
        <div className="cq-metric"><span className="cq-overline">Estimated avoided</span><div className="cq-metric__value">{body.carbon.avoidedKgCo2e === null ? '—' : formatCarbonKg(body.carbon.avoidedKgCo2e, detail.snapshot.meta.display.carbonUnit)}</div></div>
      </div>
      <Table label="Projects in this frozen report"><thead><tr><th scope="col">Project</th><th scope="col">Dates</th><th scope="col">Mass</th></tr></thead><tbody>{body.projects.map((project) => <tr key={project.id}><td className="cq-table__primary">{project.name}</td><td>{formatDate(project.startsOn)} – {formatDate(project.endsOn)}</td><td>{formatMassKg(project.massKg, detail.snapshot.meta.display.massUnit)}</td></tr>)}</tbody></Table>
      <Row><Button onClick={() => void download(detail.report)}>Download PDF</Button><Button variant="secondary" disabled={busy} onClick={() => void share(detail.report)}>{detail.report.clientVisible ? 'Stop sharing' : 'Share with client'}</Button></Row>
    </Section> : null}

    <Section title="Report history" description="Opening a report reads its frozen snapshot, not today’s project rows.">
      {reports.loading ? <p className="cq-muted">Loading…</p> : !reports.data?.length ? <EmptyState title="No client-period reports yet">Choose a client and a quarter or year above.</EmptyState> : <Table label="Client-period reports"><thead><tr><th scope="col">Report</th><th scope="col">Period</th><th scope="col">Generated</th><th scope="col">State</th><th scope="col">Actions</th></tr></thead><tbody>{reports.data.map((report) => <tr key={report.id}><td className="cq-table__primary">{report.title}<span className="cq-table__note">{report.clientCompanyName}</span></td><td>{formatDate(report.periodStart)} – {formatDate(report.periodEnd)}</td><td>{formatDateTime(report.generatedAt)}</td><td><Badge tone={report.status === 'GENERATED' ? 'success' : report.status === 'VOID' ? 'danger' : 'neutral'}>{report.status}</Badge>{report.clientVisible ? <Badge tone="accent">Shared</Badge> : null}</td><td><Row><Button size="sm" variant="secondary" onClick={() => void selectReport(report)}>Open</Button><Button size="sm" variant="secondary" onClick={() => void download(report)}>PDF</Button></Row></td></tr>)}</tbody></Table>}
    </Section>
  </Stack>;
}
