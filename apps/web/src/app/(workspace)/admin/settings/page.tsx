'use client';

import { useEffect, useState } from 'react';
import type { AdminPlatformSettings } from '@crewquo/shared';
import { Button, EmptyState, ErrorText, Field, Input, Notice, PageHeader, Section, Stack } from '@crewquo/ui';
import { api, ApiError } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { AdminGate } from '@/components/admin/AdminGate';
import { Shell } from '@/components/Shell';
import { useAsyncData } from '@/lib/useAsyncData';

export default function AdminSettingsPage() { return <Shell><AdminGate title="Platform settings"><Settings /></AdminGate></Shell>; }

function Settings() {
  const { session } = useAuth();
  const settings = useAsyncData<AdminPlatformSettings>(session ? () => api.adminPlatformSettings(session.accessToken) : null, [session?.accessToken]);
  const [form, setForm] = useState<AdminPlatformSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (settings.data) setForm(settings.data); }, [settings.data]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!session || !form) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const next = await api.adminUpdatePlatformSettings(session.accessToken, form);
      setForm(next); setSaved(true); settings.reload();
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not save platform settings'); }
    finally { setBusy(false); }
  }

  if (settings.loading || !form) return <p className="cq-muted">Loading settings…</p>;
  if (settings.error) return <EmptyState title="Settings unavailable">{settings.error}</EmptyState>;
  return <Stack>
    <PageHeader eyebrow="CrewQuo Platform" title="Platform settings" description="Typed, auditable product controls. Credentials and API secrets never appear in this screen." />
    {saved ? <Notice>Platform settings saved and recorded in the platform audit trail.</Notice> : null}
    <form onSubmit={save}><Stack>
      <Section title="Identity and support"><div className="cq-form-grid">
        <Field label="Platform name"><Input value={form.platformName} onChange={(event) => setForm({ ...form, platformName: event.target.value })} required /></Field>
        <Field label="Support email"><Input type="email" value={form.supportEmail} onChange={(event) => setForm({ ...form, supportEmail: event.target.value })} placeholder="support@crewquo.com" /></Field>
      </div></Section>
      <Section title="Access"><Stack>
        <label className="cq-row"><input type="checkbox" checked={form.registrationOpen} onChange={(event) => setForm({ ...form, registrationOpen: event.target.checked })} /><span>Allow new customer registrations</span></label>
        <label className="cq-row"><input type="checkbox" checked={form.maintenanceMode} onChange={(event) => setForm({ ...form, maintenanceMode: event.target.checked })} /><span>Maintenance mode</span></label>
        <Field label="Maintenance message"><Input value={form.maintenanceMessage} onChange={(event) => setForm({ ...form, maintenanceMessage: event.target.value })} maxLength={500} placeholder="Shown when maintenance mode is enabled" /></Field>
      </Stack></Section>
      <Notice>These values establish the administrative control plane. Customer registration and maintenance enforcement should read these settings when those launch gates are connected.</Notice>
      <ErrorText>{error}</ErrorText><div><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save platform settings'}</Button></div>
    </Stack></form>
  </Stack>;
}

