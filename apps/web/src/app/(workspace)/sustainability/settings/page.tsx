'use client';

import { useEffect, useState } from 'react';
import {
  CARBON_DISPLAY_UNITS,
  DISPLACEMENT_BASES,
  DISTANCE_UNITS,
  MASS_UNITS,
  resolveDisplacementUpdate,
  type CarbonDisplayUnit,
  type DisplacementBasis,
  type DistanceUnit,
  type FactorSetView,
  type MassUnit,
  type SustainabilitySettingsView,
} from '@crewquo/shared';
import {
  Button,
  ErrorText,
  Field,
  Input,
  Notice,
  PageHeader,
  Row,
  Section,
  Select,
  Stack,
  Textarea,
} from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncData } from '@/lib/useAsyncData';
import { useAsyncList } from '@/lib/useAsyncList';
import { useEntitlements } from '@/lib/useEntitlements';
import { FeatureLocked } from '@/components/FeatureLock';

/**
 * Sustainability settings (§39) — *"assumptions live in a settings screen, not in
 * source code."*
 *
 * **The displacement pair is the reason this screen exists**, and it is the reason
 * the whole Phase 9 packet was written. §39's canonical DDL made the default
 * `100`, which would have meant every company claiming maximal avoided emissions
 * on every reuse movement, with `ASSUMED_FULL` recorded as the basis of an
 * assumption nobody made. The owner decided otherwise on 2026-08-18: displacement
 * defaults to **unknown**, and unknown produces **no claim**.
 *
 * So this screen has to do something a settings form usually does not: **say what
 * choosing each option means**, in the place where somebody chooses it. An
 * operator who ticks "assume full displacement" without reading anything has just
 * changed the largest number this product publishes, and the copy beside the
 * control is the only thing standing between that and a report.
 *
 * The pair is validated with the same function the API uses — a second copy of
 * *"is 80% with basis UNKNOWN allowed"* would be a second answer to the question
 * `0037`'s check constraint exists to have one of.
 */
export default function SustainabilitySettingsPage() {
  return (
    <Shell>
      <Settings />
    </Shell>
  );
}

const BASIS_LABELS: Readonly<Record<DisplacementBasis, string>> = {
  UNKNOWN: 'Unknown — make no claim',
  ASSUMED_FULL: 'Assume full displacement (100%)',
  USER_DEFINED: 'A percentage we have decided on',
};

const BASIS_COPY: Readonly<Record<DisplacementBasis, string>> = {
  UNKNOWN:
    'No avoided-emissions claim is made for any reuse, and every one is reported as a named gap. This is the default, and it is the honest position until somebody can say what a reused item actually displaced.',
  ASSUMED_FULL:
    'Every reused item is taken to have replaced one purchase that would otherwise have been made. This is the largest number the product will publish, and it is the one with the least external scrutiny — choose it only if the organisation is prepared to defend it.',
  USER_DEFINED:
    'A stated percentage of reused items are taken to have replaced a purchase. The percentage is recorded on every claim and shown in the report beside the figure it produced.',
};

const CARBON_UNIT_LABELS: Readonly<Record<CarbonDisplayUnit, string>> = {
  AUTO: 'Automatic (tonnes above 1,000 kg)',
  KGCO2E: 'Always kgCO₂e',
  TCO2E: 'Always tCO₂e',
};

const MASS_UNIT_LABELS: Readonly<Record<MassUnit, string>> = {
  AUTO: 'Automatic (tonnes above 1,000 kg)',
  KG: 'Always kilograms',
  TONNE: 'Always tonnes',
};

const DISTANCE_LABELS: Readonly<Record<DistanceUnit, string>> = {
  KM: 'Kilometres',
  MILE: 'Miles',
};

