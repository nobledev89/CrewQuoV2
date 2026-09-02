'use client';

import { useMemo, useState } from 'react';
import {
  ASSET_CONDITIONS,
  DESTINATION_ORG_KINDS,
  DESTINATION_ORG_KIND_LABELS,
  WEIGHT_SOURCES,
  WEIGHT_SOURCE_LABELS,
  formatMassKg,
  formatQuantity,
  formatRate,
  reweighForQuantity,
  type AssetCondition,
  type AssetTypeView,
  type AssetView,
  type DestinationOrgKind,
  type DestinationOrgView,
  type DestinationTypeView,
  type LocationView,
  type MassBalanceView,
  type MovementView,
  type OutcomeState,
  type TrackingMode,
  type WeightBasis,
  type WeightSource,
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
import { useAuth, useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncData } from '@/lib/useAsyncData';
import { useAsyncList } from '@/lib/useAsyncList';

/**
 * Assets & materials (§25, §28) — the sixth section on the project record, and
 * step 6 of the Phase 8 build order in `docs/operating-model/assets-materials.md`.
 *
 * The API side of this phase is five steps of arithmetic nobody could see. What
 * this screen adds is not a view of it — it is the only place those rules are
 * *reachable*, and three of them exist nowhere else:
 *
 *  - **Pending mass is rendered beside the rates, never inside one.** §28.2:
 *    *"hiding pending mass in a denominator is how a diversion rate becomes a
 *    lie."* The API already returns the two in one object so a caller cannot hold
 *    the rates without the pending figure; this is the screen that has to make a
 *    reader see them together. 693 of 933 is 74%, and 693 of 693 is 100%.
 *  - **Storage is a door.** A leg at a non-final destination gets *"Move on from
 *    storage"* and never *"Record a movement"* — the two write different rows,
 *    and a continuation typed as a fresh movement is twelve chairs counted in the
 *    warehouse *and* twelve recycled, from a line of forty-two.
 *  - **"Weighed and verified" is offered to everybody**, including the Supervisor
 *    whose bundle has no `asset.weight.verify`. The API saves their figure as an
 *    estimate and returns the sentence saying why, so this panel renders that
 *    sentence on a **201**. Hiding the tick would protect a label by losing the
 *    measurement, which is the data the product exists to collect.
 *
 * The empty state is the fourth: an empty project reads *"Nothing recorded yet"*
 * and never `0.00 t`, because a zero is a claim about a floor nobody has walked.
 */
export function AssetsPanel({
  projectId,
  locations,
  canWrite,
  canSetDestination,
  onCountChanged,
}: {
  projectId: string;
  locations: readonly LocationView[];
  /** `asset.write` — recording and correcting lines. */
  canWrite: boolean;
  /** `asset.destination.set` — movements, and the organisations they name. */
  canSetDestination: boolean;
  onCountChanged: () => void;
}) {
  const ctx = useSessionCtx();
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [movementNonce, setMovementNonce] = useState(0);

  const assets = useAsyncList<AssetView>(
    ctx
      ? () => api.listAssets(ctx.accessToken, ctx.companyId, projectId).then((r) => r.assets)
      : null,
    [ctx?.companyId, projectId]
  );
  const balance = useAsyncData<MassBalanceView>(
    ctx
      ? () => api.massBalance(ctx.accessToken, ctx.companyId, projectId).then((r) => r.massBalance)
      : null,
    [ctx?.companyId, projectId]
  );
  /*
   * The three catalogs load with the panel rather than with the drawer that needs
   * them, which is the argument `page.tsx` makes for locations: the add drawer,
   * the register and the movement drawer all read these, and three separate
   * fetches would be three chances for the pickers to disagree about what a
   * company's catalog contains.
   */
  const assetTypes = useAsyncList<AssetTypeView>(
    ctx ? () => api.listAssetTypes(ctx.accessToken, ctx.companyId).then((r) => r.assetTypes) : null,
    [ctx?.companyId]
  );
  const destinationTypes = useAsyncList<DestinationTypeView>(
    ctx
      ? () =>
          api.listDestinationTypes(ctx.accessToken, ctx.companyId).then((r) => r.destinationTypes)
      : null,
    [ctx?.companyId]
  );
  const destinationOrgs = useAsyncList<DestinationOrgView>(
    ctx
      ? () =>
          api
            .listDestinationOrganisations(ctx.accessToken, ctx.companyId)
            .then((r) => r.destinationOrganisations)
      : null,
    [ctx?.companyId]
  );

  /** Everything a write can move: the register, the roll-up and the rail's count. */
  function reloadAll(): void {
    assets.reload();
    balance.reload();
    setMovementNonce((n) => n + 1);
    onCountChanged();
  }

  async function remove(asset: AssetView): Promise<void> {
    if (!ctx) return;
    setError(null);
    setNotice(null);
    try {
      await api.deleteAsset(ctx.accessToken, ctx.companyId, asset.id);
      reloadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove that line');
    }
  }

  const typesById = useMemo(
    () => new Map(assetTypes.items.map((t) => [t.id, t])),
    [assetTypes.items]
  );
  const locationsById = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);

  return (
    <Stack>
      <MassBalanceCard balance={balance} />

      <Section
        title="Asset lines"
        description="What came off the floor: a count, what it weighs, and where it went. A line with no weight is valid — it counts against completeness rather than being refused."
        className="cq-section--table"
        actions={
          canWrite ? (
            <Row>
              <Button size="sm" variant="secondary" onClick={() => setDrawer({ kind: 'import' })}>
                Paste a schedule
              </Button>
              <Button size="sm" onClick={() => setDrawer({ kind: 'add' })}>
                Add a line
              </Button>
            </Row>
          ) : null
        }
      >
        <Stack>
          <ErrorText>{error ?? assets.error}</ErrorText>
          {notice ? <Notice live>{notice}</Notice> : null}

          {assets.loading ? (
            <p className="cq-muted">Loading asset lines…</p>
          ) : assets.items.length === 0 ? (
            <EmptyState title="Nothing recorded yet">
              An asset line is a count of one kind of thing — 42 operator chairs, 2.5 tonnes of
              timber — with what it weighs and, later, where it went.
              {canWrite
                ? ' Add one line, or paste a schedule straight out of the client’s spreadsheet.'
                : ' Nobody has recorded one on this project.'}
            </EmptyState>
          ) : (
            <Table label="Asset lines" compact>
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">Quantity</th>
                  <th scope="col">Weight</th>
                  <th scope="col">Provenance</th>
                  <th scope="col">From</th>
                  <th scope="col">Outcome</th>
                  <th scope="col" className="cq-table__actions">
                    <span className="cq-vh">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {assets.items.map((asset) =>
                  editing === asset.id ? (
                    <InlineEditRow
                      key={asset.id}
                      asset={asset}
                      onCancel={() => setEditing(null)}
                      onSaved={(saved) => {
                        setEditing(null);
                        setNotice(saved.notice ?? null);
                        reloadAll();
                      }}
                      onStale={(message) => {
                        setEditing(null);
                        setError(message);
                        reloadAll();
                      }}
                    />
                  ) : (
                    <AssetRow
                      key={asset.id}
                      asset={asset}
                      typeDefaultKg={typesById.get(asset.assetTypeId)?.defaultUnitWeightKg ?? null}
                      locationName={
                        asset.originLocationId
                          ? (locationsById.get(asset.originLocationId)?.name ?? 'A removed location')
                          : null
                      }
                      expanded={expanded === asset.id}
                      canWrite={canWrite}
                      canSetDestination={canSetDestination}
                      movementNonce={movementNonce}
                      destinationTypes={destinationTypes.items}
                      onToggle={() => setExpanded(expanded === asset.id ? null : asset.id)}
                      onEdit={() => setEditing(asset.id)}
                      onWeigh={() => setDrawer({ kind: 'edit', asset })}
                      onRemove={() => void remove(asset)}
                      onMove={(source) => setDrawer({ kind: 'move', asset, source })}
                    />
                  )
                )}
              </tbody>
            </Table>
          )}
        </Stack>
      </Section>

      {drawer?.kind === 'add' || drawer?.kind === 'edit' ? (
        <AssetDrawer
          projectId={projectId}
          asset={drawer.kind === 'edit' ? drawer.asset : null}
          assetTypes={assetTypes.items}
          locations={locations}
          onClose={() => setDrawer(null)}
          onSaved={(savedNotice) => {
            setDrawer(null);
            setNotice(savedNotice);
            reloadAll();
          }}
        />
      ) : null}

      {drawer?.kind === 'import' ? (
        <ImportDrawer
          projectId={projectId}
          onClose={() => setDrawer(null)}
          onImported={() => reloadAll()}
        />
      ) : null}

      {drawer?.kind === 'move' ? (
        <MovementDrawer
          asset={drawer.asset}
          source={drawer.source}
          destinationTypes={destinationTypes.items}
          destinationOrgs={destinationOrgs.items}
          locations={locations}
          onOrgCreated={() => destinationOrgs.reload()}
          onClose={() => setDrawer(null)}
          onSaved={() => {
            setExpanded(drawer.asset.id);
            setDrawer(null);
            reloadAll();
          }}
        />
      ) : null}
    </Stack>
  );
}

