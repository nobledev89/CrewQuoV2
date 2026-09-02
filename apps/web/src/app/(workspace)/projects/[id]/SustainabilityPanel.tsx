'use client';

import { useState } from 'react';
import {
  ACTIVITY_KINDS,
  ACTIVITY_PURPOSES,
  ACTIVITY_SOURCES,
  REQUIRED_MEASURE_FOR_KIND,
  formatCarbonKg,
  formatCompleteness,
  formatMassKg,
  formatQuantity,
  type ActivityKind,
  type ActivitySource,
  type ActivityPurpose,
  type CarbonCalculationView,
  type ProjectActivityView,
  type ProjectCarbonResponse,
  type ProjectCarbonView,
} from '@crewquo/shared';
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Notice,
  Row,
  Section,
  Select,
  Stack,
  Table,
  Textarea,
} from '@crewquo/ui';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncData } from '@/lib/useAsyncData';
import { useAsyncList } from '@/lib/useAsyncList';
import { formatDate } from '@/lib/format';

/**
 * The project Sustainability section (§28) — step 8 of the Phase 9 build order.
 *
 * Everything the API refuses to do, this screen has to refuse to *render*, and
 * four of those refusals are the whole design:
 *
 *  - **The two headlines sit side by side and are never netted** (§27.5, locked
 *    decision #17). There is no line of arithmetic anywhere below that puts them
 *    in one expression, and the API response has no field that would let there be
 *    one.
 *  - **Absent is not zero** (§41.1). A project with no factor set renders the
 *    reason rather than `0.00 tCO₂e` — a headline of zero is a claim, with the
 *    authority of a number behind it, about a project nobody has measured.
 *  - **A reader without `sustainability.read` gets a section with no carbon in
 *    it**, and the union is switched on rather than optional-chained.
 *    `carbon.projectEmissionsKgCo2e ?? 0` compiles and renders a supervisor as a
 *    project that emitted nothing.
 *  - **The methodology warning travels with the avoided figure**, not in an
 *    appendix — §27.4 says so in those words, and this is the screen it is a rule
 *    about.
 *
 * The completeness score is **itemised**, which is packet finding 5: a customer
 * who has been reading named gaps since Phase 8 sees a percentage here for the
 * first time and will report it as a regression unless they can see what it is
 * made of.
 */

const KIND_LABELS: Readonly<Record<ActivityKind, string>> = {
  VEHICLE_DISTANCE: 'Vehicle distance',
  FUEL: 'Fuel',
  ELECTRICITY: 'Electricity',
  FREIGHT: 'Freight',
  PLANT: 'Plant',
  OTHER: 'Other',
};

const MEASURE_LABELS: Readonly<Record<string, string>> = {
  distanceKm: 'Distance (km)',
  litres: 'Litres',
  kwh: 'kWh',
  tonneKm: 'Tonne-kilometres',
};

const PURPOSE_LABELS: Readonly<Record<ActivityPurpose, string>> = {
  COLLECTION: 'Collection',
  DELIVERY: 'Delivery',
  WASTE_TRANSPORT: 'Waste transport',
  ASSET_TRANSPORT: 'Asset transport',
  CREW_TRAVEL: 'Crew travel',
  PLANT: 'Plant',
  OTHER: 'Other',
};

const SOURCE_LABELS: Readonly<Record<ActivitySource, string>> = {
  MEASURED: 'Measured',
  DOCUMENTED: 'Documented',
  ESTIMATED: 'Estimated',
};