function Settings() {
  const ctx = useSessionCtx();
  const ent = useEntitlements();
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const settings = useAsyncData<SustainabilitySettingsView>(
    ctx ? () => api.sustainabilitySettings(ctx.accessToken, ctx.companyId).then((r) => r.settings) : null,
    [ctx?.companyId, nonce]
  );
  const sets = useAsyncList<FactorSetView>(
    ctx ? () => api.listFactorSets(ctx.accessToken, ctx.companyId).then((r) => r.factorSets) : null,
    [ctx?.companyId, nonce]
  );

  const [basis, setBasis] = useState<DisplacementBasis>('UNKNOWN');
  const [pct, setPct] = useState('');
  const [allowGeneric, setAllowGeneric] = useState(true);
  const [country, setCountry] = useState('GB');
  const [reportingYear, setReportingYear] = useState('');
  const [defaultFactorSetId, setDefaultFactorSetId] = useState('');
  const [carbonUnit, setCarbonUnit] = useState<CarbonDisplayUnit>('AUTO');
  const [massUnit, setMassUnit] = useState<MassUnit>('AUTO');
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>('KM');
  const [warnBelow, setWarnBelow] = useState('80');
  const [disclaimer, setDisclaimer] = useState('');

  useEffect(() => {
    const s = settings.data;
    if (!s) return;
    setBasis(s.defaultDisplacementBasis);
    setPct(s.defaultDisplacementPct === null ? '' : String(s.defaultDisplacementPct));
    setAllowGeneric(s.allowGenericProductFactors);
    setCountry(s.defaultCountry);
    setReportingYear(s.reportingYear === null ? '' : String(s.reportingYear));
    setDefaultFactorSetId(s.defaultFactorSetId ?? '');
    setCarbonUnit(s.carbonDisplayUnit);
    setMassUnit(s.weightUnit);
    setDistanceUnit(s.distanceUnit);
    setWarnBelow(String(s.dataQualityWarnBelow));
    setDisclaimer(s.reportDisclaimer);
  }, [settings.data]);

  if (!ent.loading && !ent.has('sustainability')) {
    return <FeatureLocked feature="sustainability" />;
  }

  /*
   * The same resolution the API runs, so the refusal is a sentence before the
   * request rather than a 422 after it. `resolveDisplacementUpdate` is shared for
   * exactly this: one answer to "is this pair storable", used in both places.
   */
  const displacement = resolveDisplacementUpdate({
    current: {
      basis: settings.data?.defaultDisplacementBasis ?? 'UNKNOWN',
      pct: settings.data?.defaultDisplacementPct ?? null,
    },
    patch: { basis, pct: pct === '' ? null : Number(pct) },
  });

  const save = async () => {
    if (!ctx || displacement.error !== null) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.updateSustainabilitySettings(ctx.accessToken, ctx.companyId, {
        defaultDisplacementBasis: displacement.basis,
        defaultDisplacementPct: displacement.pct,
        allowGenericProductFactors: allowGeneric,
        defaultCountry: country.trim(),
        reportingYear: reportingYear === '' ? null : Number(reportingYear),
        defaultFactorSetId: defaultFactorSetId === '' ? null : defaultFactorSetId,
        carbonDisplayUnit: carbonUnit,
        weightUnit: massUnit,
        distanceUnit,
        dataQualityWarnBelow: Number(warnBelow),
        reportDisclaimer: disclaimer.trim(),
      });
      setNotice(result.notice ?? 'Saved.');
      setNonce((n) => n + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Those settings could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  if (settings.loading) {
    return (
      <Stack>
        <PageHeader eyebrow="Sustainability" title="Assumptions" />
        <p className="cq-muted">Loading…</p>
      </Stack>
    );
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Sustainability"
        title="Assumptions"
        description="Every carbon figure this company publishes is computed under these. They are here rather than in code so they can be read, changed and defended."
        actions={
          <Button onClick={() => void save()} disabled={saving || displacement.error !== null}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        }
      />

      <ErrorText>{error}</ErrorText>
      {notice ? <Notice live>{notice}</Notice> : null}

      <Section
        title="Replacement displacement"
        description="What CrewQuo assumes about whether a reused item actually replaced a purchase. This decides the largest number the product publishes."
      >
        <Stack>
          <Field label="Default assumption">
            <Select value={basis} onChange={(e) => setBasis(e.target.value as DisplacementBasis)}>
              {DISPLACEMENT_BASES.map((b) => (
                <option key={b} value={b}>
                  {BASIS_LABELS[b]}
                </option>
              ))}
            </Select>
          </Field>
          {/*
            The copy is beside the control rather than in a help page, because this
            is the one setting in the product where choosing without reading changes
            a published claim.
          */}
          <Notice>{BASIS_COPY[basis]}</Notice>
          {basis === 'USER_DEFINED' ? (
            <Field label="Displacement percentage">
              <Input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={pct}
                onChange={(e) => setPct(e.target.value)}
              />
            </Field>
          ) : null}
          {displacement.error ? <ErrorText>{displacement.error}</ErrorText> : null}
        </Stack>
      </Section>

      <Section
        title="Product carbon factors"
        description="What may be used when no verified figure exists for an item."
      >
        <Field
          label="Allow generic estimates"
          hint="A generic factor is always labelled as an estimate in the report, and the share of avoided mass resting on one is one of the five data-completeness components."
        >
          <Select
            value={allowGeneric ? 'yes' : 'no'}
            onChange={(e) => setAllowGeneric(e.target.value === 'yes')}
          >
            <option value="yes">Yes — use a generic estimate as a last resort</option>
            <option value="no">No — make no claim rather than use a generic</option>
          </Select>
        </Field>
      </Section>

      <Section
        title="Which factors apply"
        description="Selection is by the date the work happened, its region and its reporting year. A pin overrides that entirely."
      >
        <Stack>
          <Row>
            <Field label="Region">
              <Input value={country} onChange={(e) => setCountry(e.target.value)} />
            </Field>
            <Field
              label="Reporting year"
              hint="Leave blank to select by the date the work happened, which is the usual answer."
            >
              <Input
                type="number"
                value={reportingYear}
                onChange={(e) => setReportingYear(e.target.value)}
              />
            </Field>
          </Row>
          <Field
            label="Pinned factor set"
            hint="Only when two sets would otherwise be ambiguous. A pin applies to work of every date, including work done before the set was published."
          >
            <Select
              value={defaultFactorSetId}
              onChange={(e) => setDefaultFactorSetId(e.target.value)}
            >
              <option value="">Select by date and region</option>
              {sets.items.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} {s.version}
                </option>
              ))}
            </Select>
          </Field>
        </Stack>
      </Section>

      <Section title="Data completeness" description="§28.3's five components and where the warning starts.">
        <Field
          label="Warn below"
          hint="Any figure whose project is below this is shown with its completeness attached rather than presented as fact."
        >
          <Input
            type="number"
            min="0"
            max="100"
            value={warnBelow}
            onChange={(e) => setWarnBelow(e.target.value)}
          />
        </Field>
      </Section>

      <Section title="How figures are shown">
        <Stack>
          <Row>
            <Field label="Carbon">
              <Select
                value={carbonUnit}
                onChange={(e) => setCarbonUnit(e.target.value as CarbonDisplayUnit)}
              >
                {CARBON_DISPLAY_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {CARBON_UNIT_LABELS[u]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Mass">
              <Select value={massUnit} onChange={(e) => setMassUnit(e.target.value as MassUnit)}>
                {MASS_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {MASS_UNIT_LABELS[u]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Distance">
              <Select
                value={distanceUnit}
                onChange={(e) => setDistanceUnit(e.target.value as DistanceUnit)}
              >
                {DISTANCE_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {DISTANCE_LABELS[u]}
                  </option>
                ))}
              </Select>
            </Field>
          </Row>
        </Stack>
      </Section>

      <Section
        title="Report methodology statement"
        description="The wording that appears on every report. It may be edited, and it may never claim independent verification or certification."
      >
        <Field label="Statement">
          <Textarea rows={8} value={disclaimer} onChange={(e) => setDisclaimer(e.target.value)} />
        </Field>
      </Section>
    </Stack>
  );
}
