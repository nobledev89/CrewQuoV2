'use client';

import { useState } from 'react';
import {
  COMPLIANCE_KINDS,
  type ComplianceDocumentView,
  type ComplianceKind,
  type ComplianceOverallStatus,
  type ComplianceSummaryView,
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
import { useEntitlements } from '@/lib/useEntitlements';
import { useCapabilities } from '@/lib/useCapabilities';
import { useAsyncData } from '@/lib/useAsyncData';
import { uploadFile } from '@/lib/upload';
import { useFileReadiness } from '@/lib/useFileReadiness';
import { formatDate, titleCase } from '@/lib/format';

const STATUS_TONE: Record<ComplianceOverallStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  VALID: 'success',
  EXPIRING: 'warning',
  EXPIRED: 'danger',
  MISSING: 'danger',
  REJECTED: 'danger',
  UNKNOWN: 'neutral',
};

export default function CompliancePage() {
  return <Shell><ComplianceRegister /></Shell>;
}

function ComplianceRegister() {
  const ctx = useSessionCtx();
  const ent = useEntitlements();
  const caps = useCapabilities();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(false);
  const [renewing, setRenewing] = useState<ComplianceDocumentView | null>(null);
  const [rejecting, setRejecting] = useState<ComplianceDocumentView | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summary = useAsyncData<ComplianceSummaryView>(
    ctx ? () => api.complianceSummary(ctx.accessToken, ctx.companyId).then((r) => r.summary) : null,
    [ctx?.companyId]
  );
  const documents = useAsyncData<ComplianceDocumentView[]>(
    ctx
      ? () => api.listComplianceDocuments(ctx.accessToken, ctx.companyId, { status: status || undefined }).then((r) => r.documents)
      : null,
    [ctx?.companyId, status]
  );

  const reload = () => { summary.reload(); documents.reload(); };

  if (!ent.loading && !ent.has('compliance_tracking')) return <FeatureLocked feature="compliance_tracking" />;
  if (!caps.loading && !caps.can('compliance.manage')) {
    return <Stack><PageHeader eyebrow="Operations" title="Compliance" /><Notice>Your job function does not include compliance management.</Notice></Stack>;
  }
  const feature = refusedFeature(summary.error ?? documents.error);
  if (feature === 'compliance_tracking') return <FeatureLocked feature="compliance_tracking" />;

  async function review(document: ComplianceDocumentView, decision: 'ACCEPT' | 'REJECT', reason?: string) {
    if (!ctx) return;
    setBusy(true); setError(null);
    try {
      await api.updateComplianceDocument(ctx.accessToken, ctx.companyId, document.id, {
        expectedRevision: document.revision,
        review: { decision, reason: reason ?? null },
      });
      setRejecting(null); setRejectReason(''); reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record that review');
    } finally { setBusy(false); }
  }

  async function remove(document: ComplianceDocumentView) {
    if (!ctx) return;
    setBusy(true); setError(null);
    try { await api.deleteComplianceDocument(ctx.accessToken, ctx.companyId, document.id); reload(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not remove that record'); }
    finally { setBusy(false); }
  }

  async function openFile(fileId: string) {
    if (!ctx) return;
    try {
      const { url } = await api.fileDownloadUrl(ctx.accessToken, ctx.companyId, fileId);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not open that file'); }
  }

  const s = summary.data;
  return (
    <Stack>
      <PageHeader
        eyebrow="Operations"
        title="Compliance"
        description="Current subcontractor requirements, certificates and the 90/60/30/14/7 renewal ladder."
        actions={<Button onClick={() => { setRenewing(null); setOpen(true); }}>Add requirement</Button>}
      />
      <ErrorText>{error ?? summary.error ?? documents.error}</ErrorText>
      {s?.enforceCompliance ? (
        <Notice><strong>Enforcement is on.</strong> Missing, rejected or expired mandatory records prevent new provider bookings and work submissions.</Notice>
      ) : (
        <Notice>Enforcement is off. Compliance issues are shown on bookings and submissions, but work is not blocked.</Notice>
      )}

      {s && s.providers.length > 0 ? (
        <Section title="Subcontractors" description="Unknown means no mandatory requirements have been recorded; it does not mean compliant.">
          <div className="cq-metrics">
            {(['VALID','EXPIRING','EXPIRED','MISSING','REJECTED','UNKNOWN'] as ComplianceOverallStatus[]).map((key) => (
              <div className="cq-metric" key={key}><span className="cq-overline">{titleCase(key)}</span><div className="cq-metric__value">{s.totals[key]}</div></div>
            ))}
          </div>
          <Table label="Compliance by subcontractor">
            <thead><tr><th scope="col">Subcontractor</th><th scope="col">Status</th><th scope="col">Current records</th><th scope="col">Needs attention</th></tr></thead>
            <tbody>{s.providers.map((provider) => (
              <tr key={provider.engagementId}>
                <td className="cq-table__primary">{provider.subjectCompanyName}</td>
                <td><Badge tone={STATUS_TONE[provider.overallStatus]}>{titleCase(provider.overallStatus)}</Badge></td>
                <td>{provider.documentCount}</td>
                <td>{[
                  ...provider.blocking.map((item) => `${item.title} (${titleCase(item.status)})`),
                  ...provider.expiring.map((item) => `${item.title} (Expiring)`),
                ].join(', ') || '—'}</td>
              </tr>
            ))}</tbody>
          </Table>
        </Section>
      ) : summary.loading ? <p className="cq-muted">Loading…</p> : (
        <Section title="Subcontractors"><EmptyState title="No subcontractors to check">Add a subcontractor engagement first. Compliance is attached to the company relationship, not a duplicate subcontractor record.</EmptyState></Section>
      )}

      {open && s ? (
        <ComplianceForm
          providers={s.providers}
          predecessor={renewing}
          onClose={() => { setOpen(false); setRenewing(null); }}
          onSaved={() => { setOpen(false); setRenewing(null); reload(); }}
        />
      ) : null}

      {rejecting ? (
        <Section title={`Reject ${rejecting.title}`}>
          <Field label="Reason"><Input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} autoFocus /></Field>
          <Row><Button variant="danger" disabled={busy || !rejectReason.trim()} onClick={() => void review(rejecting, 'REJECT', rejectReason.trim())}>Reject record</Button><Button variant="secondary" onClick={() => setRejecting(null)}>Cancel</Button></Row>
        </Section>
      ) : null}

      <Section title="Documents" actions={<Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All current</option>{['VALID','EXPIRING','EXPIRED','MISSING','REJECTED'].map((value) => <option value={value} key={value}>{titleCase(value)}</option>)}</Select></Field>}>
        {documents.loading ? <p className="cq-muted">Loading…</p> : !documents.data?.length ? <EmptyState title="No compliance records match">Add a missing requirement now; attach the certificate when it arrives.</EmptyState> : (
          <Table label="Compliance documents"><thead><tr><th scope="col">Document</th><th scope="col">Company</th><th scope="col">Expiry</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
            <tbody>{documents.data.map((document) => (
              <tr key={document.id}>
                <td className="cq-table__primary">{document.title}<span className="cq-table__note">{titleCase(document.kind)}{document.mandatory ? ' · mandatory' : ' · optional'}</span></td>
                <td>{document.subjectCompanyName}<span className="cq-table__note">Tracked by {document.ownerCompanyName}</span></td>
                <td>{document.expiresOn ? formatDate(document.expiresOn) : 'No expiry'}</td>
                <td><Badge tone={STATUS_TONE[document.status]}>{titleCase(document.status)}</Badge>{document.rejectReason ? <span className="cq-table__note">{document.rejectReason}</span> : null}</td>
                <td><Row>
                  {document.fileId ? <Button size="sm" variant="secondary" onClick={() => void openFile(document.fileId!)}>Open</Button> : null}
                  {document.ownerCompanyId === ctx?.companyId && document.fileId && document.status === 'REJECTED' ? <Button size="sm" onClick={() => void review(document, 'ACCEPT')}>Accept</Button> : null}
                  {document.ownerCompanyId === ctx?.companyId && document.fileId && document.status !== 'REJECTED' ? <Button size="sm" variant="secondary" onClick={() => setRejecting(document)}>Reject</Button> : null}
                  {document.ownerCompanyId === ctx?.companyId && document.fileId ? <Button size="sm" variant="secondary" onClick={() => { setRenewing(document); setOpen(true); }}>Renew</Button> : null}
                  {document.ownerCompanyId === ctx?.companyId && !document.superseded ? <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove(document)}>Remove</Button> : null}
                </Row></td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Section>
    </Stack>
  );
}

function ComplianceForm({ providers, predecessor, onClose, onSaved }: {
  providers: ComplianceSummaryView['providers']; predecessor: ComplianceDocumentView | null; onClose: () => void; onSaved: () => void;
}) {
  const ctx = useSessionCtx();
  const [subject, setSubject] = useState(predecessor?.subjectCompanyId ?? providers[0]?.subjectCompanyId ?? ctx?.companyId ?? '');
  const [kind, setKind] = useState<ComplianceKind>(predecessor?.kind ?? 'PUBLIC_LIABILITY');
  const [title, setTitle] = useState(predecessor?.title ?? 'Public liability insurance');
  const [issuedOn, setIssuedOn] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [mandatory, setMandatory] = useState(predecessor?.mandatory ?? true);
  const [fileId, setFileId] = useState<string | null>(null);
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readiness = useFileReadiness(fileId);

  async function save(e: React.FormEvent) {
    e.preventDefault(); if (!ctx) return;
    setBusy(true); setError(null);
    try {
      await api.createComplianceDocument(ctx.accessToken, ctx.companyId, {
        subjectCompanyId: subject,
        kind,
        title: title.trim(),
        fileId,
        issuedOn: issuedOn || null,
        expiresOn: expiresOn || null,
        mandatory,
        supersedesId: predecessor?.id ?? null,
      });
      onSaved();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not save that compliance record'); }
    finally { setBusy(false); }
  }

  return <Section title={predecessor ? `Renew ${predecessor.title}` : 'Add compliance requirement'} description={predecessor ? 'The existing file remains in history; this creates its current successor.' : 'A requirement may be recorded as missing before its file arrives.'}>
    <form className="cq-stack" onSubmit={save} aria-busy={busy}>
      <div className="cq-form-grid">
        <Field label="Subcontractor"><Select value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!!predecessor}>{providers.map((provider) => <option key={provider.subjectCompanyId} value={provider.subjectCompanyId}>{provider.subjectCompanyName}</option>)}</Select></Field>
        <Field label="Kind"><Select value={kind} onChange={(e) => setKind(e.target.value as ComplianceKind)} disabled={!!predecessor}>{COMPLIANCE_KINDS.map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}</Select></Field>
        <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} required /></Field>
        <Field label="Issued on"><Input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} /></Field>
        <Field label="Expires on"><Input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} /></Field>
        <Field label="Requirement"><label><input type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} /> Mandatory for work</label></Field>
      </div>
      <label className="cq-btn cq-btn--secondary">{filename || 'Attach PDF or image'}<input className="cq-vh" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={async (e) => {
        const file = e.target.files?.[0]; e.target.value = ''; if (!file || !ctx) return;
        setBusy(true); setError(null);
        try { const uploaded = await uploadFile({ accessToken: ctx.accessToken, companyId: ctx.companyId }, file, { kind: 'DOCUMENT' }); setFileId(uploaded.fileId); setFilename(file.name); }
        catch (err) { setError(err instanceof ApiError ? err.message : 'Could not upload that file'); }
        finally { setBusy(false); }
      }} /></label>
      {fileId && readiness.state !== 'READY' ? <Notice live>{readiness.state === 'CHECKING' ? 'Checking this file before it is filed…' : readiness.state === 'FAILED' ? readiness.reason : 'The file check is taking longer than expected. Try again shortly.'}</Notice> : null}
      <ErrorText>{error}</ErrorText>
      <Row><Button type="submit" disabled={busy || !subject || !title.trim() || (!!predecessor && !fileId) || (!!fileId && readiness.state !== 'READY')}>{busy ? 'Saving…' : predecessor ? 'Save renewal' : 'Save requirement'}</Button><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button></Row>
    </form>
  </Section>;
}