export function SustainabilityPanel({
  projectId,
  canWrite,
  onChanged,
}: {
  projectId: string;
  /** `sustainability.write` — recording an activity and asking for a recalculation. */
  canWrite: boolean;
  onChanged?: () => void;
}) {
  const ctx = useSessionCtx();
  const [nonce, setNonce] = useState(0);
  const bump = () => {
    setNonce((n) => n + 1);
    onChanged?.();
  };

  const carbon = useAsyncData<ProjectCarbonResponse>(
    ctx
      ? () => api.projectCarbon(ctx.accessToken, ctx.companyId, projectId).then((r) => r.carbon)
      : null,
    [ctx?.companyId, projectId, nonce]
  );

  const activities = useAsyncList<ProjectActivityView>(
    ctx
      ? () => api.listActivities(ctx.accessToken, ctx.companyId, projectId).then((r) => r.activities)
      : null,
    [ctx?.companyId, projectId, nonce]
  );

  if (carbon.loading) {
    return (
      <Section title="Sustainability">
        <p className="cq-muted">Loading the carbon picture…</p>
      </Section>
    );
  }

  if (carbon.error || !carbon.data) {
    return (
      <Section title="Sustainability">
        <ErrorText>{carbon.error ?? 'The carbon figures could not be loaded.'}</ErrorText>
      </Section>
    );
  }

  /*
   * The union, switched on. Everything below this line has carbon in it; a reader
   * who reaches the other branch was never shown a figure at all, which is a
   * different sentence from "the figure is zero".
   */
  if (carbon.data.view === 'MASS_ONLY') {
    return (
      <Section title="Sustainability">
        <Notice>
          Carbon figures, the data-completeness score and the named gaps need the
          sustainability permission. The mass balance in Assets &amp; materials is a total of
          lines you can already read one at a time, which is why it is not behind it.
        </Notice>
      </Section>
    );
  }

  const view = carbon.data;

  return (
    <Stack>
      <Headlines view={view} />
      <Completeness view={view} />
      <Gaps view={view} />
      <Claims view={view} />
      <Activities
        projectId={projectId}
        activities={activities}
        canWrite={canWrite}
        onChanged={bump}
      />
      <Trace projectId={projectId} view={view} canWrite={canWrite} onChanged={bump} />
    </Stack>
  );
}

/**
 * §28.4's two figures.
 *
 * **Two metrics, never three.** There is no combined figure and nothing here
 * computes one — the API response has no field for it and the shared type has no
 * room for one, so the absence is structural rather than remembered.
 */
function Headlines({ view }: { view: ProjectCarbonView }) {
  const unit = view.display.carbonUnit;

  if (view.projectEmissionsKgCo2e === null) {
    return (
      <Section title="Carbon">
        <EmptyState title="Nothing has been calculated yet">
          {view.factorSets.length === 0
            ? 'No emission factor set applies to this project, so no figure has been produced. Import a factor set, or ask whoever maintains them — nothing is estimated in the meantime.'
            : 'There is no activity or material movement to calculate from yet.'}
        </EmptyState>
      </Section>
    );
  }

  return (
    <Section
      title="Carbon"
      description={
        view.factorSets.length === 0
          ? undefined
          : `Calculated against ${view.factorSets
              .map((s) => `${s.name} ${s.version}`)
              .join(' and ')}${view.calculatedAt ? ` · last run ${formatDate(view.calculatedAt)}` : ''}`
      }
    >
      <Stack>
        <div className="cq-metrics">
          <div className="cq-metric">
            <span className="cq-overline">Project GHG emissions</span>
            <div className="cq-metric__value">{formatCarbonKg(view.projectEmissionsKgCo2e, unit)}</div>
            <p className="cq-metric__context">
              Scope 1, 2 and 3, including waste treatment{view.hasGaps ? ' — a floor, not a total' : ''}
            </p>
          </div>
          <div className="cq-metric">
            <span className="cq-overline">Estimated avoided emissions</span>
            <div className="cq-metric__value">
              {view.avoidedKgCo2e === null ? '—' : formatCarbonKg(view.avoidedKgCo2e, unit)}
            </div>
            <p className="cq-metric__context">Reported separately · never deducted from the above</p>
          </div>
          {view.comparativeLifecycleKgCo2e ? (
            <div className="cq-metric">
              <span className="cq-overline">Comparative lifecycle impact</span>
              <div className="cq-metric__value">
                {formatCarbonKg(view.comparativeLifecycleKgCo2e, unit)}
              </div>
              <p className="cq-metric__context">Outside the inventory (§26.4)</p>
            </div>
          ) : null}
        </div>

        {/*
          §27.4: the methodology warning is shown WHEREVER an avoided figure
          appears, in the UI and in the report, not only in an appendix. The API
          returns it on the section so no client can render the figure without it.
        */}
        {view.avoidedKgCo2e !== null && view.avoidedKgCo2e !== 0 ? (
          <Notice>{view.methodologyWarning}</Notice>
        ) : null}

        <Table label="Emissions by scope" compact>
          <thead>
            <tr>
              <th scope="col">Scope</th>
              <th scope="col" className="cq-numeric">
                Emissions
              </th>
            </tr>
          </thead>
          <tbody>
            {view.byScope
              .filter((s) => s.scope !== 'OUT_OF_SCOPE' || s.kgCo2e !== 0)
              .map((s) => (
                <tr key={s.scope}>
                  <td className="cq-table__primary">{s.scope.replace('_', ' ')}</td>
                  <td className="cq-numeric">{formatCarbonKg(s.kgCo2e, unit)}</td>
                </tr>
              ))}
          </tbody>
        </Table>
        <p className="cq-muted">
          Electricity is reported on a location-based basis using published grid average
          factors. CrewQuo holds no supplier contracts or renewable certificates, so it does
          not compute a market-based figure.
        </p>
      </Stack>
    </Section>
  );
}

