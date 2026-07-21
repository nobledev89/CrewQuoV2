'use client';

import { useState } from 'react';
import type { RoleCatalogView } from '@crewquo/shared';
import { Button, Card, ErrorText, Field, Input, Row, Stack, Table } from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';

export default function RolesPage() {
  return (
    <Shell>
      <Roles />
    </Shell>
  );
}

function Roles() {
  const ctx = useSessionCtx();
  const { items, loading, error, reload } = useAsyncList<RoleCatalogView>(
    ctx ? () => api.listRoles(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx) return;
    setBusy(true);
    setFormError(null);
    try {
      await api.createRole(ctx.accessToken, ctx.companyId, { name });
      setName('');
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to create role');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!ctx) return;
    try {
      await api.deleteRole(ctx.accessToken, ctx.companyId, id);
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to delete role');
    }
  }

  return (
    <Stack style={{ paddingTop: 24 }}>
      <h1 className="cq-h1">Roles</h1>

      <Card>
        <form onSubmit={create}>
          <Row style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <Field label="New role name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Rigger"
                  required
                />
              </Field>
            </div>
            <Button type="submit" disabled={busy || name.trim() === ''}>
              {busy ? 'Adding…' : 'Add role'}
            </Button>
          </Row>
        </form>
        <ErrorText>{formError}</ErrorText>
      </Card>

      {loading ? (
        <p className="cq-muted">Loading…</p>
      ) : error ? (
        <ErrorText>{error}</ErrorText>
      ) : items.length === 0 ? (
        <div className="cq-notice">No roles yet. Add one above to start building rate cards.</div>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Created</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {items.map((role) => (
              <tr key={role.id}>
                <td>{role.name}</td>
                <td className="cq-muted">{new Date(role.createdAt).toLocaleDateString()}</td>
                <td style={{ textAlign: 'right' }}>
                  <Button variant="danger" size="sm" onClick={() => void remove(role.id)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Stack>
  );
}
