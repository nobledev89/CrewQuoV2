'use client';

import { useState } from 'react';
import { Button, ErrorText, Notice, Row, Section, Stack } from '@crewquo/ui';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';

/**
 * The "take your data with you" panel, on both the profile and the company settings
 * screen (packet §14 step 5).
 *
 * **No entitlement gate, and no upgrade prompt.** §13.2 was answered "free for everyone,
 * including the free `crew` plan": a person's own data is a legal obligation and charging
 * for an obligation makes it an upsell, and a company export somebody must upgrade to get
 * is a hostage rather than a feature. If a later edit adds a gate here it is reversing a
 * decision, not tightening a screw.
 *
 * The file is fetched with the auth headers and handed to the browser as a blob, for the
 * same reason the project export is: a bare `<a href>` cannot carry `Authorization` or
 * `X-Company-Id`, and this endpoint deliberately has no link form — the bundle is
 * generated per request under authorization rather than parked behind a URL that whoever
 * holds it can fetch.
 */
export function DataExportPanel({ scope }: { scope: 'personal' | 'company' }) {
  const ctx = useSessionCtx();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      const blob =
        scope === 'personal'
          ? await api.exportMyData(ctx.accessToken)
          : await api.exportCompanyData(ctx.accessToken, ctx.companyId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const day = new Date().toISOString().slice(0, 10);
      a.download = `crewquo-${scope}-export-${day}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not produce the export');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title={scope === 'personal' ? 'Your data' : 'Company data'}
      description={
        scope === 'personal'
          ? 'A copy of everything this account holds, to keep or to take elsewhere.'
          : "A copy of this company's commercial record — projects, hours, rates, invoices and the audit trail."
      }
    >
      <Stack>
        <Notice>
          A ZIP holding one JSON and one CSV per table, plus a <strong>manifest</strong> naming
          every table, why it is included, and any column deliberately left out with the reason.
          Machine-readable on purpose: it can be re-imported, re-checked and diffed, which a PDF
          cannot.{' '}
          {scope === 'personal' ? (
            <>
              Your hours are here; the <strong>rate</strong> attached to them is not — that is a
              commercial term between two companies rather than a fact about you.
            </>
          ) : (
            <>Amounts are integer minor units of {'this company\u2019s'} currency, unconverted.</>
          )}
        </Notice>
        <Row>
          <Button onClick={() => void run()} disabled={busy}>
            {busy ? 'Preparing\u2026' : 'Download my data'}
          </Button>
          <ErrorText>{error}</ErrorText>
        </Row>
      </Stack>
    </Section>
  );
}
