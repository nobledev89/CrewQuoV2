'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AUDIT_ENTITY_TYPES, type AuditLogView, type EngagementView } from '@crewquo/shared';
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Notice,
  PageHeader,
  Row,
  Section,
  Select,
  Stack,
  Table,
} from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError, refusedFeature } from '@/api/client';
import { useAuth, useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';
import { useEntitlements } from '@/lib/useEntitlements';
import { FeatureLocked } from '@/components/FeatureLock';
import { formatAuditAction, formatDateTime } from '@/lib/format';

/**
 * Audit trail (§3.6) and the per-engagement settings that control what a client sees.
 *
 * Exposure is opt-in three times over, and the settings panel says so, because the
 * combination is genuinely surprising otherwise: the row must be flagged
 * `visible_to_client` when written, the *provider's* plan must include
 * `audit_visibility`, and that engagement must have `show_audit_trail` on. Turning the
 * switch on here does nothing unless the plan also allows it — so the panel reports the
 * plan state next to the switch rather than letting someone believe they have shared
 * something they have not.
 *
 * Only the provider side of an edge may change these settings, so the panel lists the
 * engagements where this company delivers, not the ones where it hires.
 */
export default function AuditPage() {
  return (
    <Shell>
      <Audit />
    </Shell>
  );
}

const PAGE_SIZE = 50;

function Audit() {
  const ctx = useSessionCtx();
  const ent = useEntitlements();

  const [entityType, setEntityType] = useState('ALL');
  const [rows, setRows] = useState<AuditLogView[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedFeature, setLockedFeature] = useState(false);

  const load = useCallback(
    async (before?: string) => {
      if (!ctx) return;
      const first = before === undefined;
      if (first) {
        setLoading(true);
        setError(null);
        setLockedFeature(false);
      } else {
        setLoadingMore(true);
      }
      try {
        const res = await api.listAuditLogs(ctx.accessToken, ctx.companyId, {
          entityType: entityType === 'ALL' ? undefined : entityType,
          limit: PAGE_SIZE,
          before,
        });
        setRows((prev) => (first ? res.data : [...prev, ...res.data]));
        setNextBefore(res.nextBefore);
      } catch (err) {
        if (refusedFeature(err) === 'audit_visibility') setLockedFeature(true);
        else setError(err instanceof ApiError ? err.message : 'Could not load the audit trail');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [ctx?.accessToken, ctx?.companyId, entityType]
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (lockedFeature) {
    return (
      <Stack>
        <PageHeader eyebrow="Company" title="Audit trail" />
        <FeatureLocked feature="audit_visibility" />
        <Notice>
          Your plan may still be <em>recording</em> the trail — retention and readability are
          separate settings. See <Link href="/plan">plan &amp; usage</Link> for the retention
          your plan keeps.
        </Notice>
        <PortalSettingsPanel />
      </Stack>
    );
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Company"
        title="Audit trail"
        description="An append-only record of what happened in this company. Nothing edits or deletes a row."
        actions={
          ent.usage('audit_retention_days') ? (
            <Badge tone="neutral">
              {ent.usage('audit_retention_days')?.value === null
                ? 'Kept indefinitely'
                : `Kept ${ent.usage('audit_retention_days')?.value} days`}
            </Badge>
          ) : null
        }
      />

      <Section className="cq-section--table">
        <div className="cq-table-toolbar">
          <Select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            aria-label="Filter by record type"
          >
            <option value="ALL">All record types</option>
            {AUDIT_ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {formatAuditAction(t.toLowerCase())}
              </option>
            ))}
          </Select>
          <span className="cq-table-toolbar__meta">
            {loading ? 'Loading…' : `${rows.length} ${rows.length === 1 ? 'event' : 'events'}`}
          </span>
        </div>

        <ErrorText>{error}</ErrorText>

        {loading ? (
          <p className="cq-muted">Loading the audit trail…</p>
        ) : rows.length === 0 ? (
          <EmptyState title="No events recorded">
            Activity is written here as work is submitted, approved, and projects change. If
            your plan keeps zero days of retention, nothing is written at all.
          </EmptyState>
        ) : (
          <>
            <Table label="Audit trail">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Event</th>
                  <th scope="col">Who</th>
                  <th scope="col">Detail</th>
                  <th scope="col">Shared</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="cq-table__primary cq-numeric">
                      {formatDateTime(row.createdAt)}
                    </td>
                    <td>{formatAuditAction(row.action)}</td>
                    <td>{row.actorName ?? <span className="cq-muted">System</span>}</td>
                    <td>{row.description ?? <span className="cq-muted">—</span>}</td>
                    <td>
                      {row.visibleToClient ? (
                        <Badge tone="accent">Client may see</Badge>
                      ) : (
                        <span className="cq-muted">Internal</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {nextBefore ? (
              <Row>
                <Button
                  variant="secondary"
                  disabled={loadingMore}
                  onClick={() => void load(nextBefore)}
                >
                  {loadingMore ? 'Loading…' : 'Load older events'}
                </Button>
              </Row>
            ) : (
              <p className="cq-muted">
                That is the whole trail this company still retains.
              </p>
            )}
          </>
        )}
      </Section>

      <PortalSettingsPanel />
    </Stack>
  );
}

// ── Per-engagement portal settings ─────────────────────────────────────────────

function PortalSettingsPanel() {
  const ctx = useSessionCtx();
  const ent = useEntitlements();
  const engagements = useAsyncList<EngagementView>(
    ctx ? () => api.listEngagements(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );

  // Only the provider side of an edge may change these — the side doing the work.
  const managed = engagements.items.filter((e) => e.side === 'provider');

  return (
    <Section
      title="What your clients can see"
      description="Per client relationship. Only the side delivering the work can change these."
      className="cq-section--table"
    >
      <ErrorText>{engagements.error}</ErrorText>
      {engagements.loading ? (
        <p className="cq-muted">Loading engagements…</p>
      ) : managed.length === 0 ? (
        <EmptyState title="No client relationships yet">
          These settings apply to companies that have hired you.{' '}
          <Link href="/network/clients">Add a client</Link> to give them portal access.
        </EmptyState>
      ) : (
        <Stack>
          {!ent.has('audit_visibility') && ent.data ? (
            <Notice>
              <strong>Your plan does not include a client-visible audit trail.</strong> The
              &ldquo;share activity&rdquo; switch below can be turned on, but clients will still
              see nothing until the plan includes <code>audit_visibility</code>. Commenting is
              unaffected.
            </Notice>
          ) : null}
          {managed.map((e) => (
            <EngagementSettings key={e.id} engagement={e} />
          ))}
        </Stack>
      )}
    </Section>
  );
}

function EngagementSettings({ engagement }: { engagement: EngagementView }) {
  const ctx = useSessionCtx();
  const { activeMembership } = useAuth();
  const canManage =
    activeMembership?.role === 'OWNER' ||
    activeMembership?.role === 'ADMIN' ||
    activeMembership?.role === 'MANAGER';

  const [canComment, setCanComment] = useState<boolean | null>(null);
  const [showTrail, setShowTrail] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ctx) return;
    let cancelled = false;
    setLoading(true);
    api
      .getAuditSettings(ctx.accessToken, ctx.companyId, engagement.id)
      .then((r) => {
        if (cancelled) return;
        setCanComment(r.settings.clientCanComment);
        setShowTrail(r.settings.showAuditTrail);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load settings');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ctx?.accessToken, ctx?.companyId, engagement.id]);

  async function update(patch: { clientCanComment?: boolean; showAuditTrail?: boolean }) {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.updateAuditSettings(ctx.accessToken, ctx.companyId, engagement.id, patch);
      setCanComment(r.settings.clientCanComment);
      setShowTrail(r.settings.showAuditTrail);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the setting');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cq-card">
      <Row between>
        <div>
          <div className="cq-h3">{engagement.clientCompanyName}</div>
          <div className="cq-muted">Client relationship</div>
        </div>
        {loading ? <span className="cq-muted">Loading…</span> : null}
      </Row>
      <ErrorText>{error}</ErrorText>
      {!loading ? (
        <Stack>
          <label className="cq-row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={canComment ?? false}
              disabled={!canManage || busy}
              onChange={(e) => void update({ clientCanComment: e.target.checked })}
            />
            <span>
              They can comment on line items
              <span className="cq-muted">
                {' '}
                — also needs the portal notes feature on your plan
              </span>
            </span>
          </label>
          <label className="cq-row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={showTrail ?? false}
              disabled={!canManage || busy}
              onChange={(e) => void update({ showAuditTrail: e.target.checked })}
            />
            <span>
              They can see shared activity
              <span className="cq-muted">
                {' '}
                — only rows already marked client-visible, never internal ones
              </span>
            </span>
          </label>
          {!canManage ? (
            <p className="cq-muted">A manager role is required to change these.</p>
          ) : null}
        </Stack>
      ) : null}
    </div>
  );
}
