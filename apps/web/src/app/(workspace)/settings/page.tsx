'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CompanySummary } from '@crewquo/shared';
import { Badge, Button, ErrorText, Field, Input, Notice, PageHeader, Row, Section, Stack } from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useAuth, useSessionCtx } from '@/auth/AuthProvider';

/**
 * Company settings — the web surface for `PATCH /v1/companies/:id`.
 *
 * Currency is the reason this screen exists: the owner decision was "USD by
 * default, **user-changeable**", and a setting that only an API caller can change
 * isn't user-changeable. OWNER/ADMIN only, matching the endpoint.
 */
export default function SettingsPage() {
  return (
    <Shell>
      <Settings />
    </Shell>
  );
}

/**
 * Every zone the runtime knows, or a short fallback on browsers without
 * `supportedValuesOf`. Deliberately not a curated list: a bundled one goes stale
 * whenever a country changes its rules, and the server validates against
 * Postgres's own list regardless.
 */
function timeZoneOptions(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

function Settings() {
  const ctx = useSessionCtx();
  const { activeMembership, refreshMemberships } = useAuth();
  const canEdit = activeMembership?.role === 'OWNER' || activeMembership?.role === 'ADMIN';

  const [company, setCompany] = useState<CompanySummary | null>(null);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('');
  const [timeZone, setTimeZone] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!ctx) return;
    setLoading(true);
    setError(null);
    try {
      const { company: loaded } = await api.getCompany(ctx.accessToken, ctx.companyId);
      setCompany(loaded);
      setName(loaded.name);
      setCurrency(loaded.currency);
      setTimeZone(loaded.timeZone);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load company settings');
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty =
    company !== null &&
    (name.trim() !== company.name ||
      currency.toUpperCase() !== company.currency ||
      timeZone !== company.timeZone);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx || !company) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // Send only what changed: the endpoint rejects an empty patch, and sending
      // an unchanged currency would still write an audit row saying it moved.
      const { company: updated } = await api.updateCompany(ctx.accessToken, ctx.companyId, {
        ...(name.trim() !== company.name ? { name: name.trim() } : {}),
        ...(currency.toUpperCase() !== company.currency ? { currency: currency.toUpperCase() } : {}),
        ...(timeZone !== company.timeZone ? { timeZone } : {}),
      });
      setCompany(updated);
      setName(updated.name);
      setCurrency(updated.currency);
      setTimeZone(updated.timeZone);
      setSaved(true);
      // The switcher and every money label read the company name/currency.
      await refreshMemberships();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save company settings');
    } finally {
      setBusy(false);
    }
  }

  const timeZoneChanging =
    company !== null && timeZone !== company.timeZone && timeZone.trim() !== '';

  const currencyChanging =
    company !== null && currency.toUpperCase() !== company.currency && /^[A-Za-z]{3}$/.test(currency);

  return (
    <Stack>
      <PageHeader
        eyebrow="Company"
        title="Settings"
        description="The company name and the currency every rate card, cost and export is denominated in."
      />

      {!canEdit ? (
        <Notice>
          Only an owner or admin can change these settings. You can see the current values below.
        </Notice>
      ) : null}

      <Section title="Company" description="Rate cards inherit this currency unless they declare their own.">
        {loading ? (
          <p className="cq-muted">Loading…</p>
        ) : (
          <form onSubmit={save}>
            <Stack>
              <div className="cq-form-grid">
                <Field label="Company name">
                  <Input
                    name="company-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={!canEdit || busy}
                    required
                  />
                </Field>
                <Field
                  label="Currency (ISO 4217)"
                  hint="Three letters, e.g. USD, GBP, PHP."
                >
                  <Input
                    name="company-currency"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
                    disabled={!canEdit || busy}
                    maxLength={3}
                    required
                  />
                </Field>
                <Field
                  label="Time zone"
                  hint="Decides what “today” means here — reporting periods, and whether an agreed rate counts as back-dated."
                >
                  <Input
                    name="company-time-zone"
                    list="cq-time-zones"
                    value={timeZone}
                    onChange={(e) => setTimeZone(e.target.value)}
                    disabled={!canEdit || busy}
                    required
                  />
                </Field>
              </div>

              {/*
                * The browser's own IANA list rather than a hard-coded one: a
                * bundled list goes stale every time a country changes its rules,
                * and the server validates against Postgres's list anyway, so a
                * second copy here could only ever disagree with both.
                */}
              <datalist id="cq-time-zones">
                {timeZoneOptions().map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>

              {timeZoneChanging ? (
                <Notice>
                  Changing the time zone to <strong>{timeZone}</strong> changes what “today”
                  means from now on. <strong>Nothing already recorded moves</strong> — every
                  work date, rate start and timestamp stays exactly as it is.
                </Notice>
              ) : null}

              {currencyChanging ? (
                <Notice>
                  Changing the currency to <strong>{currency.toUpperCase()}</strong> re-labels the
                  figures that inherit it — rate cards without a currency of their own, and any
                  project created from now on. Amounts are not converted, so a rate of{' '}
                  {company?.currency} 50.00 becomes {currency.toUpperCase()} 50.00.{' '}
                  <strong>Projects that already exist keep reporting in the currency they were
                  created with</strong>, so nothing already costed is restated. The change is
                  recorded in the audit trail.
                </Notice>
              ) : null}

              <Row>
                <Button type="submit" disabled={!canEdit || busy || !dirty}>
                  {busy ? 'Saving…' : 'Save changes'}
                </Button>
                {saved && !dirty ? <Badge tone="success">Saved</Badge> : null}
                <ErrorText>{error}</ErrorText>
              </Row>
            </Stack>
          </form>
        )}
      </Section>


    </Stack>
  );
}