type DrawerState =
  | null
  | { kind: 'add' }
  | { kind: 'edit'; asset: AssetView }
  | { kind: 'import' }
  /** `source` set means *continue that leg*, which is a different route (§13.1). */
  | { kind: 'move'; asset: AssetView; source: MovementView | null };

// ── The roll-up ──────────────────────────────────────────────────────────────

const RATE_ROWS = [
  { key: 'reuse', label: 'Reuse', flag: 'REUSE' },
  { key: 'recycling', label: 'Recycling', flag: 'RECYCLING' },
  { key: 'recovery', label: 'Recovery', flag: 'RECOVERY' },
  { key: 'landfill', label: 'Landfill', flag: 'LANDFILL' },
  { key: 'retainedInUse', label: 'Retained in use', flag: 'RETAINED_IN_USE' },
  { key: 'diverted', label: 'Diverted from landfill', flag: 'DIVERTED' },
] as const;

/**
 * §28.1's headline, §28.2's rates and §28.3's gaps.
 *
 * **The union is switched on, never optional-chained.** `balance.rates?.reuse ?? 0`
 * compiles, and renders a reader who was not *shown* the rates as a project that
 * reused nothing — which is why the API omits the key rather than nulling it, and
 * why `MassBalanceView` is two types. The `view` check below is the whole reason
 * that shape was chosen.
 *
 * **There is no completeness score here, and there is not meant to be** (§13.5):
 * four of §28.3's five components exist and the fifth is Phase 9's. Each gap is
 * true on its own, so the gaps ship; a percentage over four fifths of a
 * definition would change meaning downward when Phase 9 lands, on projects
 * nobody touched.
 */
