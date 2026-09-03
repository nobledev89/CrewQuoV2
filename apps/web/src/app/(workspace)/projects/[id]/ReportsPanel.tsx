'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type {
  ClientSignoffView,
  GeneratedReportDetail,
  GeneratedReportView,
  ReportAudience,
  ReportKind,
  ReportSectionKey,
} from '@crewquo/shared';
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Notice,
  RecordHeader,
  Row,
  Section,
  Select,
  Stack,
  Table,
  Textarea,
} from '@crewquo/ui';
import { api, ApiError, refusedFeature } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncData } from '@/lib/useAsyncData';
import { useCapabilities } from '@/lib/useCapabilities';
import { formatDate } from '@/lib/format';

/**
 * The project Reports section (§29, §34) — step 10.10.
 *
 * ── THE ONE THING THIS SCREEN RENDERS THAT THE PDF DOES NOT ─────────────────
 *
 * `staleNotes`. A generated report is frozen: re-rendering it a year later
 * produces the same bytes, which is §29.4 and the phase's milestone. So the
 * sentence *"the site diary for 3 March has been amended since this report was
 * generated"* cannot be printed inside the document — it is a fact about the
 * present, and a document that changes with the present is not a snapshot.
 *
 * It belongs here instead, beside the download, where the person who can act on
 * it — by regenerating — is looking. See the note at the top of
 * `apps/api/src/modules/reports/render.ts` for how the acceptance script settled
 * it.
 *
 * ── AND THE ONE CONTROL THAT NEEDS A SECOND THOUGHT ────────────────────────
 *
 * "Share with the client" hands a file to somebody outside the company, and a
 * file cannot be un-sent. It is only offered on a document that was *assembled*
 * for a client — the API and the database both refuse the rest — and it says what
 * the document contains before it is pressed.
 */

const KIND_LABELS: Record<ReportKind, string> = {
  SUSTAINABILITY: 'Sustainability & completion report',
  EVIDENCE_PACK: 'Evidence & completion pack',
  CLIENT_EXPORT: 'Client project statement',
  CLIENT_PERIOD: 'Client period report',
};

const AUDIENCE_LABELS: Record<ReportAudience, string> = {
  INTERNAL: 'Internal — names your subcontractors',
  CLIENT: 'For the client — counts them instead',
};

