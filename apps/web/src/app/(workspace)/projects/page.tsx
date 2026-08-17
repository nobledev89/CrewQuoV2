'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PROJECT_STATUSES, type ClientView, type ProjectStatus, type ProjectView } from '@crewquo/shared';
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
  SearchInput,
  Section,
  Select,
  Stack,
  Table,
} from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useAuth, useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';
import { ProjectStatusBadge } from '@/components/Status';
import { formatDate } from '@/lib/format';

/**
 * Projects owned by the active company (§3.4). `GET /v1/projects` is scoped to
 * `owner_company_id`, so this is "work we run", not "work we were assigned" — a
 * subcontractor's view of the same relationship is the Log work screen, which reads
 * `/v1/work-context`. Keeping those separate is deliberate: they are different sides
 * of an engagement and conflating them is how the v1 client model went wrong.
 */
export default function ProjectsPage() {
  return (
    <Shell>
      <Projects />
    </Shell>
  );
}

function Projects() {
  const ctx = useSessionCtx();
  const router = useRouter();
  const { activeMembership } = useAuth();
  const canManage =
    activeMembership?.role === 'OWNER' ||
    activeMembership?.role === 'ADMIN' ||
    activeMembership?.role === 'MANAGER';

  const list = useAsyncList<ProjectView>(
    ctx ? () => api.listProjects(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );
  // Clients are needed to attach a project to an engagement at creation time.
  const clients = useAsyncList<ClientView>(
    ctx ? () => api.listClients(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | 'ALL'>('ALL');
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return list.items.filter((p) => {
      if (statusFilter !== 'ALL' && p.status !== statusFilter) return false;
      if (!needle) return true;
      return (
        p.name.toLowerCase().includes(needle) ||
        (p.clientCompanyName?.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [list.items, search, statusFilter]);

  return (
    <Stack>
      <PageHeader
        eyebrow="Delivery"
        title="Projects"
        description="Work this company runs and keeps its own books on."
        actions={
          canManage && !open ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              New project
            </Button>
          ) : null
        }
      />

      {open ? (
        <NewProject
          clients={clients.items}
          onCancel={() => setOpen(false)}
          onCreated={(project) => {
            setOpen(false);
            router.push(`/projects/${project.id}`);
          }}
        />
      ) : null}

      <Section className="cq-section--table">
        <div className="cq-table-toolbar">
          <SearchInput
            placeholder="Search by project or client"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search projects"
          />
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as ProjectStatus | 'ALL')}
            aria-label="Filter by status"
          >
            <option value="ALL">All statuses</option>
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
          <span className="cq-table-toolbar__meta">
            {list.loading
              ? 'Loading…'
              : `${filtered.length} of ${list.items.length} ${list.items.length === 1 ? 'project' : 'projects'}`}
          </span>
        </div>

        <ErrorText>{list.error}</ErrorText>

        {list.loading ? (
          <p className="cq-muted">Loading projects…</p>
        ) : list.items.length === 0 ? (
          <EmptyState title="No projects yet">
            Create a project, assign a subcontractor to it, and their crew can start logging
            time against it.
          </EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState title="Nothing matches those filters">
            Clear the search or choose a different status.
          </EmptyState>
        ) : (
          <Table label="Projects">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Client</th>
                <th scope="col">Status</th>
                <th scope="col">Dates</th>
                <th scope="col">Portal</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id}>
                  <td className="cq-table__primary">
                    <Link href={`/projects/${p.id}`}>{p.name}</Link>
                  </td>
                  <td>{p.clientCompanyName ?? <span className="cq-muted">Internal</span>}</td>
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
                  <td>
                    {p.clientVisible ? (
                      <Badge tone="accent">Shared</Badge>
                    ) : (
                      <span className="cq-muted">Private</span>
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

function NewProject({
  clients,
  onCancel,
  onCreated,
}: {
  clients: ClientView[];
  onCancel: () => void;
  onCreated: (project: ProjectView) => void;
}) {
  const ctx = useSessionCtx();
  const [name, setName] = useState('');
  const [clientEngagement, setClientEngagement] = useState('');
  const [status, setStatus] = useState<ProjectStatus>('ACTIVE');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [clientVisible, setClientVisible] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = clients.find((c) => c.engagementId === clientEngagement) ?? null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.createProject(ctx.accessToken, ctx.companyId, {
        name: name.trim(),
        // A project's client and its engagement travel together: the edge is what the
        // portal reads, so setting one without the other would publish to nobody.
        clientCompanyId: selected?.clientCompanyId ?? null,
        engagementId: selected?.engagementId ?? null,
        status,
        clientVisible: selected ? clientVisible : false,
        startsOn: startsOn || null,
        endsOn: endsOn || null,
        notes: notes.trim() || null,
      });
      onCreated(project);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the project');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="New project"
      description="A client is optional — a project with none is internal work you still cost and bill nobody for."
    >
      <form onSubmit={submit} className="cq-stack" aria-busy={busy}>
        <div className="cq-form-grid">
          <Field label="Project name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
          <Field label="Client" hint={clients.length === 0 ? 'No clients yet — add one under Network.' : undefined}>
            {/*
              An explicit `aria-label`, because `Field` wraps its child in a `<label>`
              and a wrapping label's text content includes the select's own selected
              option — so the computed accessible name comes out as "ClientInternal (no
              client)" and collides with the portal checkbox below. Naming the control
              directly fixes both the screen-reader announcement and the ambiguity.
            */}
            <Select
              aria-label="Client company"
              value={clientEngagement}
              onChange={(e) => setClientEngagement(e.target.value)}
              disabled={clients.length === 0}
            >
              <option value="">Internal (no client)</option>
              {clients.map((c) => (
                <option key={c.engagementId} value={c.engagementId}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select
              aria-label="Project status"
              value={status}
              onChange={(e) => setStatus(e.target.value as ProjectStatus)}
            >
              {PROJECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.charAt(0) + s.slice(1).toLowerCase()}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Starts on">
            <Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </Field>
          <Field label="Ends on">
            <Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </Field>
        </div>

        <Field label="Notes">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </Field>

        <label className="cq-row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={clientVisible}
            disabled={!selected}
            onChange={(e) => setClientVisible(e.target.checked)}
          />
          <span>
            Publish to the client portal
            {!selected ? <span className="cq-muted"> — needs a client</span> : null}
          </span>
        </label>

        {clientVisible && selected ? (
          <Notice>
            <strong>{selected.name}</strong> will see this project, its line items and the
            total charged at your BILL rates. They never see what you pay a subcontractor, the
            rate snapshots, or which subcontractor did the work.
          </Notice>
        ) : null}

        <ErrorText>{error}</ErrorText>
        <Row>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create project'}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </Row>
      </form>
    </Section>
  );
}
