'use client';

import { useMemo, useState } from 'react';
import type { RoleCatalogView } from '@crewquo/shared';
import { Button, EmptyState, ErrorText, Field, Input, PageHeader, SearchInput, Section, Stack, Table } from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';
import { useUrlQuery } from '@/lib/useUrlQuery';

export default function RolesPage() {
  return <Shell><Roles /></Shell>;
}

function Roles() {
  const ctx = useSessionCtx();
  const { items, loading, error, reload } = useAsyncList<RoleCatalogView>(ctx ? () => api.listRoles(ctx.accessToken, ctx.companyId).then((response) => response.data) : null, [ctx?.companyId]);
  const [name, setName] = useState('');
  const [query, setQuery] = useUrlQuery();
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const filtered = useMemo(() => items.filter((role) => role.name.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => a.name.localeCompare(b.name)), [items, query]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!ctx) return;
    setBusy(true);
    setFormError(null);
    try {
      await api.createRole(ctx.accessToken, ctx.companyId, { name: name.trim() });
      setName('');
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'We could not add this role. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(role: RoleCatalogView) {
    if (!ctx || !window.confirm(`Delete “${role.name}”? Rate cards may still refer to this role.`)) return;
    try {
      await api.deleteRole(ctx.accessToken, ctx.companyId, role.id);
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'We could not delete this role. Try again.');
    }
  }

  return (
    <Stack>
      <PageHeader eyebrow="Rate management" title="Roles" description="Maintain the job functions used to match contractor pay and client bill rates." />

      <Section title="Add role" description="Use a clear operational job title. Roles can be reused across rate cards.">
        <form onSubmit={create}>
          <div className="cq-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 260px', maxWidth: 520 }}><Field label="Role name"><Input name="role-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Lighting technician…" required /></Field></div>
            <Button type="submit" disabled={busy}>{busy ? 'Adding role…' : 'Add role'}</Button>
          </div>
          {formError ? <div style={{ marginTop: 12 }}><ErrorText>{formError}</ErrorText></div> : null}
        </form>
      </Section>

      <Section title="Role catalog" description="Sorted alphabetically" className="cq-section--table">
        <div className="cq-table-toolbar">
          <SearchInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search roles…" aria-label="Search roles" />
          <span className="cq-table-toolbar__meta cq-numeric">{filtered.length} of {items.length}</span>
        </div>
        {loading ? <div className="cq-empty"><p className="cq-empty__copy" role="status">Loading roles…</p></div> : error ? <div className="cq-empty"><ErrorText>{error}</ErrorText></div> : filtered.length === 0 ? <EmptyState title={items.length === 0 ? 'No roles yet' : 'No roles found'}>{items.length === 0 ? 'Add your first role above to start building rate cards.' : 'Try a different search term.'}</EmptyState> : (
          <Table label="Role catalog">
            <thead><tr><th scope="col">Role name</th><th scope="col">Created</th><th scope="col" className="cq-table__actions">Actions</th></tr></thead>
            <tbody>{filtered.map((role) => <tr key={role.id}><td className="cq-table__primary">{role.name}</td><td className="cq-muted cq-numeric">{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(role.createdAt))}</td><td className="cq-table__actions"><Button variant="danger" size="sm" onClick={() => void remove(role)} aria-label={`Delete ${role.name}`}>Delete</Button></td></tr>)}</tbody>
          </Table>
        )}
      </Section>
    </Stack>
  );
}
