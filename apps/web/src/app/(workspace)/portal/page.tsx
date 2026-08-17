'use client';

import Link from 'next/link';
import type { PortalProjectView } from '@crewquo/shared';
import { EmptyState, ErrorText, PageHeader, Section, Stack, Table } from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';
import { ProjectStatusBadge } from '@/components/Status';
import { formatDate } from '@/lib/format';

/**
 * The client portal, from the client's side (§3.6).
 *
 * This is what a company sees about work being done *for* them: only projects where
 * they are the client on the engagement and the owner has published the project. The
 * gate is on the *owner's* plan, not the viewer's — a client on the free plan can
 * still be shown a portal by a contractor who pays for one.
 *
 * Nothing on these screens shows the owner's cost, their margin, their rate snapshots,
 * or which subcontractor did the work. That is structural rather than filtered: the
 * API returns distinct `Portal*` view types that have no such fields (§ portal.ts).
 */
export default function PortalPage() {
  return (
    <Shell>
      <Portal />
    </Shell>
  );
}

function Portal() {
  const ctx = useSessionCtx();
  const list = useAsyncList<PortalProjectView>(
    ctx ? () => api.portalProjects(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );

  return (
    <Stack>
      <PageHeader
        eyebrow="Client portal"
        title="Shared with me"
        description="Work other companies are doing for you, as they have chosen to publish it."
      />

      <Section className="cq-section--table">
        <ErrorText>{list.error}</ErrorText>
        {list.loading ? (
          <p className="cq-muted">Loading shared projects…</p>
        ) : list.items.length === 0 ? (
          <EmptyState title="Nothing shared with you yet">
            When a contractor you have hired publishes a project to their client portal, it
            appears here with its line items and the total you are being charged. If you are
            expecting something, ask them to publish it — visibility is theirs to grant.
          </EmptyState>
        ) : (
          <Table label="Projects shared with you">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Delivered by</th>
                <th scope="col">Status</th>
                <th scope="col">Dates</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((p) => (
                <tr key={p.id}>
                  <td className="cq-table__primary">
                    <Link href={`/portal/${p.id}`}>{p.name}</Link>
                  </td>
                  <td>{p.providerCompanyName}</td>
                  <td>
                    <ProjectStatusBadge status={p.status} />
                  </td>
                  <td>
                    {p.startsOn || p.endsOn ? (
                      <span className="cq-numeric">
                        {formatDate(p.startsOn)} to {formatDate(p.endsOn)}
                      </span>
                    ) : (
                      <span className="cq-muted">Not scheduled</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>
    </Stack>
  );
}