/**
 * §28.3's score, **itemised** (packet finding 5).
 *
 * Five rows, each with its weight and its measured value, rather than a bare
 * percentage. The score arrives on projects nobody edited, and a number with no
 * decomposition is a number people argue with rather than act on.
 */
function Completeness({ view }: { view: ProjectCarbonView }) {
  const { pct, warnBelow, components } = view.completeness;
  const below = pct !== null && pct < warnBelow;

  return (
    <Section
      title="Data completeness"
      description="Five weighted components. A component with nothing to measure is left out of the score rather than counted as zero."
      actions={
        <Row>
          <span className="cq-metric__value">{formatCompleteness(pct)}</span>
          {below ? <Badge tone="warning">Below {warnBelow}%</Badge> : null}
        </Row>
      }
    >
      <Table label="Data completeness components" compact>
        <thead>
          <tr>
            <th scope="col">Component</th>
            <th scope="col" className="cq-numeric">
              Weight
            </th>
            <th scope="col" className="cq-numeric">
              Measured
            </th>
            <th scope="col" className="cq-numeric">
              Of
            </th>
            <th scope="col" className="cq-numeric">
              Value
            </th>
          </tr>
        </thead>
        <tbody>
          {components.map((c) => (
            <tr key={c.component}>
              <td className="cq-table__primary">{c.label}</td>
              <td className="cq-numeric">{Math.round(c.weight * 100)}%</td>
              <td className="cq-numeric">
                {c.unit === 'KG'
                  ? formatMassKg(c.measured, view.display.massUnit)
                  : formatQuantity(c.measured)}
              </td>
              <td className="cq-numeric">
                {c.unit === 'KG'
                  ? formatMassKg(c.total, view.display.massUnit)
                  : formatQuantity(c.total)}
              </td>
              {/*
                An em dash where the denominator is zero, never 0%. A rate over
                nothing is not zero — Phase 8's rule, applied to the fifth
                component, which is empty on every project that has made no claim.
              */}
              <td className="cq-numeric">
                {c.value === null ? '—' : `${Math.round(c.value * 100)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Section>
  );
}

/**
 * §28.3's named gaps.
 *
 * **Generated data, not hand-written copy**, and they appear in the UI *and* in
 * the report. Phase 8's four sentences and Phase 9's carbon ones arrive in one
 * list from the API precisely so they cannot be rendered twice in two wordings.
 */
function Gaps({ view }: { view: ProjectCarbonView }) {
  if (view.gaps.length === 0) {
    return (
      <Section title="What is missing">
        <EmptyState title="Nothing outstanding">
          Every line has a weight, a destination and something supporting it, and every
          figure above rests on a factor.
        </EmptyState>
      </Section>
    );
  }
  return (
    <Section
      title="What is missing"
      description="Every one of these appears in the report as well. A report that quietly omits its own gaps is the failure this list exists to prevent."
    >
      <Stack>
        {view.gaps.map((gap) => (
          <Notice key={gap}>{gap}</Notice>
        ))}
      </Stack>
    </Section>
  );
}

/** The claims behind the avoided figure, each carrying what it assumed. */
function Claims({ view }: { view: ProjectCarbonView }) {
  if (view.claims.length === 0) return null;
  const unit = view.display.carbonUnit;

  return (
    <Section
      title="Avoided-emissions claims"
      description="Each one records what it is claiming against, what was assumed, and what it cost to make the reuse happen."
    >
      <Table label="Avoided-emissions claims">
        <thead>
          <tr>
            <th scope="col">Claim</th>
            <th scope="col">Displacement</th>
            <th scope="col" className="cq-numeric">
              Baseline
            </th>
            <th scope="col" className="cq-numeric">
              Enabling
            </th>
            <th scope="col" className="cq-numeric">
              Net avoided
            </th>
          </tr>
        </thead>
        <tbody>
          {view.claims.map((claim) => (
            <tr key={claim.id}>
              <td className="cq-table__primary">
                {claim.alternativeScenario}
                <span className="cq-table__note">
                  Instead of: {claim.baselineScenario} · boundary{' '}
                  {claim.systemBoundary.replace(/_/g, '–')}
                </span>
                <span className="cq-table__note">{claim.assumptions}</span>
                {claim.uncertainty ? (
                  <span className="cq-table__note">{claim.uncertainty}</span>
                ) : null}
              </td>
              <td>
                {claim.displacementPct === null ? '—' : `${claim.displacementPct}%`}
                <span className="cq-table__note">
                  {claim.displacementBasis === 'ASSUMED_FULL'
                    ? 'Full displacement assumed'
                    : 'Stated by this organisation'}
                </span>
              </td>
              <td className="cq-numeric">{formatCarbonKg(claim.baselineKgCo2e, unit)}</td>
              {/*
                Shown even when zero, because a claim with nothing deducted is a
                different statement from a claim whose enabling emissions nobody
                recorded — and the reader cannot tell the two apart from a blank.
              */}
              <td className="cq-numeric">−{formatCarbonKg(claim.enablingKgCo2e, unit)}</td>
              <td className="cq-numeric">{formatCarbonKg(claim.netAvoidedKgCo2e, unit)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Section>
  );
}

/**
 * §27.3's activities — the one thing on this screen anybody types.
 *
 * The form asks for **the measure the chosen kind is priced from**, and nothing
 * else: `REQUIRED_MEASURE_FOR_KIND` is shared with the API and with its tests, so
 * a field the server would refuse is a field this form does not render.
 */
function Activities({
  projectId,
  activities,
  canWrite,
  onChanged,
}: {
  projectId: string;
  activities: ReturnType<typeof useAsyncList<ProjectActivityView>>;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const ctx = useSessionCtx();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ActivityKind>('VEHICLE_DISTANCE');
  const [activityDate, setActivityDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [measure, setMeasure] = useState('');
  const [vehicleCategory, setVehicleCategory] = useState('');
  const [fuelType, setFuelType] = useState('');
  const [purpose, setPurpose] = useState<ActivityPurpose | ''>('');
  const [source, setSource] = useState<ActivitySource>('ESTIMATED');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const required = REQUIRED_MEASURE_FOR_KIND[kind];

  const submit = async () => {
    if (!ctx) return;
    setSaving(true);
    setError(null);
    try {
      const value = Number(measure);
      await api.createActivity(ctx.accessToken, ctx.companyId, projectId, {
        kind,
        activityDate,
        source,
        vehicleCategory: vehicleCategory.trim() === '' ? null : vehicleCategory.trim(),
        fuelType: fuelType.trim() === '' ? null : fuelType.trim(),
        purpose: purpose === '' ? null : purpose,
        notes: notes.trim() === '' ? null : notes.trim(),
        ...(required === null ? {} : { [required]: value }),
      } as never);
      setOpen(false);
      setMeasure('');
      setNotes('');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That activity could not be recorded.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!ctx) return;
    try {
      await api.deleteActivity(ctx.accessToken, ctx.companyId, id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That activity could not be removed.');
    }
  };

  return (
    <Section
      title="Activity"
      description="Fuel, distance, electricity and freight recorded against this project. Each one is priced by the factor set that applies on its date."
      actions={
        canWrite ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            Record activity
          </Button>
        ) : null
      }
    >
      <Stack>
        <ErrorText>{error}</ErrorText>
        {activities.items.length === 0 ? (
          <EmptyState title="Nothing recorded">
            {canWrite
              ? 'Record a collection, a fuel fill or the site’s electricity, and it is priced from the factor set that applies on the day it happened.'
              : 'Recording activity needs the sustainability write permission.'}
          </EmptyState>
        ) : (
          <Table label="Project activities">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Activity</th>
                <th scope="col" className="cq-numeric">
                  Quantity
                </th>
                <th scope="col">Source</th>
                {canWrite ? <th scope="col" /> : null}
              </tr>
            </thead>
            <tbody>
              {activities.items.map((a) => (
                <tr key={a.id}>
                  <td className="cq-table__primary cq-numeric">{formatDate(a.activityDate)}</td>
                  <td>
                    {KIND_LABELS[a.kind]}
                    <span className="cq-table__note">
                      {[a.vehicleCategory, a.fuelType, a.purpose ? PURPOSE_LABELS[a.purpose] : null]
                        .filter((v) => v !== null && v !== '')
                        .join(' · ') || '—'}
                    </span>
                    {a.providerCompanyName ? (
                      <span className="cq-table__note">
                        Subcontracted to {a.providerCompanyName} — Scope 3
                      </span>
                    ) : null}
                    {a.notes ? <span className="cq-table__note">{a.notes}</span> : null}
                  </td>
                  {/*
                    What the person typed, in the unit they typed it in. §41.2's
                    "name your activity data" means the number on the form — a
                    driver who entered 150 miles and reads back 241.4 km cannot
                    check their own entry.
                  */}
                  <td className="cq-numeric">
                    {a.enteredValue === null
                      ? '—'
                      : `${formatQuantity(a.enteredValue)} ${a.enteredUnit ?? ''}`}
                  </td>
                  <td>
                    <Badge tone={a.source === 'ESTIMATED' ? 'warning' : 'neutral'}>
                      {SOURCE_LABELS[a.source]}
                    </Badge>
                  </td>
                  {canWrite ? (
                    <td>
                      <Button variant="secondary" size="sm" onClick={() => void remove(a.id)}>
                        Remove
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Stack>

      <Drawer
        open={open}
        title="Record an activity"
        description="The figures below are multiplied by the factor set that applies on the date you give."
        onClose={() => setOpen(false)}
        footer={
          <Row>
            <Button onClick={() => void submit()} disabled={saving}>
              {saving ? 'Recording…' : 'Record'}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </Row>
        }
      >
        <Stack>
          <Field label="What happened">
            <Select value={kind} onChange={(e) => setKind(e.target.value as ActivityKind)}>
              {ACTIVITY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date">
            <Input
              type="date"
              value={activityDate}
              onChange={(e) => setActivityDate(e.target.value)}
            />
          </Field>
          {required === null ? (
            <Notice>
              An “other” activity records that something happened without pricing it. Nothing
              is calculated from it and no gap is reported for it.
            </Notice>
          ) : (
            <Field label={MEASURE_LABELS[required] ?? required}>
              <Input
                type="number"
                min="0"
                step="0.001"
                value={measure}
                onChange={(e) => setMeasure(e.target.value)}
              />
            </Field>
          )}
          <Field
            label="Vehicle category"
            hint="Matched against the factor set’s own vehicle column. Leave blank if it does not say."
          >
            <Input
              value={vehicleCategory}
              onChange={(e) => setVehicleCategory(e.target.value)}
              placeholder="e.g. VAN"
            />
          </Field>
          <Field label="Fuel type" hint="Matched the same way.">
            <Input
              value={fuelType}
              onChange={(e) => setFuelType(e.target.value)}
              placeholder="e.g. DIESEL"
            />
          </Field>
          <Field label="Purpose">
            <Select
              value={purpose}
              onChange={(e) => setPurpose(e.target.value as ActivityPurpose | '')}
            >
              <option value="">Not stated</option>
              {ACTIVITY_PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {PURPOSE_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="How well is this known?"
            hint="An estimate is still worth recording — it is counted, labelled and disclosed."
          >
            <Select value={source} onChange={(e) => setSource(e.target.value as ActivitySource)}>
              {ACTIVITY_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Notes">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </Stack>
      </Drawer>
    </Section>
  );
}

/**
 * §41.2's trace: every row, and what produced it.
 *
 * **This is what makes "every number traceable to a factor and a version" a thing
 * a person can check** rather than a claim in a document. It is behind a toggle
 * because nobody reads it daily and everybody needs it once.
 */
function Trace({
  projectId,
  view,
  canWrite,
  onChanged,
}: {
  projectId: string;
  view: ProjectCarbonView;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const ctx = useSessionCtx();
  const [shown, setShown] = useState(false);
  const [superseded, setSuperseded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const rows = useAsyncList<CarbonCalculationView>(
    ctx && shown
      ? () =>
          api
            .projectCalculations(ctx.accessToken, ctx.companyId, projectId, superseded)
            .then((r) => r.calculations)
      : null,
    [ctx?.companyId, projectId, shown, superseded]
  );

  const recalculate = async () => {
    if (!ctx) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.recalculateProjectCarbon(ctx.accessToken, ctx.companyId, projectId);
      setNotice(
        result.recalculation.skipped === 'UNCHANGED'
          ? 'Nothing moved — the figures already match the records behind them.'
          : `${result.recalculation.newCount} figures recalculated, ${result.recalculation.supersededCount} superseded.`
      );
      onChanged();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'The recalculation did not run.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="How these figures were produced"
      description="Every row names the factor it used, that factor’s version and reporting year, and the value it multiplied."
      actions={
        <Row>
          {canWrite ? (
            <Button variant="secondary" size="sm" onClick={() => void recalculate()} disabled={busy}>
              {busy ? 'Recalculating…' : 'Recalculate'}
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={() => setShown((v) => !v)}>
            {shown ? 'Hide the working' : 'Show the working'}
          </Button>
        </Row>
      }
    >
      <Stack>
        {notice ? <Notice live>{notice}</Notice> : null}
        {canWrite ? (
          <p className="cq-muted">
            A newer factor set is never applied to a project on its own. Recalculating is how
            you ask for it — and figures already reported stay readable in the superseded rows.
          </p>
        ) : null}

        {shown ? (
          <>
            <Row>
              <label className="cq-row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={superseded}
                  onChange={(e) => setSuperseded(e.target.checked)}
                />
                <span>Include superseded rows</span>
              </label>
            </Row>
            {rows.items.length === 0 ? (
              <EmptyState title="No calculations">
                Nothing has been calculated for this project yet.
              </EmptyState>
            ) : (
              <Table label="Carbon calculations">
                <thead>
                  <tr>
                    <th scope="col">Bucket</th>
                    <th scope="col">Basis</th>
                    <th scope="col" className="cq-numeric">
                      Quantity
                    </th>
                    <th scope="col" className="cq-numeric">
                      Factor
                    </th>
                    <th scope="col" className="cq-numeric">
                      Result
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.items.map((c) => (
                    <tr key={c.id}>
                      <td className="cq-table__primary">
                        {c.bucket.replace(/_/g, ' ').toLowerCase()}
                        {c.supersededBy ? (
                          <span className="cq-table__note">
                            Superseded — kept for the reports that cited it
                          </span>
                        ) : null}
                        {c.scope ? (
                          <span className="cq-table__note">
                            {c.scope.replace('_', ' ')}
                            {c.scope3Category ? ` · category ${c.scope3Category}` : ''}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        {c.citation.factorSetName} {c.citation.factorSetVersion}
                        <span className="cq-table__note">
                          {c.citation.factorReportingYear
                            ? `Reporting year ${c.citation.factorReportingYear}`
                            : 'Product carbon factor'}
                          {c.isEstimate ? ' · estimate' : ''}
                        </span>
                      </td>
                      <td className="cq-numeric">
                        {formatQuantity(c.quantity)} {c.unit}
                      </td>
                      <td className="cq-numeric">
                        {c.citation.factorKgCo2ePerUnit === null
                          ? '—'
                          : `${c.citation.factorKgCo2ePerUnit} / ${c.unit}`}
                      </td>
                      <td className="cq-numeric">
                        {formatCarbonKg(c.kgCo2e, view.display.carbonUnit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        ) : null}
      </Stack>
    </Section>
  );
}