function MassBalanceCard({
  balance,
}: {
  balance: ReturnType<typeof useAsyncData<MassBalanceView>>;
}) {
  const b = balance.data;

  if (balance.loading) {
    return (
      <Section title="Mass balance">
        <p className="cq-muted">Loading the mass balance…</p>
      </Section>
    );
  }

  if (balance.error || !b) {
    return (
      <Section title="Mass balance">
        <ErrorText>{balance.error ?? 'The mass balance could not be loaded.'}</ErrorText>
      </Section>
    );
  }

  /*
   * **Blank, and never `0.00 t`.** A project with nothing recorded has not handled
   * zero tonnes and has not diverted 0% — it has been measured by nobody, and a
   * figure would say otherwise with the authority of a number. The reason lives
   * here rather than in the copy: a reader does not need the rationale, they need
   * the screen not to make the claim.
   */
  if (b.lineCount === 0) {
    return (
      <Section title="Mass balance">
        <EmptyState title="Nothing recorded yet">
          Totals appear once there is a line to total, and they are built from the lines
          themselves — there is nothing here to fill in.
        </EmptyState>
      </Section>
    );
  }

  return (
    <Section
      title="Mass balance"
      description="Every figure is derived from the lines and their movements. Nothing here is stored, so there is nothing to correct but the inputs."
    >
      <Stack>
        <div className="cq-metrics">
          <div className="cq-metric">
            <span className="cq-overline">Handled</span>
            <div className="cq-metric__value">{formatMassKg(b.handledKg)}</div>
            <p className="cq-metric__context">
              {b.linesWithWeight} of {b.lineCount} {b.lineCount === 1 ? 'line has' : 'lines have'} a
              weight
            </p>
          </div>
          <div className="cq-metric">
            <span className="cq-overline">Allocated</span>
            <div className="cq-metric__value">{formatMassKg(b.allocatedKg)}</div>
            <p className="cq-metric__context">Recorded to a final destination</p>
          </div>
          <div className="cq-metric">
            <span className="cq-overline">Pending</span>
            <div className="cq-metric__value">{formatMassKg(b.pendingKg)}</div>
            <p className="cq-metric__context">
              {formatMassKg(b.inStorageKg)} in storage · {formatMassKg(b.unallocatedKg)} with no
              destination yet
            </p>
          </div>
        </div>

        {/*
          The caveat that travels with the numbers rather than under them: it says
          every figure above is a floor. The API sends it in BOTH views for the
          same reason.
        */}
        {b.hasUnknownMass ? (
          <Notice>
            Some material on this project has no weight at all, so every figure here is a minimum
            rather than a total.
          </Notice>
        ) : null}

        {b.view === 'MASS_ONLY' ? (
          <Notice>
            Diversion rates and the destination breakdown need the sustainability permission. The
            masses above are a total of lines you can already read one at a time, which is why they
            are not behind it.
          </Notice>
        ) : (
          <>
            <Table label="Diversion rates">
              <thead>
                <tr>
                  <th scope="col">Rate</th>
                  <th scope="col" className="cq-numeric">
                    Of allocated mass
                  </th>
                  <th scope="col" className="cq-numeric">
                    Mass
                  </th>
                </tr>
              </thead>
              <tbody>
                {RATE_ROWS.map((row) => {
                  const mass = b.byDestination
                    .filter((d) => d.countsAs.includes(row.flag))
                    .reduce((sum, d) => sum + d.massKg, 0);
                  return (
                    <tr key={row.key}>
                      <td className="cq-table__primary">{row.label}</td>
                      <td className="cq-numeric">{formatRate(b.rates[row.key])}</td>
                      <td className="cq-numeric">{formatMassKg(mass)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>

            {/*
              §28.2, said on the screen rather than only in the payload: the rates
              divide by allocated mass, and pending sits beside them instead of
              inside a denominator. 693 of 933 is 74%; 693 of 693 is 100%; the
              second is what this sentence exists to prevent.
            */}
            <Notice>
              These rates are shares of the {formatMassKg(b.allocatedKg)} that has reached a final
              destination.{' '}
              {b.pendingKg > 0
                ? `A further ${formatMassKg(b.pendingKg)} is still pending and is in none of them — not counted as diverted, and not counted as landfill.`
                : 'Nothing is pending, so they are also shares of everything handled.'}
            </Notice>

            <Table label="Where material went">
              <thead>
                <tr>
                  <th scope="col">Destination</th>
                  <th scope="col" className="cq-numeric">
                    Mass
                  </th>
                  <th scope="col">Counts as</th>
                </tr>
              </thead>
              <tbody>
                {b.byDestination.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="cq-muted">
                      Nothing has reached a final destination yet.
                    </td>
                  </tr>
                ) : (
                  b.byDestination.map((d) => (
                    <tr key={d.code}>
                      <td className="cq-table__primary">
                        {d.name}
                        {d.hierarchyTier !== null ? (
                          <span className="cq-table__note">Hierarchy tier {d.hierarchyTier}</span>
                        ) : null}
                      </td>
                      <td className="cq-numeric">{formatMassKg(d.massKg)}</td>
                      <td>
                        {/*
                          The flags travel beside the mass they produced, which is
                          §10's containment for decision #20: a company may mark
                          its own landfill row as diverted, and what stops that
                          being invisible is that the assumption arrives next to
                          the figure it moved.
                        */}
                        <Row>
                          {d.countsAs.length === 0 ? (
                            <span className="cq-muted">No rate — this is not an outcome</span>
                          ) : (
                            d.countsAs.map((flag) => (
                              <Badge key={flag}>{flag.toLowerCase().replace(/_/g, ' ')}</Badge>
                            ))
                          )}
                        </Row>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </Table>

            {b.gaps.length > 0 ? (
              <div className="cq-card">
                <h3 className="cq-h3">What is still missing</h3>
                <ul>
                  {b.gaps.map((gap) => (
                    <li key={gap}>{gap}</li>
                  ))}
                </ul>
                <p className="cq-muted">
                  Named rather than scored. A single completeness percentage would change meaning
                  the moment the sustainability engine adds its own component, so each of these is
                  stated on its own instead.
                </p>
              </div>
            ) : null}
          </>
        )}
      </Stack>
    </Section>
  );
}

// ── The register ─────────────────────────────────────────────────────────────

const OUTCOME_LABELS: Readonly<Record<OutcomeState, string>> = {
  PENDING: 'Not yet allocated',
  PARTIAL: 'Partly allocated',
  IN_STORAGE: 'In storage',
  FINAL: 'All allocated',
};

function outcomeTone(state: OutcomeState): 'neutral' | 'accent' | 'success' | 'warning' {
  if (state === 'FINAL') return 'success';
  if (state === 'IN_STORAGE') return 'warning';
  if (state === 'PARTIAL') return 'accent';
  return 'neutral';
}

function AssetRow({
  asset,
  typeDefaultKg,
  locationName,
  expanded,
  canWrite,
  canSetDestination,
  movementNonce,
  destinationTypes,
  onToggle,
  onEdit,
  onWeigh,
  onRemove,
  onMove,
}: {
  asset: AssetView;
  typeDefaultKg: number | null;
  locationName: string | null;
  expanded: boolean;
  canWrite: boolean;
  canSetDestination: boolean;
  movementNonce: number;
  destinationTypes: readonly DestinationTypeView[];
  onToggle: () => void;
  onEdit: () => void;
  onWeigh: () => void;
  onRemove: () => void;
  onMove: (source: MovementView | null) => void;
}) {
  return (
    <>
      <tr>
        <td className="cq-table__primary">
          <button type="button" className="cq-link-button" onClick={onToggle}>
            {asset.assetTypeName}
          </button>
          {asset.description ? <span className="cq-table__note">{asset.description}</span> : null}
          {asset.serialNumber ? (
            <span className="cq-table__note">Serial {asset.serialNumber}</span>
          ) : null}
        </td>
        <td className="cq-numeric">{formatQuantity(asset.quantity)}</td>
        <td className="cq-numeric">
          {asset.totalWeightKg === null ? (
            <span className="cq-muted">Not weighed</span>
          ) : (
            <>
              {formatMassKg(asset.totalWeightKg)}
              {asset.unitWeightKg !== null && asset.quantity !== 1 ? (
                <span className="cq-table__note">
                  {formatMassKg(asset.unitWeightKg)} each ·{' '}
                  {asset.weightBasis === 'UNIT' ? 'unit weight entered' : 'total entered'}
                </span>
              ) : null}
            </>
          )}
        </td>
        <td>
          {asset.weightSource === null ? (
            <span className="cq-muted">—</span>
          ) : (
            <>
              <Badge tone={asset.weightIsEstimated ? 'warning' : 'success'}>
                {asset.weightConfidence ?? 'No confidence'}
              </Badge>
              <span className="cq-table__note">{WEIGHT_SOURCE_LABELS[asset.weightSource]}</span>
              {/*
                §22.2's chain, surfaced where it matters: the weight still cites
                the version of the ticket the weigher actually read, and a
                re-issued successor does not silently change what was claimed.
              */}
              {asset.weightDocumentSuperseded ? (
                <span className="cq-table__note">
                  The document this weight cites has since been re-issued.
                </span>
              ) : null}
            </>
          )}
          {/*
            Only when the company has done its own weighing. All 22 seeded types
            carry null here, and the absence renders as nothing at all — never as
            0 kg, which would be an invented figure with a UI to defend it.
          */}
          {typeDefaultKg !== null && asset.weightSource === null ? (
            <span className="cq-table__note">
              Your catalog has {formatMassKg(typeDefaultKg)} for this type.
            </span>
          ) : null}
        </td>
        <td>{locationName ?? <span className="cq-muted">—</span>}</td>
        <td>
          <Badge tone={outcomeTone(asset.outcomeState)}>{OUTCOME_LABELS[asset.outcomeState]}</Badge>
        </td>
        <td className="cq-table__actions">
          <Row>
            <Button size="sm" variant="secondary" onClick={onToggle}>
              {expanded ? 'Hide movements' : 'Movements'}
            </Button>
            {canWrite ? (
              <>
                <Button size="sm" variant="secondary" onClick={onEdit}>
                  Edit
                </Button>
                <Button size="sm" variant="secondary" onClick={onWeigh}>
                  Weight
                </Button>
                <Button size="sm" variant="danger" onClick={onRemove}>
                  Remove
                </Button>
              </>
            ) : null}
          </Row>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={7}>
            <MovementList
              asset={asset}
              nonce={movementNonce}
              canSetDestination={canSetDestination}
              destinationTypes={destinationTypes}
              onMove={onMove}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * The split view: 30 donated and 12 recycled against one line of 42.
 *
 * Loaded per expanded line rather than for every line on the project, because a
 * register of two hundred lines would be two hundred requests for tables nobody
 * has opened. The roll-up above already answers the project-level question
 * without any of them.
 */
function MovementList({
  asset,
  nonce,
  canSetDestination,
  destinationTypes,
  onMove,
}: {
  asset: AssetView;
  nonce: number;
  canSetDestination: boolean;
  destinationTypes: readonly DestinationTypeView[];
  onMove: (source: MovementView | null) => void;
}) {
  const ctx = useSessionCtx();
  const movements = useAsyncList<MovementView>(
    ctx
      ? () => api.listMovements(ctx.accessToken, ctx.companyId, asset.id).then((r) => r.movements)
      : null,
    [ctx?.companyId, asset.id, nonce]
  );

  const remaining = remainingFor(asset, movements.items);
  const typesById = useMemo(() => new Map(destinationTypes.map((d) => [d.id, d])), [destinationTypes]);

  return (
    <div className="cq-subrow">
      <ErrorText>{movements.error}</ErrorText>
      {movements.loading ? (
        <p className="cq-muted">Loading movements…</p>
      ) : movements.items.length === 0 ? (
        <p className="cq-muted">
          Nothing has left yet. All {formatQuantity(asset.quantity)} are still unallocated.
        </p>
      ) : (
        <Table label={`Movements for ${asset.assetTypeName}`} compact>
          <thead>
            <tr>
              <th scope="col">Destination</th>
              <th scope="col" className="cq-numeric">
                Quantity
              </th>
              <th scope="col" className="cq-numeric">
                Mass
              </th>
              <th scope="col">Moved</th>
              <th scope="col" className="cq-table__actions">
                <span className="cq-vh">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {movements.items.map((m) => (
              <tr key={m.id}>
                <td className="cq-table__primary">
                  {m.destinationName}
                  {m.destinationOrgName ? (
                    <span className="cq-table__note">{m.destinationOrgName}</span>
                  ) : null}
                  {/*
                    A leg something else carries onward is kept and marked, never
                    hidden: a ledger records where material has been, and the
                    reason this row counts toward nothing is exactly the thing a
                    reader needs to be told.
                  */}
                  {!m.isOpen ? (
                    <span className="cq-table__note">
                      Carried onward — counted at its later destination, not here.
                    </span>
                  ) : null}
                  {m.continuesMovementId !== null ? (
                    <span className="cq-table__note">Continues an earlier leg.</span>
                  ) : null}
                </td>
                <td className="cq-numeric">{formatQuantity(m.quantity)}</td>
                <td className="cq-numeric">
                  {m.effectiveWeightKg === null ? (
                    <span className="cq-muted">—</span>
                  ) : (
                    <>
                      {formatMassKg(m.effectiveWeightKg)}
                      {m.weightIsOverridden ? (
                        <span className="cq-table__note">Weighed on this movement.</span>
                      ) : null}
                    </>
                  )}
                </td>
                <td>{m.movedOn}</td>
                <td className="cq-table__actions">
                  {/*
                    The one button on this screen whose label is load-bearing. A
                    non-final leg that is still open is material sitting
                    somewhere — offering "Record a movement" there would write a
                    second claim on the same twelve chairs, so the only thing
                    offered is the continuation that closes the first.
                  */}
                  {canSetDestination &&
                  m.isOpen &&
                  !(typesById.get(m.destinationTypeId)?.isFinalOutcome ?? m.isFinalOutcome) ? (
                    <Button size="sm" variant="secondary" onClick={() => onMove(m)}>
                      Move on from storage
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {canSetDestination ? (
        <Row>
          <Button size="sm" disabled={remaining <= 0} onClick={() => onMove(null)}>
            Record a movement
          </Button>
          <span className="cq-muted">
            {remaining > 0
              ? `${formatQuantity(remaining)} of ${formatQuantity(asset.quantity)} still unallocated.`
              : `All ${formatQuantity(asset.quantity)} are recorded to a destination.`}
          </span>
        </Row>
      ) : null}
    </div>
  );
}

/**
 * What is left to allocate.
 *
 * It sums the movements the API already marked open rather than re-walking the
 * continuation chain here — `isOpen` *is* the server's answer to "does this leg
 * still say where material is", and a second implementation of that walk in a
 * screen is how the two start disagreeing about a warehouse. This number decides
 * a button's disabled state and a sentence; the refusal that matters is still the
 * API's, taken under the row lock this client cannot hold.
 */
function remainingFor(asset: AssetView, movements: readonly MovementView[]): number {
  const allocated = movements
    .filter((m) => m.isOpen && m.deletedAt === null)
    .reduce((sum, m) => sum + m.quantity, 0);
  return Math.max(0, asset.quantity - allocated);
}

// ── Inline correction ────────────────────────────────────────────────────────

/**
 * The count and the description, edited in the row.
 *
 * **A weight is not editable here, and that is a rule rather than a shortcut.**
 * Changing a weight is a *claim*: it needs a source, it may need a document, and
 * §36 makes it one of the records where the number itself is the evidence — so it
 * opens the drawer where those fields exist. A count is a correction, and the
 * derived side follows it under §25.2's rule: on a UNIT line the total moves, on
 * a TOTAL line the unit weight does. This row previews which, because that is the
 * rule people get wrong in both directions.
 */
function InlineEditRow({
  asset,
  onCancel,
  onSaved,
  onStale,
}: {
  asset: AssetView;
  onCancel: () => void;
  onSaved: (result: { notice?: string }) => void;
  onStale: (message: string) => void;
}) {
  const ctx = useSessionCtx();
  const [quantity, setQuantity] = useState(String(asset.quantity));
  const [description, setDescription] = useState(asset.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = Number(quantity);
  const valid = quantity.trim() !== '' && Number.isFinite(parsed) && parsed >= 0;
  const preview =
    valid && parsed !== asset.quantity
      ? reweighForQuantity({
          basis: asset.weightBasis,
          newQuantity: parsed,
          unitWeightKg: asset.weightBasis === 'UNIT' ? asset.unitWeightKg : null,
          totalWeightKg: asset.weightBasis === 'TOTAL' ? asset.totalWeightKg : null,
        })
      : null;

  async function save(): Promise<void> {
    if (!ctx || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.updateAsset(ctx.accessToken, ctx.companyId, asset.id, {
        quantity: parsed,
        description: description.trim() || null,
        // The revision this edit was composed against. Without it, two people
        // correcting one line silently overwrite each other; with it, the second
        // is told what changed instead.
        expectedRevision: asset.revision,
      });
      onSaved(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        onStale(err.message);
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not save that change');
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <Input
          value={description}
          aria-label="Description"
          placeholder={asset.assetTypeName}
          onChange={(e) => setDescription(e.target.value)}
        />
        <ErrorText>{error}</ErrorText>
      </td>
      <td>
        <Input
          value={quantity}
          aria-label="Quantity"
          inputMode="decimal"
          autoFocus
          onChange={(e) => setQuantity(e.target.value)}
        />
      </td>
      <td colSpan={4}>
        {preview === null ? (
          <span className="cq-muted">
            {asset.weightBasis === null ? 'This line has no weight to recompute.' : 'No change.'}
          </span>
        ) : (
          <span className="cq-muted">
            {asset.weightBasis === 'UNIT'
              ? `${formatMassKg(preview.unitWeightKg)} each stands; the total becomes ${formatMassKg(preview.totalWeightKg)}.`
              : `${formatMassKg(preview.totalWeightKg)} total stands; each becomes ${formatMassKg(preview.unitWeightKg)}.`}
          </span>
        )}
      </td>
      <td className="cq-table__actions">
        <Row>
          <Button size="sm" disabled={busy || !valid} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </Row>
      </td>
    </tr>
  );
}

// ── Recording and re-weighing a line ─────────────────────────────────────────

/**
 * One drawer for both, because they are the same fields.
 *
 * **The "weighed and verified" tick is offered whatever the reader's bundle
 * says.** A Supervisor without `asset.weight.verify` gets 16.5 kg saved as an
 * estimate and the sentence naming the permission, on a successful response — see
 * the panel's own note. Hiding the control would trade the measurement for the
 * label, and teach people to hand the phone to whoever has the bigger role.
 */
function AssetDrawer({
  projectId,
  asset,
  assetTypes,
  locations,
  onClose,
  onSaved,
}: {
  projectId: string;
  asset: AssetView | null;
  assetTypes: readonly AssetTypeView[];
  locations: readonly LocationView[];
  onClose: () => void;
  onSaved: (notice: string | null) => void;
}) {
  const ctx = useSessionCtx();
  const { session } = useAuth();
  const [assetTypeId, setAssetTypeId] = useState(asset?.assetTypeId ?? '');
  const [trackingMode, setTrackingMode] = useState<TrackingMode>(asset?.trackingMode ?? 'BULK');
  const [description, setDescription] = useState(asset?.description ?? '');
  const [quantity, setQuantity] = useState(asset ? String(asset.quantity) : '1');
  const [weightBasis, setWeightBasis] = useState<WeightBasis | ''>(asset?.weightBasis ?? '');
  const [weightValue, setWeightValue] = useState(
    asset?.weightBasis === 'UNIT'
      ? (asset.unitWeightKg?.toString() ?? '')
      : asset?.weightBasis === 'TOTAL'
        ? (asset.totalWeightKg?.toString() ?? '')
        : ''
  );
  const [weightSource, setWeightSource] = useState<WeightSource | ''>(asset?.weightSource ?? '');
  const [verified, setVerified] = useState(asset?.weightConfidence === 'VERIFIED');
  const [serialNumber, setSerialNumber] = useState(asset?.serialNumber ?? '');
  const [condition, setCondition] = useState<AssetCondition | ''>(asset?.condition ?? '');
  const [originLocationId, setOriginLocationId] = useState(asset?.originLocationId ?? '');
  const [notes, setNotes] = useState(asset?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedType = assetTypes.find((t) => t.id === assetTypeId) ?? null;
  const parsedQuantity = Number(quantity);
  const parsedWeight = weightValue.trim() === '' ? null : Number(weightValue);
  const quantityOk =
    quantity.trim() !== '' && Number.isFinite(parsedQuantity) && parsedQuantity >= 0;
  const weightOk = parsedWeight === null || (Number.isFinite(parsedWeight) && parsedWeight >= 0);
  const canSave = assetTypeId !== '' && quantityOk && weightOk && !busy;

  async function save(): Promise<void> {
    if (!ctx || !canSave) return;
    setBusy(true);
    setError(null);

    const basis = weightBasis === '' ? null : weightBasis;
    const weightFields = {
      weightBasis: parsedWeight === null ? null : basis,
      unitWeightKg: basis === 'UNIT' ? parsedWeight : null,
      totalWeightKg: basis === 'TOTAL' ? parsedWeight : null,
      weightSource: parsedWeight === null || weightSource === '' ? null : weightSource,
      weightConfidence: verified ? ('VERIFIED' as const) : null,
      /*
       * §25.3's one exception to "VERIFIED needs a document": WEIGHED means
       * somebody put the thing on a scale, and the person is the provenance. So
       * the weigher is named — which is what makes the claim answerable — rather
       * than the tick standing on its own.
       */
      weighedByUserId: weightSource === 'WEIGHED' ? (session?.user.id ?? null) : null,
    };

    try {
      if (asset) {
        const res = await api.updateAsset(ctx.accessToken, ctx.companyId, asset.id, {
          assetTypeId,
          trackingMode,
          description: description.trim() || null,
          quantity: parsedQuantity,
          serialNumber: serialNumber.trim() || null,
          condition: condition === '' ? null : condition,
          originLocationId: originLocationId || null,
          notes: notes.trim() || null,
          expectedRevision: asset.revision,
          ...weightFields,
        });
        onSaved(res.notice ?? null);
      } else {
        const res = await api.createAsset(ctx.accessToken, ctx.companyId, projectId, {
          assetTypeId,
          trackingMode,
          description: description.trim() || null,
          quantity: parsedQuantity,
          serialNumber: serialNumber.trim() || null,
          condition: condition === '' ? null : condition,
          originLocationId: originLocationId || null,
          notes: notes.trim() || null,
          // One id per attempt, so a retry that could not tell whether it landed
          // gets the answer it missed rather than a second line of 42 chairs.
          clientId: crypto.randomUUID(),
          ...weightFields,
        });
        onSaved(res.notice ?? null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that line');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      title={asset ? `Correct ${asset.assetTypeName}` : 'Add an asset line'}
      description={
        asset
          ? 'A weight change is a claim, so it carries its source. Every change here writes a revision naming who made it.'
          : 'One kind of thing, counted. The weight can wait — a line with none is valid, and simply counts against completeness.'
      }
      onClose={onClose}
      footer={
        <Row>
          <Button disabled={!canSave} onClick={() => void save()}>
            {busy ? 'Saving…' : asset ? 'Save changes' : 'Record line'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </Row>
      }
    >
      <Stack>
        <div className="cq-form-grid cq-form-grid--drawer">
          <Field label="Asset type">
            <Select value={assetTypeId} onChange={(e) => setAssetTypeId(e.target.value)}>
              <option value="">Choose a type…</option>
              {assetTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.isSystem ? '' : ' (yours)'}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Tracking"
            hint="Item tracking is one row per physical unit, for anything with a serial."
          >
            <Select
              value={trackingMode}
              onChange={(e) => {
                const next = e.target.value as TrackingMode;
                setTrackingMode(next);
                if (next === 'ITEM') setQuantity('1');
              }}
            >
              <option value="BULK">Bulk — a count of identical things</option>
              <option value="ITEM">Item — one unit, tracked on its own</option>
            </Select>
          </Field>
          <Field label="Quantity">
            <Input
              value={quantity}
              inputMode="decimal"
              disabled={trackingMode === 'ITEM'}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </Field>
          <Field label="Description" hint="Optional — what these actually are." wide>
            <Input
              value={description}
              placeholder={selectedType?.name ?? 'Black mesh task chairs'}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <Field
            label="Weight basis"
            hint="Type one of the two. The other is derived, and stays derived."
          >
            <Select
              value={weightBasis}
              onChange={(e) => setWeightBasis(e.target.value as WeightBasis | '')}
            >
              <option value="">No weight recorded</option>
              <option value="UNIT">Weight per unit</option>
              <option value="TOTAL">Total weight</option>
            </Select>
          </Field>
          {/*
            Deliberately no placeholder figure, and no default pulled from the
            catalog unless the company itself put one there: §25.1 — "a shipped
            default weight is an invented number that silently becomes a reported
            tonne."
          */}
          <Field
            label={weightBasis === 'TOTAL' ? 'Total weight (kg)' : 'Weight per unit (kg)'}
            hint={
              selectedType?.defaultUnitWeightKg != null
                ? `Your catalog holds ${formatMassKg(selectedType.defaultUnitWeightKg)} for this type.`
                : undefined
            }
          >
            <Input
              value={weightValue}
              inputMode="decimal"
              disabled={weightBasis === ''}
              onChange={(e) => setWeightValue(e.target.value)}
            />
          </Field>
          <Field label="Where the weight came from">
            <Select
              value={weightSource}
              disabled={weightBasis === ''}
              onChange={(e) => setWeightSource(e.target.value as WeightSource | '')}
            >
              <option value="">Not stated</option>
              {WEIGHT_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {WEIGHT_SOURCE_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Weighed and verified"
            hint="Tick only if this figure is backed by a scale or a ticket. If it is not, it is saved as an estimate and you are told why."
          >
            <input
              type="checkbox"
              checked={verified}
              disabled={weightBasis === '' || weightSource === ''}
              onChange={(e) => setVerified(e.target.checked)}
            />
          </Field>

          <Field label="Came from" hint="A floor or a room on this project. Optional.">
            <Select value={originLocationId} onChange={(e) => setOriginLocationId(e.target.value)}>
              <option value="">Not stated</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Condition">
            <Select
              value={condition}
              onChange={(e) => setCondition(e.target.value as AssetCondition | '')}
            >
              <option value="">Not stated</option>
              {ASSET_CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {c.charAt(0) + c.slice(1).toLowerCase()}
                </option>
              ))}
            </Select>
          </Field>
          {trackingMode === 'ITEM' ? (
            <Field
              label="Serial number"
              hint="Unique across your company. If it is already recorded elsewhere, you are told where."
            >
              <Input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} />
            </Field>
          ) : null}
          <Field label="Notes" wide>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <ErrorText>{error}</ErrorText>
      </Stack>
    </Drawer>
  );
}

// ── The paste-import ─────────────────────────────────────────────────────────

interface ParsedRow {
  /** The line number on the *person's* paste, which is not the row number sent. */
  sourceLine: number;
  text: string;
  assetTypeCode: string;
  quantity: number;
  unitWeightKg: number | null;
  description: string | null;
}

/**
 * A schedule pasted straight out of a client's spreadsheet.
 *
 * **The failed rows come back and the imported ones do not, and that is a
 * correction to the acceptance script rather than a shortcut.** §12 step 4 has
 * Dolapo fix four rows and re-paste all sixty; a client that does that either
 * reuses the batch id — refused, because the body differs, which is the
 * idempotency ledger correctly declining to answer a second act with a first
 * answer — or mints a new one and imports fifty-six duplicates. So the box is
 * rewritten to hold exactly the lines that failed, each still carrying its
 * original text and its original line number, and the fifty-six stay recorded
 * once.
 *
 * Blank lines and a header row are dropped before sending, which is why
 * `sourceLine` exists: the API numbers what it received, and a person looking for
 * "row 34" is looking at their own paste.
 */
function ImportDrawer({
  projectId,
  onClose,
  onImported,
}: {
  projectId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const ctx = useSessionCtx();
  const [text, setText] = useState('');
  const [weightSource, setWeightSource] = useState<WeightSource>('USER_ESTIMATE');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    imported: number;
    failures: { line: number; text: string; message: string }[];
  } | null>(null);

  const parsed = useMemo(() => parseSchedule(text), [text]);

  async function submit(): Promise<void> {
    if (!ctx || parsed.rows.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.importAssets(ctx.accessToken, ctx.companyId, projectId, {
        // A fresh id per attempt. The retry this protects against is the one that
        // could not tell whether it landed — not the corrected re-paste, which is
        // a different request and gets a different id by construction.
        clientId: crypto.randomUUID(),
        rows: parsed.rows.map((r) => ({
          assetTypeCode: r.assetTypeCode,
          // A pasted schedule is a count of identical things. Item tracking is one
          // row per serial, which is not a thing a spreadsheet column can express
          // and not a thing to guess at from four cells.
          trackingMode: 'BULK' as const,
          quantity: r.quantity,
          description: r.description,
          ...(r.unitWeightKg === null
            ? {}
            : { weightBasis: 'UNIT' as const, unitWeightKg: r.unitWeightKg, weightSource }),
        })),
      });

      const failures = res.errors.map((e) => {
        const row = parsed.rows[e.row - 1];
        return {
          line: row?.sourceLine ?? e.row,
          text: row?.text ?? (e.value ?? ''),
          message: e.message,
        };
      });
      setResult({ imported: res.imported, failures });
      // Only the lines that did not land, so a second attempt cannot duplicate
      // the ones that did.
      setText(failures.map((f) => f.text).join('\n'));
      onImported();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That paste could not be imported');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      title="Paste a schedule"
      description="One line per kind of thing: type code, quantity, weight per unit, description. Tabs or commas — a paste out of a spreadsheet works as it is."
      onClose={onClose}
      footer={
        <Row>
          <Button disabled={busy || parsed.rows.length === 0} onClick={() => void submit()}>
            {busy
              ? 'Importing…'
              : `Import ${parsed.rows.length} ${parsed.rows.length === 1 ? 'line' : 'lines'}`}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {result ? 'Done' : 'Cancel'}
          </Button>
        </Row>
      }
    >
      <Stack>
        <Field
          label="Where these weights came from"
          hint="Applies to every line that carries a weight. Lines with none are recorded without one."
        >
          <Select
            value={weightSource}
            onChange={(e) => setWeightSource(e.target.value as WeightSource)}
          >
            {WEIGHT_SOURCES.map((s) => (
              <option key={s} value={s}>
                {WEIGHT_SOURCE_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Schedule" wide>
          <Textarea
            rows={10}
            value={text}
            placeholder={
              'OPERATOR_CHAIR\t42\t16.5\tBlack mesh task chairs\nDESK\t18\t34\nMONITOR\t60'
            }
            onChange={(e) => {
              setText(e.target.value);
              setResult(null);
            }}
          />
        </Field>

        {parsed.skipped > 0 ? (
          <p className="cq-muted">
            {parsed.skipped}{' '}
            {parsed.skipped === 1
              ? 'line looks like a header and will not be sent'
              : 'lines look like headers and will not be sent'}
            .
          </p>
        ) : null}

        {result ? (
          <>
            <Notice live>
              {result.imported} {result.imported === 1 ? 'line' : 'lines'} imported.
              {result.failures.length > 0
                ? ` ${result.failures.length} did not, and ${result.failures.length === 1 ? 'it is' : 'they are'} left in the box above — the imported ones are not, so pasting again cannot duplicate them.`
                : ' Nothing was refused.'}
            </Notice>
            {result.failures.length > 0 ? (
              <Table label="Rows that could not be imported" compact>
                <thead>
                  <tr>
                    <th scope="col">Your line</th>
                    <th scope="col">What failed</th>
                    <th scope="col">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {result.failures.map((f) => (
                    <tr key={`${f.line}:${f.text}`}>
                      <td className="cq-numeric">{f.line}</td>
                      <td className="cq-table__primary">{f.text}</td>
                      <td>{f.message}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : null}
          </>
        ) : null}

        <ErrorText>{error}</ErrorText>
      </Stack>
    </Drawer>
  );
}

/**
 * Text into rows, keeping the line number each came from.
 *
 * Deliberately forgiving about the separator and deliberately strict about the
 * quantity: a second cell that is not a number is what a header row looks like,
 * and dropping it silently is better than importing "Quantity" as an asset type.
 */
function parseSchedule(text: string): { rows: ParsedRow[]; skipped: number } {
  const rows: ParsedRow[] = [];
  let skipped = 0;

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '') return;

    const cells = (line.includes('\t') ? line.split('\t') : line.split(',')).map((c) =>
      c.trim().replace(/^"|"$/g, '')
    );
    const code = cells[0] ?? '';
    const quantity = Number(cells[1]);
    if (code === '' || cells[1] === undefined || !Number.isFinite(quantity) || quantity < 0) {
      skipped += 1;
      return;
    }
    const weightCell = cells[2] ?? '';
    const weight = weightCell === '' ? null : Number(weightCell);
    rows.push({
      sourceLine: index + 1,
      text: raw,
      assetTypeCode: code,
      quantity,
      unitWeightKg: weight !== null && Number.isFinite(weight) && weight >= 0 ? weight : null,
      description: (cells[3] ?? '').trim() || null,
    });
  });

  return { rows, skipped };
}

// ── Movements ────────────────────────────────────────────────────────────────

const NEW_ORG = '__new__';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Where material went — or, when `source` is set, where it went **next**.
 *
 * The two are one form and two routes, because the guards differ and the mistake
 * is expensive. A continuation closes the leg it names: the storage row stops
 * counting against the ceiling and against pending mass, the new row counts
 * instead, and the project's handled mass does not move by a gram.
 */
function MovementDrawer({
  asset,
  source,
  destinationTypes,
  destinationOrgs,
  locations,
  onOrgCreated,
  onClose,
  onSaved,
}: {
  asset: AssetView;
  source: MovementView | null;
  destinationTypes: readonly DestinationTypeView[];
  destinationOrgs: readonly DestinationOrgView[];
  locations: readonly LocationView[];
  onOrgCreated: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ctx = useSessionCtx();
  const [destinationTypeId, setDestinationTypeId] = useState('');
  const [destinationOrgId, setDestinationOrgId] = useState('');
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgKind, setNewOrgKind] = useState<DestinationOrgKind>('CHARITY');
  const [destinationAddress, setDestinationAddress] = useState('');
  const [fromLocationId, setFromLocationId] = useState(asset.originLocationId ?? '');
  const [quantity, setQuantity] = useState(source ? String(source.quantity) : '');
  const [weightKg, setWeightKg] = useState('');
  const [movedOn, setMovedOn] = useState(today());
  const [distanceKm, setDistanceKm] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = destinationTypes.find((d) => d.id === destinationTypeId) ?? null;
  const parsedQuantity = Number(quantity);
  const parsedWeight = weightKg.trim() === '' ? null : Number(weightKg);
  const parsedDistance = distanceKm.trim() === '' ? null : Number(distanceKm);
  const addingOrg = destinationOrgId === NEW_ORG;
  const canSave =
    destinationTypeId !== '' &&
    quantity.trim() !== '' &&
    Number.isFinite(parsedQuantity) &&
    parsedQuantity > 0 &&
    (parsedWeight === null || (Number.isFinite(parsedWeight) && parsedWeight >= 0)) &&
    (parsedDistance === null || (Number.isFinite(parsedDistance) && parsedDistance >= 0)) &&
    (!addingOrg || newOrgName.trim() !== '') &&
    !busy;

  async function save(): Promise<void> {
    if (!ctx || !canSave) return;
    setBusy(true);
    setError(null);
    try {
      let orgId: string | null = addingOrg ? null : destinationOrgId || null;
      if (addingOrg) {
        const created = await api.createDestinationOrganisation(ctx.accessToken, ctx.companyId, {
          name: newOrgName.trim(),
          kind: newOrgKind,
          clientId: crypto.randomUUID(),
        });
        orgId = created.destinationOrganisation.id;
        onOrgCreated();
      }

      const body = {
        destinationTypeId,
        destinationOrgId: orgId,
        destinationAddress: destinationAddress.trim() || null,
        fromLocationId: fromLocationId || null,
        quantity: parsedQuantity,
        // Null means *derive from the line*, and it keeps deriving: a weighbridge
        // ticket attached to the line later moves this leg with it. A figure here
        // is a claim about this load, and it never moves again.
        weightKg: parsedWeight,
        movedOn,
        distanceKm: parsedDistance,
        documentId: null,
        notes: notes.trim() || null,
        clientId: crypto.randomUUID(),
      };

      if (source) {
        await api.continueMovement(ctx.accessToken, ctx.companyId, source.id, body);
      } else {
        await api.createMovement(ctx.accessToken, ctx.companyId, asset.id, body);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That movement could not be recorded');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      title={
        source
          ? `Move on from ${source.destinationName}`
          : `Where did the ${asset.assetTypeName.toLowerCase()} go?`
      }
      description={
        source
          ? 'This closes the leg it continues. The material stops being counted where it was and starts being counted where it went — the project’s total does not change.'
          : 'One destination per movement. Split the line across as many as it took.'
      }
      onClose={onClose}
      footer={
        <Row>
          <Button disabled={!canSave} onClick={() => void save()}>
            {busy ? 'Recording…' : 'Record movement'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </Row>
      }
    >
      <Stack>
        <div className="cq-form-grid cq-form-grid--drawer">
          <Field label="Destination" wide>
            <Select value={destinationTypeId} onChange={(e) => setDestinationTypeId(e.target.value)}>
              <option value="">Choose a destination…</option>
              {destinationTypes.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.hierarchyTier !== null ? ` — tier ${d.hierarchyTier}` : ''}
                  {d.isSystem ? '' : ' (yours)'}
                </option>
              ))}
            </Select>
          </Field>

          {/*
            What this destination means for the numbers, said before the movement
            is written rather than discovered in a rate afterwards. Storage is the
            one that has to be explicit: it is correct that it counts as nothing,
            and completely silent unless somebody says so.
          */}
          {chosen ? (
            <p className="cq-muted">
              {chosen.isFinalOutcome
                ? `Counts as: ${countsAsSentence(chosen)}.`
                : 'This is not a final outcome. The material stays pending, in no rate at all, until you record where it goes next.'}
            </p>
          ) : null}

          <Field label="Organisation" hint="Who took it. Optional, and only ever your own list.">
            <Select value={destinationOrgId} onChange={(e) => setDestinationOrgId(e.target.value)}>
              <option value="">Not stated</option>
              {destinationOrgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} — {DESTINATION_ORG_KIND_LABELS[o.kind as DestinationOrgKind] ?? o.kind}
                </option>
              ))}
              <option value={NEW_ORG}>Add a new organisation…</option>
            </Select>
          </Field>
          {addingOrg ? (
            <>
              <Field label="Organisation name">
                <Input
                  value={newOrgName}
                  autoFocus
                  placeholder="Bright Futures"
                  onChange={(e) => setNewOrgName(e.target.value)}
                />
              </Field>
              <Field label="Kind">
                <Select
                  value={newOrgKind}
                  onChange={(e) => setNewOrgKind(e.target.value as DestinationOrgKind)}
                >
                  {DESTINATION_ORG_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {DESTINATION_ORG_KIND_LABELS[k]}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          ) : null}

          <Field label="Quantity">
            <Input
              value={quantity}
              inputMode="decimal"
              placeholder={
                source ? formatQuantity(source.quantity) : formatQuantity(asset.quantity)
              }
              onChange={(e) => setQuantity(e.target.value)}
            />
          </Field>
          <Field
            label="Weight of this load (kg)"
            hint="Leave blank to use the line’s rate. A figure here is a weighbridge claim about this load, and it will not be recalculated."
          >
            <Input
              value={weightKg}
              inputMode="decimal"
              onChange={(e) => setWeightKg(e.target.value)}
            />
          </Field>
          <Field label="Moved on">
            <Input type="date" value={movedOn} onChange={(e) => setMovedOn(e.target.value)} />
          </Field>
          <Field label="Distance (km)" hint="Optional. Recorded, and not yet used for any figure.">
            <Input
              value={distanceKm}
              inputMode="decimal"
              onChange={(e) => setDistanceKm(e.target.value)}
            />
          </Field>
          <Field label="Left from" hint="Where on site it went from.">
            <Select value={fromLocationId} onChange={(e) => setFromLocationId(e.target.value)}>
              <option value="">Not stated</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Address" hint="Where it went, when that is not one of your organisations.">
            <Input
              value={destinationAddress}
              onChange={(e) => setDestinationAddress(e.target.value)}
            />
          </Field>
          <Field label="Notes" wide>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <ErrorText>{error}</ErrorText>
      </Stack>
    </Drawer>
  );
}

/** The flags this destination sets, in words, and never one derived from another. */
function countsAsSentence(d: DestinationTypeView): string {
  const parts: string[] = [];
  if (d.countsAsRetainedInUse) parts.push('retained in use');
  if (d.countsAsReuse) parts.push('reuse');
  if (d.countsAsRecycling) parts.push('recycling');
  if (d.countsAsRecovery) parts.push('recovery');
  if (d.countsAsLandfill) parts.push('landfill');
  if (d.countsAsDiverted) parts.push('diverted from landfill');
  return parts.length > 0 ? parts.join(', ') : 'no rate';
}
