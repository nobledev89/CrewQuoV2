'use client';

import { useState } from 'react';
import {
  FACTOR_IMPORT_FIELDS,
  LIFECYCLE_BOUNDARIES,
  VERIFICATION_STATUSES,
  type ColumnMapping,
  type EmissionFactorView,
  type FactorImportPreviewResult,
  type FactorSetView,
  type ImportDiff,
  type LifecycleBoundary,
  type ProductFactorView,
  type VerificationStatus,
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
  PageHeader,
  Row,
  Section,
  Select,
  Stack,
  Table,
} from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';
import { useEntitlements } from '@/lib/useEntitlements';
import { FeatureLocked } from '@/components/FeatureLock';
import { formatDate } from '@/lib/format';

/**
 * Emission factors and the product carbon library (§26.1–§26.3) — **Ama's screen,
 * and the only one in the product she uses twice a year.**
 *
 * The import is deliberately three steps rather than one — read the file, map its
 * columns, see what would change — because §26.2 asks for a mapping UI and packet
 * §2 explains what that mapping UI *is*: the whole of the review a factor set
 * gets. *"Nobody reviews a factor set. There is no approval state, and adding one
 * would be theatre — the reviewer would be the same person who imported it, and
 * the thing being reviewed is a published government workbook. What replaces
 * review is the importer's dry-run diff."*
 *
 * Two things this screen refuses to do:
 *
 *  - **It never applies the guessed mapping on its own.** A publisher renames its
 *    columns between years, and a guess that quietly guessed wrong would import
 *    the well-to-tank column as the headline factor — a number a fifth the size,
 *    in the direction that flatters.
 *  - **It offers deactivation where a delete would be refused**, and says which
 *    figures are affected. A set that has been cited can never be removed; the
 *    operation that exists for wanting it to stop being used is deactivation, and
 *    a screen that only offered the refused verb would send people to support.
 */
export default function FactorsPage() {
  return (
    <Shell>
      <Factors />
    </Shell>
  );
}

const LIFECYCLE_LABELS: Readonly<Record<LifecycleBoundary, string>> = {
  A1_A3: 'A1–A3 (product stage)',
  A1_A5: 'A1–A5 (through installation)',
  CRADLE_TO_GATE: 'Cradle to gate',
  CRADLE_TO_GRAVE: 'Cradle to grave',
  OTHER: 'Other',
};

const VERIFICATION_LABELS: Readonly<Record<VerificationStatus, string>> = {
  EPD_VERIFIED: 'Verified EPD',
  MANUFACTURER: 'Manufacturer data',
  SECTOR_DATASET: 'Sector dataset',
  ORG_SPECIFIC: 'Our own figure',
  GENERIC_ESTIMATE: 'Generic estimate',
};

function Factors() {
  const ctx = useSessionCtx();
  const ent = useEntitlements();
  const [nonce, setNonce] = useState(0);
  const bump = () => setNonce((n) => n + 1);

  const sets = useAsyncList<FactorSetView>(
    ctx ? () => api.listFactorSets(ctx.accessToken, ctx.companyId, true).then((r) => r.factorSets) : null,
    [ctx?.companyId, nonce]
  );
  const products = useAsyncList<ProductFactorView>(
    ctx
      ? () => api.listProductFactors(ctx.accessToken, ctx.companyId, true).then((r) => r.productFactors)
      : null,
    [ctx?.companyId, nonce]
  );

  if (!ent.loading && !ent.has('sustainability')) {
    return <FeatureLocked feature="sustainability" />;
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Sustainability"
        title="Emission factors"
        description="The published data every carbon figure is multiplied by, and the embodied-carbon library behind every avoided-emissions claim."
      />
      <FactorSets sets={sets} canImport={ent.has('custom_factors')} onChanged={bump} />
      <ProductFactors products={products} canWrite={ent.has('custom_factors')} onChanged={bump} />
    </Stack>
  );
}

// ── Factor sets ──────────────────────────────────────────────────────────────

