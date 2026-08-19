'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FxRateView } from '@crewquo/shared';
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Notice,
  Row,
  Section,
  Stack,
  Table,
} from '@crewquo/ui';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';

/**
 * Recorded exchange rates (§3.3 decision #5).
 * Operating-model packet: `docs/operating-model/money-boundary.md`.
 *
 * This screen exists because CrewQuo holds no exchange rate and will not fetch
 * one: a converted figure has to be able to name the human who stood behind its
 * rate. Two consequences are visible in the markup rather than buried in a
 * comment —
 *
 *  - **Source is a required field**, not an optional note. A rate with no stated
 *    origin is indistinguishable from an invented one, which is what §41.1
 *    forbids.
 *  - **There is no edit control, ever.** A correction is a new rate at a later
 *    date, so both stay visible and no figure that already cited the old one
 *    moves behind anyone's back. Delete exists only while nothing cites it, and
 *    the button says why when it is disabled.
 */
export function FxRates({
  canEdit,
  companyCurrency,
}: {
  canEdit: boolean;
  companyCurrency: string | null;
}) {
  const ctx = useSessionCtx();
  const [rates, setRates] = useState<FxRateView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [base, setBase] = useState('');
  const [quote, setQuote] = useState('');
  const [rate, setRate] = useState('');
  const [asOf, setAsOf] = useState('');
  const [source, setSource] = useState('');

  const load = useCallback(async () => {
    if (!ctx) return;
    setLoading(true);
    try {
      const { data } = await api.listFxRates(ctx.accessToken, ctx.companyId);
      setRates(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load exchange rates');
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  useEffect(() => {
    void load();
  }, [load]);

  // The company's own currency is the overwhelmingly common target, so it is
  // prefilled — but left editable, because a project may report in something else.
  useEffect(() => {
    if (companyCurrency && quote === '') setQuote(companyCurrency);
  }, [companyCurrency, quote]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await api.createFxRate(ctx.accessToken, ctx.companyId, {
        baseCurrency: base.toUpperCase(),
        quoteCurrency: quote.toUpperCase(),
        rate: rate.trim(),
        asOf,
        source: source.trim(),
      });
      setBase('');
      setRate('');
      setSource('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the rate');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteFxRate(ctx.accessToken, ctx.companyId, id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the rate');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Exchange rates"
      description="Only needed when you pay or charge in a currency a project does not report in. CrewQuo never estimates a rate — a figure with no rate is left out and named, not guessed."
    >
      <Stack>
        {canEdit ? (
          <form onSubmit={add}>
            <Stack>
              <div className="cq-form-grid">
                <Field label="From (ISO 4217)" hint="The currency being converted, e.g. GBP.">
                  <Input
                    name="fx-base"
                    value={base}
                    onChange={(e) => setBase(e.target.value.toUpperCase().slice(0, 3))}
                    maxLength={3}
                    disabled={busy}
                    required
                  />
                </Field>
                <Field label="To (ISO 4217)" hint="The currency being reported in.">
                  <Input
                    name="fx-quote"
                    value={quote}
                    onChange={(e) => setQuote(e.target.value.toUpperCase().slice(0, 3))}
                    maxLength={3}
                    disabled={busy}
                    required
                  />
                </Field>
                <Field label="Rate" hint={`One ${base || 'FROM'} is worth this many ${quote || 'TO'}.`}>
                  <Input
                    name="fx-rate"
                    inputMode="decimal"
                    value={rate}
                    onChange={(e) => setRate(e.target.value)}
                    placeholder="1.2700"
                    disabled={busy}
                    required
                  />
                </Field>
                <Field label="As of" hint="Applies to money dated on or after this day.">
                  <Input
                    name="fx-as-of"
                    type="date"
                    value={asOf}
                    onChange={(e) => setAsOf(e.target.value)}
                    disabled={busy}
                    required
                  />
                </Field>
                <Field
                  label="Source"
                  hint="Where the number came from. Required: a rate with no origin cannot be told apart from a guess."
                >
                  <Input
                    name="fx-source"
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    placeholder="ECB reference rate"
                    disabled={busy}
                    required
                  />
                </Field>
              </div>
              <Row>
                <Button type="submit" disabled={busy}>
                  {busy ? 'Recording…' : 'Record rate'}
                </Button>
                <ErrorText>{error}</ErrorText>
              </Row>
            </Stack>
          </form>
        ) : (
          <Notice>Only an owner or admin can record an exchange rate.</Notice>
        )}

        {loading ? (
          <p className="cq-muted">Loading…</p>
        ) : rates.length === 0 ? (
          <EmptyState title="No exchange rates recorded">
            You only need one if a rate card uses a currency a project does not report in. Most
            companies never do.
          </EmptyState>
        ) : (
          <Table label="Recorded exchange rates">
            <thead>
              <tr>
                <th>Pair</th>
                <th className="cq-num">Rate</th>
                <th>As of</th>
                <th>Source</th>
                <th>Used by</th>
                {canEdit ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {rates.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.baseCurrency} to {r.quoteCurrency}
                  </td>
                  <td className="cq-num">{r.rate}</td>
                  <td>{r.asOf}</td>
                  <td>{r.source}</td>
                  <td>
                    {r.citationCount === 0 ? (
                      <span className="cq-muted">not yet used</span>
                    ) : (
                      <Badge>
                        {r.citationCount} figure{r.citationCount === 1 ? '' : 's'}
                      </Badge>
                    )}
                  </td>
                  {canEdit ? (
                    <td>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy || r.citationCount > 0}
                        title={
                          r.citationCount > 0
                            ? 'Committed figures cite this rate. Record a corrected rate at a later date instead.'
                            : undefined
                        }
                        onClick={() => void remove(r.id)}
                      >
                        Delete
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Stack>
    </Section>
  );
}
