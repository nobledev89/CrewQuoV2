'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type {
  LineItemEntityType,
  LineItemNoteView,
  PortalLineItem,
  PortalProjectDetail,
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
  Stack,
  Table,
} from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useAuth, useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncData } from '@/lib/useAsyncData';
import { useAsyncList } from '@/lib/useAsyncList';
import { ProjectStatusBadge } from '@/components/Status';
import { formatCents, formatDate, formatDateTime, titleCase, formatAuditAction } from '@/lib/format';

/**
 * A shared project as its client sees it: line items, totals, the notes thread, and —
 * if the contractor has switched it on — their activity trail.
 *
 * Two honesty rules drive the layout:
 *
 *  - **`pricingComplete: false` means the total is partial.** The server sums only the
 *    lines it could price, so presenting that sum as "the total" would understate the
 *    bill. It is labelled provisional and the unpriced lines are marked, because a
 *    blank cell reads as "nothing to pay" while a marker reads as "not settled yet".
 *  - **`amountCents: null` is not zero.** Same reason, per line.
 */
export default function PortalProjectPage() {
  return (
    <Shell>
      <PortalProject />
    </Shell>
  );
}

function PortalProject() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const ctx = useSessionCtx();

  const detail = useAsyncData<PortalProjectDetail>(
    ctx ? () => api.portalProject(ctx.accessToken, ctx.companyId, id) : null,
    [ctx?.companyId, id]
  );

  const engagementId = detail.data?.project.engagementId ?? null;

  const notes = useAsyncList<LineItemNoteView>(
    ctx && engagementId
      ? () => api.listNotes(ctx.accessToken, ctx.companyId, { engagementId }).then((r) => r.data)
      : null,
    [ctx?.companyId, engagementId]
  );

  const trail = useAsyncData(
    ctx && engagementId && detail.data?.showAuditTrail
      ? () => api.listAuditLogs(ctx.accessToken, ctx.companyId, { engagementId, limit: 50 })
      : null,
    [ctx?.companyId, engagementId, detail.data?.showAuditTrail]
  );

  const [anchor, setAnchor] = useState<{ type: LineItemEntityType; id: string; label: string } | null>(
    null
  );

  if (detail.loading) {
    return (
      <Stack>
        <PageHeader eyebrow="Client portal" title="Project" />
        <p className="cq-muted">Loading project…</p>
      </Stack>
    );
  }

  if (detail.error || !detail.data) {
    return (
      <Stack>
        <PageHeader eyebrow="Client portal" title="Project" />
        <EmptyState title="Project not available">
          {detail.error ??
            'This project is not shared with you. It may have been unpublished, or it belongs to a different company.'}{' '}
          <Link href="/portal">Back to shared projects</Link>
        </EmptyState>
      </Stack>
    );
  }

  const d = detail.data;
  const unpriced = d.lineItems.filter((l) => l.amountCents === null).length;

  return (
    <Stack>
      <PageHeader
        eyebrow={`Delivered by ${d.project.providerCompanyName}`}
        title={d.project.name}
        description={
          d.project.startsOn || d.project.endsOn
            ? `${formatDate(d.project.startsOn)} to ${formatDate(d.project.endsOn)}`
            : 'No dates set'
        }
        actions={<ProjectStatusBadge status={d.project.status} />}
      />

      <div className="cq-metrics" aria-label="Project totals">
        <div className="cq-metric">
          <div className="cq-overline">Labour</div>
          <div className="cq-metric__value">{formatCents(d.timeTotalCents, d.currency)}</div>
          <div className="cq-metric__context">
            {d.lineItems.filter((l) => l.kind === 'TIME').length} time entries
          </div>
        </div>
        <div className="cq-metric">
          <div className="cq-overline">Expenses</div>
          <div className="cq-metric__value">{formatCents(d.expenseTotalCents, d.currency)}</div>
          <div className="cq-metric__context">
            {d.lineItems.filter((l) => l.kind === 'EXPENSE').length} expense entries
          </div>
        </div>
        <div className="cq-metric">
          <div className="cq-overline">
            {d.pricingComplete ? 'Total' : 'Total so far'}
          </div>
          <div className="cq-metric__value">{formatCents(d.totalCents, d.currency)}</div>
          <div className="cq-metric__context">
            {d.pricingComplete ? 'All lines priced' : `${unpriced} line(s) not yet priced`}
          </div>
        </div>
      </div>

      {!d.pricingComplete ? (
        <Notice>
          <strong>This total is provisional.</strong>{' '}
          {unpriced === 1 ? 'One line has' : `${unpriced} lines have`} no price yet, so{' '}
          {unpriced === 1 ? 'it is' : 'they are'} not included in the figure above. The final
          amount will be higher. {d.project.providerCompanyName} has been shown the same gap.
        </Notice>
      ) : null}

      <Section
        title="Line items"
        description="Approved work on this project, charged at the rates agreed with you."
        className="cq-section--table"
      >
        {d.lineItems.length === 0 ? (
          <EmptyState title="No line items yet">
            Nothing has been approved on this project yet. Items appear here once the work is
            signed off.
          </EmptyState>
        ) : (
          <Table label="Line items">
            <thead>
              <tr>
                <th scope="col" className="cq-numeric">Date</th>
                <th scope="col">Description</th>
                <th scope="col" className="cq-numeric">Hours</th>
                <th scope="col" className="cq-numeric">Amount</th>
                <th scope="col">
                  <span className="cq-table__actions">Notes</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {d.lineItems.map((line) => (
                <tr key={line.id}>
                  {/*
                    The two kinds of line carry different dates: a time log is dated by
                    the day the work happened, an expense by the day it was raised. Under
                    one "Date" heading that reads as a single fact, so an expense entered
                    weeks later looks like work done weeks later. The kind is on the row,
                    so say which this is rather than leaving the client to assume.
                  */}
                  <td className="cq-table__primary cq-numeric">
                    {formatDate(line.date)}
                    {line.kind === 'EXPENSE' ? (
                      <span className="cq-muted"> raised</span>
                    ) : null}
                  </td>
                  <td>
                    {line.description}
                    {line.shiftType ? (
                      <span className="cq-muted"> · {titleCase(line.shiftType)}</span>
                    ) : null}
                  </td>
                  <td className="cq-numeric">
                    {line.hoursRegular === null ? (
                      <span className="cq-muted">—</span>
                    ) : (
                      <>
                        {line.hoursRegular + (line.hoursOt ?? 0)}
                        {line.hoursOt ? <span className="cq-muted"> ({line.hoursOt} OT)</span> : null}
                      </>
                    )}
                  </td>
                  <td className="cq-numeric">
                    {line.amountCents === null ? (
                      <Badge tone="warning">Not priced</Badge>
                    ) : (
                      formatCents(line.amountCents, d.currency)
                    )}
                  </td>
                  <td className="cq-table__actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        setAnchor({
                          type: line.kind === 'TIME' ? 'TIME_LOG' : 'EXPENSE',
                          id: line.id,
                          label: `${formatDate(line.date)} — ${line.description}`,
                        })
                      }
                    >
                      {line.noteCount > 0 ? `Notes (${line.noteCount})` : 'Add note'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      {engagementId ? (
        <NotesThread
          engagementId={engagementId}
          notes={notes}
          canComment={d.canComment}
          anchor={anchor}
          project={{ id: d.project.id, name: d.project.name }}
          onClearAnchor={() => setAnchor(null)}
          lineItems={d.lineItems}
        />
      ) : (
        <Notice>
          This project is not attached to an engagement, so there is no notes thread on it.
        </Notice>
      )}

      {d.showAuditTrail ? (
        <Section
          title="Activity"
          description={`What ${d.project.providerCompanyName} has chosen to share about how this work progressed.`}
          className="cq-section--table"
        >
          {trail.loading ? (
            <p className="cq-muted">Loading activity…</p>
          ) : trail.error ? (
            <ErrorText>{trail.error}</ErrorText>
          ) : !trail.data || trail.data.data.length === 0 ? (
            <EmptyState title="No shared activity yet">
              Activity appears here as work is submitted and approved.
            </EmptyState>
          ) : (
            <Table label="Shared activity">
              <thead>
                <tr>
                  <th scope="col" className="cq-numeric">When</th>
                  <th scope="col">Event</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {trail.data.data.map((row) => (
                  <tr key={row.id}>
                    <td className="cq-table__primary cq-numeric">{formatDateTime(row.createdAt)}</td>
                    <td>{formatAuditAction(row.action)}</td>
                    <td>{row.description ?? <span className="cq-muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Section>
      ) : null}
    </Stack>
  );
}

// ── Notes ──────────────────────────────────────────────────────────────────────

function NotesThread({
  engagementId,
  notes,
  canComment,
  anchor,
  project,
  lineItems,
  onClearAnchor,
}: {
  engagementId: string;
  notes: ReturnType<typeof useAsyncList<LineItemNoteView>>;
  canComment: boolean;
  anchor: { type: LineItemEntityType; id: string; label: string } | null;
  project: { id: string; name: string };
  lineItems: PortalLineItem[];
  onClearAnchor: () => void;
}) {
  const ctx = useSessionCtx();
  const { companyId } = useAuth();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Where a new note lands: the selected line, or the project itself.
  const target = anchor ?? { type: 'PROJECT' as LineItemEntityType, id: project.id, label: project.name };

  const lineLabel = useMemo(() => {
    const byId = new Map(lineItems.map((l) => [l.id, `${formatDate(l.date)} — ${l.description}`]));
    return (entityType: string, entityId: string) =>
      entityType === 'PROJECT' ? project.name : (byId.get(entityId) ?? 'A line item');
  }, [lineItems, project.name]);

  const shown = anchor
    ? notes.items.filter((n) => n.entityType === anchor.type && n.entityId === anchor.id)
    : notes.items;

  async function post(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx || !body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createNote(ctx.accessToken, ctx.companyId, {
        engagementId,
        entityType: target.type,
        entityId: target.id,
        body: body.trim(),
      });
      setBody('');
      notes.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not post the note');
    } finally {
      setBusy(false);
    }
  }

  async function toggleResolved(note: LineItemNoteView) {
    if (!ctx) return;
    setBusyId(note.id);
    setError(null);
    try {
      await api.updateNote(ctx.accessToken, ctx.companyId, note.id, { resolved: !note.resolved });
      notes.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the note');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Section
      title={anchor ? 'Notes on this line' : 'Notes'}
      description={
        anchor
          ? anchor.label
          : 'Questions and replies on this project. Either side can mark a thread resolved.'
      }
      actions={
        anchor ? (
          <Button size="sm" variant="secondary" onClick={onClearAnchor}>
            Show all notes
          </Button>
        ) : null
      }
    >
      <Stack>
        <ErrorText>{error ?? notes.error}</ErrorText>

        {notes.loading ? (
          <p className="cq-muted">Loading notes…</p>
        ) : shown.length === 0 ? (
          <p className="cq-muted">
            {anchor ? 'No notes on this line yet.' : 'No notes on this project yet.'}
          </p>
        ) : (
          <ul className="cq-object-list">
            {shown.map((note) => (
              <li key={note.id}>
                <div className="cq-object-list__item">
                  <span>
                    <span className="cq-object-list__title">
                      {note.authorName}
                      <span className="cq-muted"> · {note.authorCompanyName}</span>
                      {note.authorCompanyId === companyId ? (
                        <>
                          {' '}
                          <Badge tone="neutral">You</Badge>
                        </>
                      ) : null}
                    </span>
                    <span className="cq-object-list__meta">{note.body}</span>
                    <span className="cq-object-list__meta">
                      {formatDateTime(note.createdAt)}
                      {!anchor ? ` · on ${lineLabel(note.entityType, note.entityId)}` : ''}
                    </span>
                  </span>
                  <span className="cq-row" style={{ gap: 8 }}>
                    {note.resolved ? <Badge tone="success">Resolved</Badge> : null}
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busyId === note.id}
                      onClick={() => void toggleResolved(note)}
                    >
                      {note.resolved ? 'Reopen' : 'Resolve'}
                    </Button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}

        {canComment ? (
          <form onSubmit={post} className="cq-stack" aria-busy={busy}>
            <Field
              label={anchor ? `Add a note on ${anchor.label}` : 'Add a note on this project'}
            >
              <Input
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={2000}
                placeholder="Ask a question or leave a comment"
              />
            </Field>
            <Row>
              <Button type="submit" disabled={busy || !body.trim()}>
                {busy ? 'Posting…' : 'Post note'}
              </Button>
            </Row>
          </form>
        ) : (
          <Notice>
            Commenting is not enabled on this engagement. You can read the thread, but only{' '}
            the contractor can add to it — that is their setting to change.
          </Notice>
        )}
      </Stack>
    </Section>
  );
}