function FactorSets({
  sets,
  canImport,
  onChanged,
}: {
  sets: ReturnType<typeof useAsyncList<FactorSetView>>;
  canImport: boolean;
  onChanged: () => void;
}) {
  const ctx = useSessionCtx();
  const [importing, setImporting] = useState(false);
  const [inspecting, setInspecting] = useState<FactorSetView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggleActive = async (set: FactorSetView) => {
    if (!ctx) return;
    setError(null);
    try {
      await api.updateFactorSet(ctx.accessToken, ctx.companyId, set.id, { active: !set.active });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That set could not be changed.');
    }
  };

  return (
    <Section
      title="Factor sets"
      description="Imported, never shipped. CrewQuo invents no factor and bundles no dataset — what is here is what somebody put here."
      actions={
        canImport ? (
          <Button size="sm" onClick={() => setImporting(true)}>
            Import a set
          </Button>
        ) : null
      }
    >
      <Stack>
        <ErrorText>{error}</ErrorText>
        {!canImport ? (
          <Notice>
            Your plan reads the shared library but does not include importing your own sets.
            Everything below is available to calculate against.
          </Notice>
        ) : null}

        {sets.items.length === 0 ? (
          <EmptyState title="No factor sets">
            Nothing can be calculated until a set is imported. CrewQuo ships none — a factor is
            somebody else’s published number and it arrives by import, with its source named.
          </EmptyState>
        ) : (
          <Table label="Emission factor sets">
            <thead>
              <tr>
                <th scope="col">Set</th>
                <th scope="col">Applies</th>
                <th scope="col" className="cq-numeric">
                  Factors
                </th>
                <th scope="col" className="cq-numeric">
                  Cited by
                </th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {sets.items.map((s) => (
                <tr key={s.id}>
                  <td className="cq-table__primary">
                    {s.name} {s.version}
                    <span className="cq-table__note">{s.sourceOrganisation}</span>
                    <Row>
                      {s.isPlatform ? <Badge>Shared library</Badge> : null}
                      {s.active ? null : <Badge tone="warning">Inactive</Badge>}
                    </Row>
                  </td>
                  <td>
                    {s.reportingYear} · {s.region}
                    <span className="cq-table__note">
                      {formatDate(s.validFrom)} to {s.validTo ? formatDate(s.validTo) : 'open-ended'}
                    </span>
                  </td>
                  <td className="cq-numeric">{s.factorCount}</td>
                  {/*
                    The number that makes deactivation an informed act rather than a
                    switch: these are the figures that will move the next time
                    anything recalculates.
                  */}
                  <td className="cq-numeric">{s.citedByCalculations}</td>
                  <td>
                    <Row>
                      <Button variant="secondary" size="sm" onClick={() => setInspecting(s)}>
                        View factors
                      </Button>
                      {canImport && !s.isPlatform ? (
                        <Button variant="secondary" size="sm" onClick={() => void toggleActive(s)}>
                          {s.active ? 'Deactivate' : 'Reactivate'}
                        </Button>
                      ) : null}
                    </Row>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Stack>

      <ImportDrawer
        open={importing}
        onClose={() => setImporting(false)}
        onImported={() => {
          setImporting(false);
          onChanged();
        }}
      />
      <FactorsDrawer set={inspecting} onClose={() => setInspecting(null)} />
    </Section>
  );
}

/**
 * The three-step import: read the file, confirm the mapping, see the diff.
 *
 * The file is read in the browser and sent as text or base64 rather than through
 * the presigned-upload path, because packet §10 requires the row cap and the plan
 * limit to be cleared **before a byte is parsed** — and a file that has already
 * reached object storage has already been accepted.
 */
function ImportDrawer({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const ctx = useSessionCtx();
  const [format, setFormat] = useState<'CSV' | 'XLSX'>('CSV');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState<FactorImportPreviewResult | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [diff, setDiff] = useState<ImportDiff | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [sourceOrganisation, setSourceOrganisation] = useState('');
  const [version, setVersion] = useState('');
  const [reportingYear, setReportingYear] = useState(String(new Date().getFullYear()));
  const [validFrom, setValidFrom] = useState('');
  const [region, setRegion] = useState('GB');

  const readFile = async (file: File) => {
    setError(null);
    setDiff(null);
    const isXlsx = file.name.toLowerCase().endsWith('.xlsx');
    setFormat(isXlsx ? 'XLSX' : 'CSV');
    const text = isXlsx
      ? btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())))
      : await file.text();
    setContent(text);
    if (!ctx) return;
    setBusy(true);
    try {
      const result = await api.previewFactorFile(ctx.accessToken, ctx.companyId, {
        format: isXlsx ? 'XLSX' : 'CSV',
        content: text,
      });
      setPreview(result);
      setMapping(result.suggestedMapping);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That file could not be read.');
    } finally {
      setBusy(false);
    }
  };

  const body = () => ({
    format,
    content,
    mapping,
    set: {
      name: name.trim(),
      sourceOrganisation: sourceOrganisation.trim(),
      version: version.trim(),
      reportingYear: Number(reportingYear),
      validFrom,
      region: region.trim(),
    },
  });

  const run = async (dryRun: boolean) => {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      const result = await api.importFactorSet(ctx.accessToken, ctx.companyId, {
        ...body(),
        dryRun,
      } as never);
      if (dryRun) {
        setDiff(result.diff ?? null);
        setRefusal(result.refusal?.message ?? null);
      } else {
        onImported();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That import did not run.');
    } finally {
      setBusy(false);
    }
  };

  const ready =
    preview !== null &&
    name.trim() !== '' &&
    sourceOrganisation.trim() !== '' &&
    version.trim() !== '' &&
    validFrom !== '';

  return (
    <Drawer
      open={open}
      title="Import a factor set"
      description="Nothing is written until you confirm the diff. Every row is checked first, and one bad row refuses the whole file."
      onClose={onClose}
      footer={
        <Row>
          <Button onClick={() => void run(true)} disabled={!ready || busy}>
            {busy ? 'Checking…' : 'Check the file'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void run(false)}
            disabled={!ready || busy || diff === null || refusal !== null}
          >
            Import {diff === null ? '' : `${diff.toAdd} factors`}
          </Button>
        </Row>
      }
    >
      <Stack>
        <ErrorText>{error}</ErrorText>

        <Field label="The file" hint="A CSV or an .xlsx workbook. Formulas are never evaluated.">
          <Input
            type="file"
            accept=".csv,.xlsx,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void readFile(file);
            }}
          />
        </Field>

        {preview ? (
          <>
            <Notice>
              {preview.rowCount} rows, {preview.headers.length} columns
              {preview.sheetNames.length > 1
                ? ` · reading the sheet “${preview.sheetNames[0]}”`
                : ''}
              . Check the mapping below before importing — a publisher renames its columns
              between years, and the wrong column is a number a fifth the size.
            </Notice>

            <Section title="Column mapping">
              <Stack>
                {FACTOR_IMPORT_FIELDS.map((field) => (
                  <Field key={field} label={field}>
                    <Select
                      value={mapping[field] ?? ''}
                      onChange={(e) =>
                        setMapping((m) => ({
                          ...m,
                          [field]: e.target.value === '' ? undefined : e.target.value,
                        }))
                      }
                    >
                      <option value="">Not mapped</option>
                      {preview.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ))}
              </Stack>
            </Section>

            <Section title="What this set is">
              <Stack>
                <Field label="Name" hint="As the publisher names it.">
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="Published by">
                  <Input
                    value={sourceOrganisation}
                    onChange={(e) => setSourceOrganisation(e.target.value)}
                  />
                </Field>
                <Row>
                  <Field label="Version">
                    <Input value={version} onChange={(e) => setVersion(e.target.value)} />
                  </Field>
                  <Field label="Reporting year">
                    <Input
                      type="number"
                      value={reportingYear}
                      onChange={(e) => setReportingYear(e.target.value)}
                    />
                  </Field>
                </Row>
                <Row>
                  <Field label="Applies from">
                    <Input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
                  </Field>
                  <Field label="Region">
                    <Input value={region} onChange={(e) => setRegion(e.target.value)} />
                  </Field>
                </Row>
              </Stack>
            </Section>
          </>
        ) : null}

        {refusal ? <Notice>{refusal}</Notice> : null}

        {diff && refusal === null ? (
          <Section title="What importing would do">
            <Stack>
              <Notice>
                {diff.toAdd} factors would be added, in units: {diff.units.join(', ')}.
              </Notice>
              <Table label="Rows by category" compact>
                <thead>
                  <tr>
                    <th scope="col">Category</th>
                    <th scope="col" className="cq-numeric">
                      Rows
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(diff.countsByCategory).map(([category, n]) => (
                    <tr key={category}>
                      <td className="cq-table__primary">{category}</td>
                      <td className="cq-numeric">{n}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Stack>
          </Section>
        ) : null}
      </Stack>
    </Drawer>
  );
}

/** The rows of one set, searchable. Paged, because a published set is thousands. */
function FactorsDrawer({ set, onClose }: { set: FactorSetView | null; onClose: () => void }) {
  const ctx = useSessionCtx();
  const [search, setSearch] = useState('');

  const factors = useAsyncList<EmissionFactorView>(
    ctx && set
      ? () =>
          api
            .listFactors(ctx.accessToken, ctx.companyId, set.id, {
              search: search === '' ? undefined : search,
              limit: 200,
            })
            .then((r) => r.factors)
      : null,
    [ctx?.companyId, set?.id, search]
  );

  return (
    <Drawer
      open={set !== null}
      title={set ? `${set.name} ${set.version}` : ''}
      description={set ? `${set.factorCount} factors · published by ${set.sourceOrganisation}` : ''}
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <Stack>
        <Field label="Search">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Category, activity or material" />
        </Field>
        {factors.items.length === 0 ? (
          <EmptyState title="Nothing matches">Try a different word.</EmptyState>
        ) : (
          <Table label="Factors" compact>
            <thead>
              <tr>
                <th scope="col">Activity</th>
                <th scope="col">Unit</th>
                <th scope="col" className="cq-numeric">
                  kgCO₂e
                </th>
              </tr>
            </thead>
            <tbody>
              {factors.items.map((f) => (
                <tr key={f.id}>
                  <td className="cq-table__primary">
                    {f.activity}
                    <span className="cq-table__note">
                      {[f.category, f.material, f.treatment, f.vehicleType, f.fuelType]
                        .filter((v) => v !== null && v !== '')
                        .join(' · ')}
                    </span>
                  </td>
                  <td>{f.unit}</td>
                  <td className="cq-numeric">
                    {f.kgCo2ePerUnit}
                    {f.wttKgCo2ePerUnit !== null ? (
                      <span className="cq-table__note">+ {f.wttKgCo2ePerUnit} well-to-tank</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Stack>
    </Drawer>
  );
}

// ── Product carbon factors ───────────────────────────────────────────────────

/**
 * §26.3's library, and the resolver's preference order made visible.
 *
 * An organisation legitimately holds a verified EPD *and* a generic estimate for
 * the same chair — that is exactly what the tier walk chooses between — so the
 * table groups by verification status rather than pretending there is one answer
 * per item.
 */
function ProductFactors({
  products,
  canWrite,
  onChanged,
}: {
  products: ReturnType<typeof useAsyncList<ProductFactorView>>;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const ctx = useSessionCtx();
  const [open, setOpen] = useState(false);
  const [itemCategory, setItemCategory] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [productModel, setProductModel] = useState('');
  const [basis, setBasis] = useState<'ITEM' | 'KG'>('ITEM');
  const [value, setValue] = useState('');
  const [lifecycleBoundary, setLifecycleBoundary] = useState<LifecycleBoundary>('A1_A3');
  const [source, setSource] = useState('');
  const [verificationStatus, setVerificationStatus] = useState<VerificationStatus>('SECTOR_DATASET');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!ctx) return;
    setSaving(true);
    setError(null);
    try {
      await api.createProductFactor(ctx.accessToken, ctx.companyId, {
        itemCategory: itemCategory.trim(),
        manufacturer: manufacturer.trim() === '' ? null : manufacturer.trim(),
        productModel: productModel.trim() === '' ? null : productModel.trim(),
        kgCo2ePerItem: basis === 'ITEM' ? Number(value) : null,
        kgCo2ePerKg: basis === 'KG' ? Number(value) : null,
        lifecycleBoundary,
        source: source.trim(),
        verificationStatus,
      } as never);
      setOpen(false);
      setValue('');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That factor could not be recorded.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="Product carbon factors"
      description="The embodied carbon of the item that did not have to be manufactured. Without one, a reused item is reported as reused and no carbon benefit is claimed for it."
      actions={
        canWrite ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            Add a factor
          </Button>
        ) : null
      }
    >
      <Stack>
        <ErrorText>{error}</ErrorText>
        {products.items.length === 0 ? (
          <EmptyState title="No product factors">
            Avoided-emissions claims need one. Nothing is assumed in the meantime — a reuse
            with no factor behind it is reported as a named gap rather than as a benefit.
          </EmptyState>
        ) : (
          <Table label="Product carbon factors">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">How well is it known?</th>
                <th scope="col">Boundary</th>
                <th scope="col" className="cq-numeric">
                  kgCO₂e
                </th>
              </tr>
            </thead>
            <tbody>
              {products.items.map((p) => (
                <tr key={p.id}>
                  <td className="cq-table__primary">
                    {[p.manufacturer, p.productModel].filter((v) => v).join(' ') || p.itemCategory}
                    <span className="cq-table__note">
                      {p.assetTypeName ?? p.itemCategory} · {p.source}
                    </span>
                    <Row>
                      {p.isPlatform ? <Badge>Shared library</Badge> : null}
                      {p.active ? null : <Badge tone="warning">Inactive</Badge>}
                    </Row>
                  </td>
                  <td>
                    {VERIFICATION_LABELS[p.verificationStatus]}
                    {p.isEstimate ? <span className="cq-table__note">Reported as an estimate</span> : null}
                  </td>
                  <td>{LIFECYCLE_LABELS[p.lifecycleBoundary]}</td>
                  <td className="cq-numeric">
                    {p.kgCo2ePerItem !== null
                      ? `${p.kgCo2ePerItem} / item`
                      : `${p.kgCo2ePerKg} / kg`}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Stack>

      <Drawer
        open={open}
        title="Add a product carbon factor"
        description="Say where the number came from and how far it has been verified. The report shows both."
        onClose={() => setOpen(false)}
        footer={
          <Row>
            <Button onClick={() => void submit()} disabled={saving}>
              {saving ? 'Saving…' : 'Add'}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </Row>
        }
      >
        <Stack>
          <Field label="Item category" hint="Matched against the asset type’s category.">
            <Input value={itemCategory} onChange={(e) => setItemCategory(e.target.value)} placeholder="FURNITURE" />
          </Field>
          <Row>
            <Field label="Manufacturer">
              <Input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} />
            </Field>
            <Field label="Model">
              <Input value={productModel} onChange={(e) => setProductModel(e.target.value)} />
            </Field>
          </Row>
          <Field label="Rate basis" hint="Exactly one. A factor carrying both is two claims about the same item.">
            <Select value={basis} onChange={(e) => setBasis(e.target.value as 'ITEM' | 'KG')}>
              <option value="ITEM">Per item</option>
              <option value="KG">Per kilogram</option>
            </Select>
          </Field>
          <Field label="kgCO₂e">
            <Input type="number" min="0" step="0.000001" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Field label="Lifecycle boundary" hint="What the number covers. It travels onto every claim that uses it.">
            <Select
              value={lifecycleBoundary}
              onChange={(e) => setLifecycleBoundary(e.target.value as LifecycleBoundary)}
            >
              {LIFECYCLE_BOUNDARIES.map((b) => (
                <option key={b} value={b}>
                  {LIFECYCLE_LABELS[b]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Source" hint="Where this number was published. Named in the report.">
            <Input value={source} onChange={(e) => setSource(e.target.value)} />
          </Field>
          <Field
            label="How well is it known?"
            hint="Everything below a manufacturer’s own figure is reported as an estimate."
          >
            <Select
              value={verificationStatus}
              onChange={(e) => setVerificationStatus(e.target.value as VerificationStatus)}
            >
              {VERIFICATION_STATUSES.map((v) => (
                <option key={v} value={v}>
                  {VERIFICATION_LABELS[v]}
                </option>
              ))}
            </Select>
          </Field>
        </Stack>
      </Drawer>
    </Section>
  );
}
