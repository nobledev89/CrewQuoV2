'use client';

import { useState } from 'react';
import {
  FEATURE_KEYS,
  LIMIT_KEYS,
  PLAN_STATUSES,
  PRICE_INTERVALS,
  type AdminPlanView,
  type FeatureKey,
  type LimitKey,
  type PlanStatus,
  type PriceInterval,
} from '@crewquo/shared';
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
  Section,
  Select,
  Stack,
  Table,
} from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { useAsyncData } from '@/lib/useAsyncData';
import { centsToInput, formatCents, inputToCents, titleCase } from '@/lib/format';

/**
 * Super-admin plan console (§5B). Plans are data, not code: the feature matrix, the
 * limit matrix and the prices are all editable here without a deploy, and every save
 * clears the entitlement cache server-side so gates re-resolve immediately.
 *
 * `null` limit = unlimited, `0` = none allowed. Those are opposite meanings on the same
 * column, so the editor uses an explicit "Unlimited" toggle rather than asking someone
 * to leave a number field blank and hope.
 *
 * Per-*company* support — live usage, entitlement overrides, comped trials and forced
 * plan changes — is a separate screen (`/admin/companies`), because it is a different
 * act: editing a plan here changes what every subscriber to it can do.
 */
export default function AdminPlansPage() {
  return (
    <Shell>
      <AdminPlans />
    </Shell>
  );
}