export function ReportsPanel({
  projectId,
  projectName,
  hasClient,
}: {
  projectId: string;
  projectName: string;
  hasClient: boolean;
}) {
  const ctx = useSessionCtx();
  const caps = useCapabilities();
  const canGenerate = caps.can('report.generate');

  const catalog = useAsyncData(
    ctx && canGenerate ? () => api.reportCatalog(ctx.accessToken, ctx.companyId, projectId) : null,
    [ctx?.companyId, projectId, canGenerate]
  );
  const reports = useAsyncData(
    ctx && canGenerate
      ? () => api.listReports(ctx.accessToken, ctx.companyId, projectId, true)
      : null,
    [ctx?.companyId, projectId, canGenerate]
  );

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    reports.reload();
  }, [reports]);

  if (!canGenerate) {
    return (
      <Section title="Reports">
        <Notice>
          Producing a report needs the <strong>Generate reports</strong> permission. Somebody with
          the Admin, Project manager, Finance or Sustainability bundle can grant it.
        </Notice>
      </Section>
    );
  }

  const locked = refusedFeature(catalog.error) ?? refusedFeature(reports.error);
  if (locked) {
    return (
      <Section title="Reports">
        <Notice>
          <strong>Reports are not on your plan.</strong> See{' '}
          <Link href="/plan">plan &amp; usage</Link> for what includes them.
        </Notice>
      </Section>
    );
  }

  const rows = reports.data?.reports ?? [];
  const current = rows.filter((r) => r.status === 'GENERATED');
  const history = rows.filter((r) => r.status !== 'GENERATED');

  return (
    <Stack>
      <Section
        title="Reports"
        description="A generated report is frozen: the figures in it are the figures as they stood, and re-opening it next year produces the same document."
        actions={
          <Button onClick={() => setOpen(true)} disabled={busy}>
            Generate a report
          </Button>
        }
      >
        <ErrorText>{error}</ErrorText>
        {current.length === 0 ? (
          <EmptyState title="No reports yet">
            Generate the sustainability &amp; completion report when the work is done, or the
            evidence pack when the client&rsquo;s QS asks for the handover file.
          </EmptyState>
        ) : (
          <Table label="Generated reports">
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">For</th>
                <th scope="col">Generated</th>
                <th scope="col">Shared</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {current.map((report) => (
                <ReportRow
                  key={report.id}
                  report={report}
                  onOpen={() => setSelected(report.id)}
                  onChanged={reload}
                  onError={setError}
                  setBusy={setBusy}
                  busy={busy}
                />
              ))}
            </tbody>
          </Table>
        )}

        {history.length > 0 ? (
          <details>
            <summary>
              {history.length} superseded or voided document{history.length === 1 ? '' : 's'}
            </summary>
            <p className="cq-muted">
              A superseded report is retained and still opens exactly as it did. That is the point
              of it: whoever was sent the old numbers can still see the document they were sent.
            </p>
            <Table label="Superseded reports" compact>
              <thead>
                <tr>
                  <th scope="col">Document</th>
                  <th scope="col">Generated</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {history.map((report) => (
                  <tr key={report.id}>
                    <td className="cq-table__primary">{KIND_LABELS[report.kind]}</td>
                    <td>{formatDate(report.generatedAt.slice(0, 10))}</td>
                    <td>
                      <Badge tone={report.status === 'VOID' ? 'danger' : 'neutral'}>
                        {report.status === 'VOID' ? 'Void' : 'Superseded'}
                      </Badge>
                      {report.voidReason ? (
                        <span className="cq-table__note">{report.voidReason}</span>
                      ) : null}
                    </td>
                    <td>
                      <Button size="sm" variant="secondary" onClick={() => setSelected(report.id)}>
                        Open
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </details>
        ) : null}
      </Section>

      <SignoffSection projectId={projectId} />

      <GenerateDrawer
        open={open}
        onClose={() => setOpen(false)}
        projectId={projectId}
        projectName={projectName}
        hasClient={hasClient}
        catalog={catalog.data?.kinds ?? []}
        onGenerated={(report, reused) => {
          setOpen(false);
          reload();
          setSelected(report.id);
          setError(
            reused
              ? 'Nothing has changed since the last one, so this is the document that already existed.'
              : null
          );
        }}
      />

      <ReportDrawer
        reportId={selected}
        onClose={() => setSelected(null)}
        onChanged={reload}
      />
    </Stack>
  );
}

// ── One row ───────────────────────────────────────────────────────────────────

function ReportRow({
  report,
  onOpen,
  onChanged,
  onError,
  setBusy,
  busy,
}: {
  report: GeneratedReportView;
  onOpen: () => void;
  onChanged: () => void;
  onError: (message: string | null) => void;
  setBusy: (busy: boolean) => void;
  busy: boolean;
}) {
  const ctx = useSessionCtx();

  async function share(next: boolean) {
    if (!ctx) return;
    setBusy(true);
    onError(null);
    try {
      await api.setReportVisibility(ctx.accessToken, ctx.companyId, report.id, next);
      onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not change who can see this');
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td className="cq-table__primary">
        {KIND_LABELS[report.kind]}
        <span className="cq-table__note">{report.title}</span>
      </td>
      <td>
        <Badge tone={report.audience === 'CLIENT' ? 'accent' : 'neutral'}>
          {report.audience === 'CLIENT' ? 'Client' : 'Internal'}
        </Badge>
      </td>
      <td>
        {formatDate(report.generatedAt.slice(0, 10))}
        {report.generatedByName ? (
          <span className="cq-table__note">by {report.generatedByName}</span>
        ) : null}
      </td>
      <td>
        {report.audience !== 'CLIENT' ? (
          // Not a disabled control: an internal document is not a shareable one
          // that happens to be switched off, and the database refuses the
          // combination outright.
          <span className="cq-muted">Not shareable</span>
        ) : report.clientVisible ? (
          <Row>
            <Badge tone="success">Shared</Badge>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void share(false)}>
              Withdraw
            </Button>
          </Row>
        ) : (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void share(true)}>
            Share with client
          </Button>
        )}
      </td>
      <td>
        <Button size="sm" variant="secondary" onClick={onOpen}>
          Open
        </Button>
      </td>
    </tr>
  );
}

// ── Generate ──────────────────────────────────────────────────────────────────

interface CatalogKind {
  kind: ReportKind;
  feature: string;
  audiences: ReportAudience[];
  defaults: ReportSectionKey[];
  sections: { key: ReportSectionKey; label: string; defaultOn: boolean; toggleable: boolean }[];
}

function GenerateDrawer({
  open,
  onClose,
  projectId,
  projectName,
  hasClient,
  catalog,
  onGenerated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
  hasClient: boolean;
  catalog: CatalogKind[];
  onGenerated: (report: GeneratedReportView, reused: boolean) => void;
}) {
  const ctx = useSessionCtx();
  const [kind, setKind] = useState<ReportKind>('SUSTAINABILITY');
  const [audience, setAudience] = useState<ReportAudience>('CLIENT');
  const [chosen, setChosen] = useState<ReportSectionKey[] | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spec = useMemo(() => catalog.find((k) => k.kind === kind), [catalog, kind]);
  const sections = chosen ?? spec?.defaults ?? [];

  useEffect(() => {
    setChosen(null);
    if (spec && !spec.audiences.includes(audience)) setAudience(spec.audiences[0]!);
  }, [kind, spec, audience]);

  async function submit() {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.generateReport(ctx.accessToken, ctx.companyId, projectId, {
        kind,
        audience,
        sections,
        title: title.trim() || undefined,
      });
      onGenerated(res.report, res.reused);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not generate the report'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      title="Generate a report"
      description={projectName}
      onClose={onClose}
      footer={
        <Row between>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? 'Generating…' : 'Generate'}
          </Button>
        </Row>
      }
    >
      <Stack>
        <Field label="Document">
          <Select value={kind} onChange={(e) => setKind(e.target.value as ReportKind)}>
            {catalog.map((k) => (
              <option key={k.kind} value={k.kind}>
                {KIND_LABELS[k.kind]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Reader"
          hint="A client copy counts your subcontracted organisations instead of naming them. The two are built from different data, not filtered from the same document."
        >
          <Select
            value={audience}
            onChange={(e) => setAudience(e.target.value as ReportAudience)}
          >
            {(spec?.audiences ?? ['INTERNAL']).map((a) => (
              <option key={a} value={a}>
                {AUDIENCE_LABELS[a]}
              </option>
            ))}
          </Select>
        </Field>

        {kind === 'CLIENT_EXPORT' && !hasClient ? (
          <Notice>This project has no client, so it has no client statement.</Notice>
        ) : null}

        <Field label="Title" hint="Optional — a default is composed from the project name.">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>

        {spec && spec.sections.length > 0 ? (
          <fieldset className="cq-fieldset">
            <legend className="cq-fieldset__legend">Sections</legend>
            <p className="cq-muted">
              The set you choose is stored on the document, so regenerating it reproduces the same
              one.
            </p>
            {spec.sections.map((section) => (
              <label key={section.key} className="cq-row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={sections.includes(section.key)}
                  disabled={!section.toggleable}
                  onChange={(e) =>
                    setChosen(
                      e.target.checked
                        ? [...sections, section.key]
                        : sections.filter((s) => s !== section.key)
                    )
                  }
                />
                <span>
                  {section.label}
                  {!section.toggleable ? (
                    <span className="cq-muted"> — always included</span>
                  ) : null}
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}

        <ErrorText>{error}</ErrorText>
      </Stack>
    </Drawer>
  );
}

// ── One report ────────────────────────────────────────────────────────────────

function ReportDrawer({
  reportId,
  onClose,
  onChanged,
}: {
  reportId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const ctx = useSessionCtx();
  const detail = useAsyncData<GeneratedReportDetail>(
    ctx && reportId ? () => api.reportDetail(ctx.accessToken, ctx.companyId, reportId) : null,
    [ctx?.companyId, reportId]
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');

  const report = detail.data?.report;

  async function downloadPdf() {
    if (!ctx || !report) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await api.downloadReport(ctx.accessToken, ctx.companyId, report.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${report.title.replace(/[^\w.-]+/g, '-').toLowerCase()}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not produce the document');
    } finally {
      setBusy(false);
    }
  }

  async function voidIt() {
    if (!ctx || !report) return;
    setBusy(true);
    setError(null);
    try {
      await api.voidReport(ctx.accessToken, ctx.companyId, report.id, voidReason.trim());
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not void the document');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={reportId !== null}
      title={report ? KIND_LABELS[report.kind] : 'Report'}
      description={report?.title}
      onClose={onClose}
      footer={
        <Row between>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => void downloadPdf()} disabled={busy || !report}>
            {busy ? 'Preparing…' : 'Download PDF'}
          </Button>
        </Row>
      }
    >
      <Stack>
        <ErrorText>{error ?? detail.error}</ErrorText>

        {/*
          The staleness banner. It is here and not in the PDF, because a live
          comparison inside a frozen document would make the document a function of
          the present — see the header of this file.
        */}
        {(detail.data?.staleNotes ?? []).length > 0 ? (
          <Notice live>
            <strong>The records behind this document have changed since it was generated.</strong>
            <ul>
              {detail.data!.staleNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            The document itself is unchanged and still shows the figures it was generated with.
            Generate a new one to publish the current numbers; this one is retained either way.
          </Notice>
        ) : null}

        {report ? (
          <>
            <RecordHeader
              figures={[
                {
                  label: 'Generated',
                  value: formatDate(report.generatedAt.slice(0, 10)),
                  note: report.generatedByName ?? null,
                },
                {
                  label: 'Reader',
                  value: report.audience === 'CLIENT' ? 'The client' : 'Internal only',
                  note: report.status === 'GENERATED' ? null : report.status,
                },
                {
                  label: 'Seal',
                  /* The first sixteen characters, which is what the PDF footer
                     prints: two printed copies can be compared without opening
                     either file. */
                  value: <code>{report.contentHash.slice(0, 16)}</code>,
                  note: 'Printed in the document footer',
                },
              ]}
            />

            {report.supersededById ? (
              <Notice>
                A newer version of this document has been generated. This one is kept because
                somebody may already have it.
              </Notice>
            ) : null}

            {report.status === 'GENERATED' ? (
              <details>
                <summary>Void this document</summary>
                <p className="cq-muted">
                  For a document that should never have existed — the wrong project, the wrong
                  period, or one shared by mistake. It stops being current and stops being visible
                  to the client; the row and its contents are kept.
                </p>
                <Field label="Reason">
                  <Input
                    value={voidReason}
                    onChange={(e) => setVoidReason(e.target.value)}
                    maxLength={500}
                  />
                </Field>
                <Button
                  variant="danger"
                  disabled={busy || voidReason.trim().length < 3}
                  onClick={() => void voidIt()}
                >
                  Void
                </Button>
              </details>
            ) : null}
          </>
        ) : null}
      </Stack>
    </Drawer>
  );
}

// ── §34: sign-off ─────────────────────────────────────────────────────────────

/**
 * Capturing a signature, and the two things that make it different from every
 * other form in this application.
 *
 * **The snapshot is built here, on the device.** What the signer is shown is what
 * is sent, so the signature attests to the state the signer actually saw rather
 * than to whatever the server holds when the request lands. On a tablet in a
 * stairwell those are hours apart.
 *
 * **Nothing here can be edited afterwards.** A correction is a second signature
 * pointing at the first, and both are kept.
 */
function SignoffSection({ projectId }: { projectId: string }) {
  const ctx = useSessionCtx();
  const caps = useCapabilities();
  const canCapture = caps.can('signoff.capture');
  const list = useAsyncData(
    ctx ? () => api.listSignoffs(ctx.accessToken, ctx.companyId, projectId) : null,
    [ctx?.companyId, projectId]
  );
  const [open, setOpen] = useState(false);
  const [supersedes, setSupersedes] = useState<ClientSignoffView | null>(null);

  const signoffs = list.data?.signoffs ?? [];
  const current = list.data?.current ?? [];

  return (
    <>
      <Section
        title="Client sign-off"
        description="A signature, and the state it was signed against. Neither can be edited afterwards — a correction is a second sign-off, and both are kept."
        actions={
          canCapture ? (
            <Button
              variant="secondary"
              onClick={() => {
                setSupersedes(null);
                setOpen(true);
              }}
            >
              Capture a sign-off
            </Button>
          ) : null
        }
      >
        {signoffs.length === 0 ? (
          <EmptyState title="Nothing signed yet">
            When the client accepts the work, capture their signature here — on a tablet, on site,
            beside them.
          </EmptyState>
        ) : (
          <Table label="Client sign-offs">
            <thead>
              <tr>
                <th scope="col">Signed by</th>
                <th scope="col">Scope</th>
                <th scope="col">When</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {signoffs.map((signoff) => (
                <tr key={signoff.id}>
                  <td className="cq-table__primary">
                    {signoff.signerName}
                    {signoff.signerRole ? (
                      <span className="cq-table__note">{signoff.signerRole}</span>
                    ) : null}
                    {/* The reason lives on the row that *supersedes*, because that is
                        the act it explains — the earlier signature is unchanged and
                        has nothing new to say about itself. */}
                    {signoff.supersedeReason ? (
                      <span className="cq-table__note">
                        Corrects an earlier sign-off: {signoff.supersedeReason}
                      </span>
                    ) : null}
                  </td>
                  <td>{signoff.phase ?? 'Whole project'}</td>
                  <td>{new Date(signoff.signedAt).toLocaleString()}</td>
                  <td>
                    {signoff.supersededById ? (
                      <Badge tone="neutral">Superseded</Badge>
                    ) : (
                      <Row>
                        <Badge tone="success">Current</Badge>
                        {canCapture ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setSupersedes(signoff);
                              setOpen(true);
                            }}
                          >
                            Capture a correction
                          </Button>
                        ) : null}
                      </Row>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {current.length > 1 ? (
          <Notice>
            Two sign-offs are current for this project. Both were really captured, so neither is
            discarded — capture a third to settle which one stands.
          </Notice>
        ) : null}
      </Section>

      <SignoffDrawer
        open={open}
        projectId={projectId}
        supersedes={supersedes}
        onClose={() => setOpen(false)}
        onCaptured={() => {
          setOpen(false);
          list.reload();
        }}
      />
    </>
  );
}

function SignoffDrawer({
  open,
  projectId,
  supersedes,
  onClose,
  onCaptured,
}: {
  open: boolean;
  projectId: string;
  supersedes: ClientSignoffView | null;
  onClose: () => void;
  onCaptured: () => void;
}) {
  const ctx = useSessionCtx();
  const [signerName, setSignerName] = useState('');
  const [signerCompany, setSignerCompany] = useState('');
  const [signerRole, setSignerRole] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [phase, setPhase] = useState('');
  const [statement, setStatement] = useState(
    'The works described in this project are complete and accepted.'
  );
  const [comments, setComments] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * One client id per opening of this drawer, minted here rather than on submit.
   * A retry after a dropped connection sends the same id and gets the signature
   * that already exists back, instead of a second one — which is the whole of the
   * offline contract on this record.
   */
  const clientId = useRef<string>('');
  useEffect(() => {
    if (open) clientId.current = crypto.randomUUID();
  }, [open]);

  async function submit() {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await api.captureSignoff(ctx.accessToken, ctx.companyId, projectId, {
        clientId: clientId.current,
        phase: phase.trim() || null,
        signerName: signerName.trim(),
        signerCompany: signerCompany.trim() || null,
        signerRole: signerRole.trim() || null,
        signerEmail: signerEmail.trim() || null,
        completionStatement: statement.trim(),
        comments: comments.trim() || null,
        // What was on the screen when they signed, sent verbatim.
        evidenceSnapshot: {
          capturedAt: new Date().toISOString(),
          statement: statement.trim(),
          comments: comments.trim() || null,
          phase: phase.trim() || null,
        },
        ...(supersedes ? { supersedesId: supersedes.id, supersedeReason: reason.trim() } : {}),
      });
      onCaptured();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the sign-off');
    } finally {
      setBusy(false);
    }
  }

  const ready =
    signerName.trim().length > 0 &&
    statement.trim().length > 0 &&
    (!supersedes || reason.trim().length >= 3);

  return (
    <Drawer
      open={open}
      title={supersedes ? 'Capture a correction' : 'Capture a client sign-off'}
      description={
        supersedes
          ? `This becomes a new sign-off pointing at the one ${supersedes.signerName} gave. Both are kept.`
          : 'Show this to the client, then record their acceptance. It cannot be edited afterwards.'
      }
      onClose={onClose}
      footer={
        <Row between>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !ready}>
            {busy ? 'Recording…' : 'Record sign-off'}
          </Button>
        </Row>
      }
    >
      <Stack>
        <Field label="Signed by">
          <Input value={signerName} onChange={(e) => setSignerName(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Their role">
          <Input value={signerRole} onChange={(e) => setSignerRole(e.target.value)} maxLength={120} />
        </Field>
        <Field label="For">
          <Input
            value={signerCompany}
            onChange={(e) => setSignerCompany(e.target.value)}
            maxLength={200}
          />
        </Field>
        <Field label="Their email" hint="Optional. Used to send them their copy, and nothing else.">
          <Input
            type="email"
            value={signerEmail}
            onChange={(e) => setSignerEmail(e.target.value)}
            maxLength={320}
          />
        </Field>
        <Field label="Phase" hint="Leave blank for the whole project.">
          <Input value={phase} onChange={(e) => setPhase(e.target.value)} maxLength={120} />
        </Field>
        <Field label="What they are signing for" wide>
          <Textarea
            rows={4}
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
            maxLength={4000}
          />
        </Field>
        <Field label="Their comments" wide>
          <Textarea
            rows={3}
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            maxLength={4000}
          />
        </Field>
        {supersedes ? (
          <Field label="Why it is being signed again" hint="Required — it goes on the record.">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
        ) : null}
        <ErrorText>{error}</ErrorText>
      </Stack>
    </Drawer>
  );
}
