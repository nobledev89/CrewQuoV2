'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { EngagementStatus, EngagementView } from '@crewquo/shared';
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  PageHeader,
  Row,
  Section,
  Stack,
  Table,
} from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useAuth, useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';
import { EngagementStatusBadge, SideBadge } from '@/components/Status';
import { formatDate } from '@/lib/format';

/**
 * Engagements — both sides of every edge the active company sits on (§3.2).
 *
 * The list deliberately shows one table with a "side" column rather than two
 * separate lists, because that is the model: an engagement is a directed edge, and
 * the same company can be a client on one and a provider on another. Splitting them
 * into "my clients" and "my subcontractors" screens (which also exist, for the
 * add-and-invite flows) would hide the fact that they are the same object.
 *
 * Creating an engagement here requires a company id, so the flow people actually
 * want — invite a subcontractor who is not on CrewQuo yet — lives on the
 * subcontractors screen, which creates the placeholder for them. This screen links
 * there rather than pretending a raw uuid field is a reasonable ask.
 */
export default function EngagementsPage() {
  return (
    <Shell>
      <Engagements />
    </Shell>
  );
}

function Engagements() {
  const ctx = useSessionCtx();
  const { activeMembership } = useAuth();
  const canManage =
    activeMembership?.role === 'OWNER' ||
    activeMembership?.role === 'ADMIN' ||
    activeMembership?.role === 'MANAGER';

  const list = useAsyncList<EngagementView>(
    ctx ? () => api.listEngagements(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(id: string, status: EngagementStatus) {
    if (!ctx) return;
    setBusyId(id);
    setError(null);
    try {
      await api.updateEngagement(ctx.accessToken, ctx.companyId, id, { status });
      list.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the engagement');
    } finally {
      setBusyId(null);
    }
  }

  const asClient = list.items.filter((e) => e.side === 'client');
  const asProvider = list.items.filter((e) => e.side === 'provider');

  return (
    <Stack>
      <PageHeader
        eyebrow="Network"
        title="Engagements"
        description="Every working relationship this company is part of — the ones you hire and the ones that hire you."
        actions={
          <Row>
            <Link className="cq-btn cq-btn--secondary cq-btn--sm" href="/network/providers">
              Add a subcontractor
            </Link>
            <Link className="cq-btn cq-btn--secondary cq-btn--sm" href="/network/clients">
              Add a client
            </Link>
          </Row>
        }
      />

      <div className="cq-metrics" aria-label="Engagement summary">
        <div className="cq-metric">
          <div className="cq-overline">You hire</div>
          <div className="cq-metric__value">{list.loading ? '—' : asClient.length}</div>
          <div className="cq-metric__context">Subcontractors delivering for you</div>
        </div>
        <div className="cq-metric">
          <div className="cq-overline">You deliver</div>
          <div className="cq-metric__value">{list.loading ? '—' : asProvider.length}</div>
          <div className="cq-metric__context">Clients you work for</div>
        </div>
        <div className="cq-metric">
          <div className="cq-overline">Awaiting acceptance</div>
          <div className="cq-metric__value">
            {list.loading ? '—' : list.items.filter((e) => e.status === 'PENDING').length}
          </div>
          <div className="cq-metric__context">Invitations not yet accepted</div>
        </div>
      </div>

      <Section
        title="All engagements"
        description="An engagement is visible only to its two endpoints — you never see past your own edge."
        className="cq-section--table"
      >
        <ErrorText>{error ?? list.error}</ErrorText>
        {list.loading ? (
          <p className="cq-muted">Loading engagements…</p>
        ) : list.items.length === 0 ? (
          <EmptyState title="No engagements yet">
            Add a subcontractor to have them deliver work for you, or add a client to give
            them portal access to what you deliver.
          </EmptyState>
        ) : (
          <Table label="Engagements">
            <thead>
              <tr>
                <th scope="col">Counterparty</th>
                <th scope="col">Your side</th>
                <th scope="col">Status</th>
                <th scope="col">Since</th>
                <th scope="col">
                  <span className="cq-table__actions">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((e) => {
                const counterpartyName =
                  e.side === 'client' ? e.providerCompanyName : e.clientCompanyName;
                // PENDING means nobody has accepted yet. `providerIsPlaceholder` cannot
                // stand in for that: claiming a placeholder on accept leaves the flag set.
                const awaitingAcceptance = e.status === 'PENDING';
                return (
                  <tr key={e.id}>
                    <td className="cq-table__primary">
                      {counterpartyName}
                      {awaitingAcceptance ? (
                        <>
                          {' '}
                          <Badge tone="neutral">Not accepted yet</Badge>
                        </>
                      ) : null}
                    </td>
                    <td>
                      <SideBadge side={e.side} />
                    </td>
                    <td>
                      <EngagementStatusBadge status={e.status} />
                    </td>
                    <td>{formatDate(e.createdAt.slice(0, 10))}</td>
                    <td className="cq-table__actions">
                      {!canManage ? (
                        <span className="cq-muted">Manager role required</span>
                      ) : e.status === 'ENDED' ? (
                        <span className="cq-muted">Ended</span>
                      ) : (
                        <Row>
                          {e.status === 'PAUSED' ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busyId === e.id}
                              onClick={() => void setStatus(e.id, 'ACTIVE')}
                            >
                              Resume
                            </Button>
                          ) : e.status === 'ACTIVE' ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busyId === e.id}
                              onClick={() => void setStatus(e.id, 'PAUSED')}
                            >
                              Pause
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busyId === e.id}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `End the engagement with ${counterpartyName}? Existing work and its history are kept, but no new work can be logged against it.`
                                )
                              ) {
                                void setStatus(e.id, 'ENDED');
                              }
                            }}
                          >
                            End
                          </Button>
                        </Row>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Section>
    </Stack>
  );
}
