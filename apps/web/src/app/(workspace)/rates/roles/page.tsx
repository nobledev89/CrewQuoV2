'use client';

import { useMemo, useState } from 'react';
import type { RoleCatalogView } from '@crewquo/shared';
import { Button, Drawer, EmptyState, ErrorText, Field, Input, PageHeader, SearchInput, Section, SortableTh, Stack, Table } from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';
import { useSort } from '@/lib/useSort';
import { useUrlQuery } from '@/lib/useUrlQuery';

/**
 * The role catalog (§6): the job functions rate cards match on.
 *
 * Creating a role happens in a side panel rather than in a form pinned above the table
 * (§40). An always-open create form spent more of the screen than the catalog it adds
 * to, which put the data it produces below the fold.
 */
export default function RolesPage() {
  return <Shell><Roles /></Shell>;
}

const SORTS = {
  name: (r: RoleCatalogView) => r.name,
  created: (r: RoleCatalogView) => r.createdAt,
};

function Roles() {
  const ctx = useSessionCtx();
  const { items, loading, error, reload } = useAsyncList<RoleCatalogView>(
    ctx ? () => api.listRoles(ctx.accessToken, ctx.companyId).then((response) => response.data) : null,
    [ctx?.companyId]
  );
  const [name, setName] = useState('');
  const [query, setQuery] = useUrlQuery();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const { sort, onSort, apply } = useSort<RoleCatalogView>(SORTS, { key: 'name', direction: 'asc' });

  const filtered = useMemo(
    () => apply(items.filter((role) => role.name.toLowerCase().includes(query.trim().toLowerCase()))),
    [items, query, apply]
  );

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!ctx) return;
    setBusy(true);
    setFormError(null);
    try {
      await api.createRole(ctx.accessToken, ctx.companyId, { name: name.trim() });
      setName('');
      setOpen(false);
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
      <PageHeader
        eyebrow="Rates"
        title="Roles"
        description="The job functions used to match contractor pay and client bill rates."
        actions={<Button onClick={() => setOpen(true)}>New role</Button>}
      />

      <Section className="cq-section--table">
        <div className="cq-table-toolbar">
          <SearchInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search roles…" aria-label="Search roles" />
          <span className="cq-table-toolbar__meta cq-numeric">{filtered.length} of {items.length}</span>
        </div>
        {/* Errors from a row action surface here, since the drawer that raised them is shut. */}
        {!open && formError ? <div style={{ padding: '10px 14px' }}><ErrorText>{formError}</ErrorText></div> : null}
        {loading ? (
          <div className="cq-empty"><p className="cq-empty__copy" role="status">Loading roles…</p></div>
        ) : error ? (
          <div className="cq-empty"><ErrorText>{error}</ErrorText></div>
        ) : filtered.length === 0 ? (
          <EmptyState title={items.length === 0 ? 'No roles yet' : 'No roles found'}>
            {items.length === 0 ? 'Add your first role to start building rate cards.' : 'Try a different search term.'}
          </EmptyState>
        ) : (
          <Table label="Role catalog" compact>
            <thead>
              <tr>
                <SortableTh label="Role name" sortKey="name" sort={sort} onSort={onSort} />
                <SortableTh label="Created" sortKey="created" sort={sort} onSort={onSort} numeric />
                <th scope="col" className="cq-table__actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((role) => (
                <tr key={role.id}>
                  <td className="cq-table__primary">{role.name}</td>
                  <td className="cq-muted cq-numeric">
                    {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(role.createdAt))}
                  </td>
                  <td className="cq-table__actions">
                    <Button variant="danger" size="sm" onClick={() => void remove(role)} aria-label={`Delete ${role.name}`}>Delete</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      <Drawer
        open={open}
        title="Add role"
        description="Use a clear operational job title. Roles are reused across rate cards."
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button type="submit" form="add-role" disabled={busy || !name.trim()}>{busy ? 'Adding…' : 'Add role'}</Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          </>
        }
      >
        <form id="add-role" onSubmit={create} className="cq-stack">
          <Field label="Role name">
            <Input name="role-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Lighting technician…" required autoFocus />
          </Field>
          <ErrorText>{formError}</ErrorText>
        </form>
      </Drawer>
    </Stack>
  );
}