function AdminPlans() {
  const { session } = useAuth();
  const token = session?.accessToken ?? null;

  const plans = useAsyncData<AdminPlanView[]>(
    token ? () => api.adminListPlans(token).then((r) => r.plans) : null,
    [token]
  );

  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  if (!session?.user.isSuperAdmin) {
    return (
      <Stack>
        <PageHeader eyebrow="Platform" title="Plans" />
        <EmptyState title="Platform staff only">
          The plan console is limited to CrewQuo platform staff. Your own plan and usage are
          under <a href="/plan">plan &amp; usage</a>.
        </EmptyState>
      </Stack>
    );
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Platform"
        title="Plans"
        description="The entitlement catalog every company resolves against. Editing takes effect immediately."
        actions={
          creating ? null : (
            <Button size="sm" onClick={() => setCreating(true)}>
              New plan
            </Button>
          )
        }
      />

      <Notice>
        A plan edit affects companies that resolve entitlements live. Grandfathering is
        snapshot-based and lands with Phase 5 billing, so today an edit to an active plan
        changes what its current subscribers can do.
      </Notice>

      {creating && token ? (
        <PlanEditor
          token={token}
          plan={null}
          onDone={() => {
            setCreating(false);
            plans.reload();
          }}
          onCancel={() => setCreating(false)}
        />
      ) : null}

      <ErrorText>{plans.error}</ErrorText>

      {plans.loading ? (
        <p className="cq-muted">Loading plans…</p>
      ) : !plans.data || plans.data.length === 0 ? (
        <EmptyState title="No plans defined">
          Create one, or run the seed to install the default Crew / Starter / Pro / Business /
          Enterprise set.
        </EmptyState>
      ) : (
        plans.data.map((plan) =>
          editing === plan.id && token ? (
            <PlanEditor
              key={plan.id}
              token={token}
              plan={plan}
              onDone={() => {
                setEditing(null);
                plans.reload();
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <PlanCard
              key={plan.id}
              plan={plan}
              onEdit={() => setEditing(plan.id)}
              token={token}
              onPriceSaved={() => plans.reload()}
            />
          )
        )
      )}

      <Section title="Per-company support actions">
        <Stack>
          <p className="cq-muted">
            Live usage against limits, per-company entitlement overrides, comped trials and
            forced plan changes are on <a href="/admin/companies">companies</a>. Editing a plan
            here changes it for everyone who resolves against it; those are the levers for one
            account at a time.
          </p>
        </Stack>
      </Section>
    </Stack>
  );
}

// ── Read view ──────────────────────────────────────────────────────────────────

function PlanCard({
  plan,
  onEdit,
  token,
  onPriceSaved,
}: {
  plan: AdminPlanView;
  onEdit: () => void;
  token: string | null;
  onPriceSaved: () => void;
}) {
  return (
    <Section
      title={plan.name}
      description={plan.description ?? undefined}
      className="cq-section--table"
      actions={
        <Row>
          <Badge tone={plan.status === 'ACTIVE' ? 'success' : plan.status === 'DRAFT' ? 'warning' : 'neutral'}>
            {titleCase(plan.status)}
          </Badge>
          {plan.isPublic ? <Badge tone="accent">Public</Badge> : <Badge tone="neutral">Hidden</Badge>}
          <Button size="sm" variant="secondary" onClick={onEdit}>
            Edit
          </Button>
        </Row>
      }
    >
      <Stack>
        <div className="cq-metrics">
          <div className="cq-metric">
            <div className="cq-overline">Slug</div>
            <div className="cq-metric__value" style={{ fontSize: 20 }}>
              {plan.id}
            </div>
            <div className="cq-metric__context">Referenced by subscriptions</div>
          </div>
          <div className="cq-metric">
            <div className="cq-overline">Can subcontract</div>
            <div className="cq-metric__value" style={{ fontSize: 20 }}>
              {plan.operatesDownstream ? 'Yes' : 'No'}
            </div>
            <div className="cq-metric__context">operates_downstream</div>
          </div>
          <div className="cq-metric">
            <div className="cq-overline">Trial</div>
            <div className="cq-metric__value" style={{ fontSize: 20 }}>
              {plan.trialDays === 0 ? 'None' : `${plan.trialDays} days`}
            </div>
            <div className="cq-metric__context">No card required</div>
          </div>
          <div className="cq-metric">
            <div className="cq-overline">Features</div>
            <div className="cq-metric__value" style={{ fontSize: 20 }}>
              {plan.features.length} / {FEATURE_KEYS.length}
            </div>
            <div className="cq-metric__context">Sort order {plan.sortOrder}</div>
          </div>
        </div>

        <Table label={`${plan.name} limits`}>
          <thead>
            <tr>
              <th scope="col">Limit</th>
              <th scope="col">Allowance</th>
            </tr>
          </thead>
          <tbody>
            {LIMIT_KEYS.map((key) => {
              const value = plan.limits[key];
              return (
                <tr key={key}>
                  <td className="cq-table__primary">{titleCase(key)}</td>
                  <td className="cq-numeric">
                    {value === undefined ? (
                      <span className="cq-muted">Not set</span>
                    ) : value === null ? (
                      <Badge tone="success">Unlimited</Badge>
                    ) : value === 0 ? (
                      <span className="cq-muted">None</span>
                    ) : (
                      value
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>

        <div>
          <div className="cq-overline">Features</div>
          <Row>
            {plan.features.length === 0 ? (
              <span className="cq-muted">None</span>
            ) : (
              plan.features.map((f) => (
                <Badge key={f} tone="neutral">
                  {titleCase(f)}
                </Badge>
              ))
            )}
          </Row>
        </div>

        <PriceEditor plan={plan} token={token} onSaved={onPriceSaved} />
      </Stack>
    </Section>
  );
}

// ── Prices ─────────────────────────────────────────────────────────────────────

function PriceEditor({
  plan,
  token,
  onSaved,
}: {
  plan: AdminPlanView;
  token: string | null;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [currency, setCurrency] = useState('USD');
  const [interval, setInterval] = useState<PriceInterval>('MONTH');
  const [amount, setAmount] = useState('');
  const [providerPriceId, setProviderPriceId] = useState('');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cents = inputToCents(amount);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!token || cents === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.adminUpsertPrice(token, plan.id, {
        currency: currency.toUpperCase(),
        interval,
        amountCents: cents,
        ...(providerPriceId.trim() ? { providerPriceId: providerPriceId.trim() } : {}),
        active,
      });
      setAmount('');
      setProviderPriceId('');
      setOpen(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the price');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack>
      <Row between>
        <div className="cq-overline">Prices</div>
        {open ? null : (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Add or update a price
          </Button>
        )}
      </Row>

      {plan.prices.length === 0 ? (
        <p className="cq-muted">
          No prices set. A plan with no price cannot be checked out, which is correct for a free
          tier and a mistake for anything else.
        </p>
      ) : (
        <Table label={`${plan.name} prices`}>
          <thead>
            <tr>
              <th scope="col">Currency</th>
              <th scope="col">Interval</th>
              <th scope="col">Amount</th>
              <th scope="col">Provider price id</th>
              <th scope="col">Active</th>
            </tr>
          </thead>
          <tbody>
            {plan.prices.map((price) => (
              <tr key={price.id}>
                <td className="cq-table__primary">{price.currency}</td>
                <td>{titleCase(price.interval)}</td>
                <td className="cq-numeric">{formatCents(price.amountCents, price.currency)}</td>
                <td>
                  {price.providerPriceId ?? (
                    <span className="cq-muted">Not linked to a provider</span>
                  )}
                </td>
                <td>
                  {price.active ? (
                    <Badge tone="success">Active</Badge>
                  ) : (
                    <span className="cq-muted">Inactive</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {open ? (
        <form onSubmit={save} className="cq-stack" aria-busy={busy}>
          <div className="cq-form-grid">
            <Field label="Currency">
              <Input
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
                maxLength={3}
                required
              />
            </Field>
            <Field label="Interval">
              <Select
                value={interval}
                onChange={(e) => setInterval(e.target.value as PriceInterval)}
              >
                {PRICE_INTERVALS.map((i) => (
                  <option key={i} value={i}>
                    {titleCase(i)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </Field>
            <Field
              label="Provider price id"
              hint="The merchant-of-record's own id. Optional until Phase 5 billing."
            >
              <Input
                value={providerPriceId}
                onChange={(e) => setProviderPriceId(e.target.value)}
              />
            </Field>
          </div>
          <label className="cq-row" style={{ gap: 8 }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            <span>Active</span>
          </label>
          <p className="cq-muted">
            A currency and interval pair is unique per plan — saving an existing pair updates it
            rather than adding a second.
          </p>
          <ErrorText>{error}</ErrorText>
          <Row>
            <Button type="submit" disabled={busy || cents === null}>
              {busy ? 'Saving…' : 'Save price'}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
          </Row>
        </form>
      ) : null}
    </Stack>
  );
}

// ── Create / edit ──────────────────────────────────────────────────────────────

function PlanEditor({
  token,
  plan,
  onDone,
  onCancel,
}: {
  token: string;
  plan: AdminPlanView | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState(plan?.id ?? '');
  const [name, setName] = useState(plan?.name ?? '');
  const [description, setDescription] = useState(plan?.description ?? '');
  const [status, setStatus] = useState<PlanStatus>(plan?.status ?? 'DRAFT');
  const [isPublic, setIsPublic] = useState(plan?.isPublic ?? true);
  const [operatesDownstream, setOperatesDownstream] = useState(plan?.operatesDownstream ?? false);
  const [sortOrder, setSortOrder] = useState(String(plan?.sortOrder ?? 0));
  const [trialDays, setTrialDays] = useState(String(plan?.trialDays ?? 0));
  const [features, setFeatures] = useState<Set<FeatureKey>>(new Set(plan?.features ?? []));
  // Two pieces of state per limit, because "unlimited" and "a number" are different
  // things and one input cannot express both without ambiguity.
  const [limits, setLimits] = useState<Record<string, { unlimited: boolean; value: string }>>(() => {
    const out: Record<string, { unlimited: boolean; value: string }> = {};
    for (const key of LIMIT_KEYS) {
      const current = plan?.limits[key];
      out[key] = {
        unlimited: current === null,
        value: current === null || current === undefined ? '' : String(current),
      };
    }
    return out;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleFeature(key: FeatureKey) {
    setFeatures((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const limitsPayload: Partial<Record<LimitKey, number | null>> = {};
      for (const key of LIMIT_KEYS) {
        const entry = limits[key];
        if (!entry) continue;
        if (entry.unlimited) limitsPayload[key] = null;
        else if (entry.value.trim() !== '') limitsPayload[key] = Number(entry.value);
      }
      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
        status,
        isPublic,
        operatesDownstream,
        sortOrder: Number(sortOrder) || 0,
        trialDays: Number(trialDays) || 0,
        features: [...features],
        limits: limitsPayload,
      };
      if (plan) await api.adminUpdatePlan(token, plan.id, body);
      else await api.adminCreatePlan(token, { id: id.trim().toLowerCase(), ...body });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the plan');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title={plan ? `Edit ${plan.name}` : 'New plan'}
      description="Features and limits replace what the plan had — this is not a partial merge."
    >
      <form onSubmit={save} className="cq-stack" aria-busy={busy}>
        <div className="cq-form-grid">
          {plan ? null : (
            <Field label="Slug" hint="Lowercase letters, digits, - or _. Cannot be changed later.">
              <Input
                value={id}
                onChange={(e) => setId(e.target.value.toLowerCase())}
                required
                autoFocus
              />
            </Field>
          )}
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as PlanStatus)}>
              {PLAN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Sort order" hint="Lower sorts first on the pricing page.">
            <Input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
          </Field>
          <Field label="Trial days" hint="0 for no trial.">
            <Input
              type="number"
              min="0"
              value={trialDays}
              onChange={(e) => setTrialDays(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Description">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={1000}
          />
        </Field>

        <Row>
          <label className="cq-row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            <span>Listed publicly</span>
          </label>
          <label className="cq-row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={operatesDownstream}
              onChange={(e) => setOperatesDownstream(e.target.checked)}
            />
            <span>Can engage subcontractors</span>
          </label>
        </Row>

        <div>
          <div className="cq-overline">Feature matrix</div>
          <div className="cq-form-grid">
            {FEATURE_KEYS.map((key) => (
              <label key={key} className="cq-row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={features.has(key)}
                  onChange={() => toggleFeature(key)}
                />
                <span>{titleCase(key)}</span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <div className="cq-overline">Limit matrix</div>
          <Table label="Limits">
            <thead>
              <tr>
                <th scope="col">Limit</th>
                <th scope="col">Unlimited</th>
                <th scope="col">Allowance</th>
              </tr>
            </thead>
            <tbody>
              {LIMIT_KEYS.map((key) => {
                const entry = limits[key] ?? { unlimited: false, value: '' };
                return (
                  <tr key={key}>
                    <td className="cq-table__primary">{titleCase(key)}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={entry.unlimited}
                        aria-label={`${key} unlimited`}
                        onChange={(e) =>
                          setLimits((prev) => ({
                            ...prev,
                            [key]: { ...entry, unlimited: e.target.checked },
                          }))
                        }
                      />
                    </td>
                    <td>
                      <Input
                        type="number"
                        min="0"
                        value={entry.unlimited ? '' : entry.value}
                        disabled={entry.unlimited}
                        placeholder={entry.unlimited ? 'Unlimited' : 'Leave blank to not set'}
                        aria-label={`${key} allowance`}
                        onChange={(e) =>
                          setLimits((prev) => ({
                            ...prev,
                            [key]: { ...entry, value: e.target.value },
                          }))
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <p className="cq-muted">
            Zero means the plan allows none of that thing; unlimited means no cap. Leaving both
            unset removes the row, and the resolver then treats the key as absent.
          </p>
        </div>

        <ErrorText>{error}</ErrorText>
        <Row>
          <Button type="submit" disabled={busy || !name.trim() || (!plan && !id.trim())}>
            {busy ? 'Saving…' : plan ? 'Save plan' : 'Create plan'}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </Row>
      </form>
    </Section>
  );
}
