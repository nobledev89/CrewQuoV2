import {
  computeMassBalance,
  type ClientExportSnapshot,
  type ClientPeriodSnapshot,
  type ReportAudience,
  type ReportSectionKey,
  type ReportSnapshot,
  type ReportSnapshotMeta,
} from '@crewquo/shared';
import { query, queryOne } from '../../db';
import { AppError } from '../../http/errors';
import { destinationNames, loadForBalance } from '../assets/massBalance';
import { getPortalLineItems } from '../portal/repo';
import { loadProjectCarbonView } from '../sustainability/projectCarbon';
import { contentHash } from './seal';
import {
  massRows,
  metaFor,
  resolveClientBranding,
  sealed,
  type BuildArgs,
  type SnapshotResult,
} from './snapshot';
import { loadMaterials, loadProjectHeader, loadSourceRevisions } from './sources';

/**
 * The two documents that go **to** a client rather than about one — §29.5's
 * project statement and §38.2's period roll-up. Steps 10.7 and 10.9.
 *
 * A separate file from `snapshot.ts`, and the separation is the point rather than
 * a size decision. Everything in here consumes the portal's own types and the
 * §28.2 metric definitions; there is no code path in this file that has ever held
 * a PAY figure, a rate snapshot or a provider name, so there is nothing to
 * remember to strip.
 */

// ── §29.5: the client-facing project export ──────────────────────────────────

/**
 * The BILL-side statement, built out of the portal's own types.
 *
 * §29.5 in its own words: *"Build the renderer's input from the existing
 * `PortalProjectView` / `PortalLineItem` types in `packages/shared`. Those types
 * structurally exclude the owner's PAY columns and every provider identity (that
 * is why they exist as a separate type rather than a filtered `ProjectView`), so
 * the exclusion cannot be forgotten by a later edit the way a `select` list can."*
 *
 * `getPortalLineItems` is the same function the client's portal screen calls, so
 * the document and the screen cannot disagree about a figure — which is the whole
 * reason the client's download was moved out of Phase 4 and into §29.4's snapshot.
 *
 * There is no audience parameter because there is only one audience: `0043`'s
 * check constraint refuses an INTERNAL client-export outright. The owner's own
 * project export is Phase 4's live one, which shows cost and margin.
 */
export async function buildClientExportSnapshot(args: BuildArgs): Promise<SnapshotResult> {
  const header = await loadProjectHeader(args.projectId);
  if (!header) throw new AppError('NOT_FOUND', 'Project not found');
  if (!header.client_company_id) {
    throw new AppError('VALIDATION', 'This project has no client, so it has no client statement');
  }

  const [lines, revisions, carbon] = await Promise.all([
    getPortalLineItems({
      id: header.id,
      ownerCompanyId: header.owner_company_id,
      clientCompanyId: header.client_company_id,
      reportingCurrency: header.reporting_currency,
    }),
    loadSourceRevisions(args.projectId),
    loadProjectCarbonView(args.projectId, header.owner_company_id),
  ]);

  const body: ClientExportSnapshot = {
    kind: 'CLIENT_EXPORT',
    project: {
      id: header.id,
      name: header.name,
      status: header.status,
      startsOn: header.starts_on,
      endsOn: header.ends_on,
    },
    currency: header.reporting_currency,
    lineItems: lines.lineItems,
    timeTotalCents: lines.timeTotalCents,
    expenseTotalCents: lines.expenseTotalCents,
    totalCents: lines.timeTotalCents + lines.expenseTotalCents,
    /*
     * False means at least one approved line had no covering BILL card, and the
     * total is a floor rather than the bill. §41.1 in money: a line nobody priced
     * is not a line that cost nothing, and the renderer says so on the page rather
     * than printing a total a reader would take as complete.
     */
    pricingComplete: lines.pricingComplete,
  };

  const meta = metaFor({
    header,
    audience: 'CLIENT',
    kind: 'CLIENT_EXPORT',
    title: args.title ?? `${header.name} — Project Statement`,
    sections: args.sections,
    branding: resolveClientBranding(header),
    factorSets: carbon.factorSets,
    revisions,
    display: carbon.display,
    files: [],
  });

  return sealed(meta, body, header.client_company_id);
}

// ── §38.2: the client period roll-up ─────────────────────────────────────────

/**
 * Every legal identity a client has traded under (packet finding 8).
 *
 * §38.2: *"following `claimed_by_company_id` tombstones so a placeholder that later
 * signed up still aggregates with its own history"*. The column lives on the
 * **placeholder** and names the real company, so a plain
 * `where client_company_id = $1` returns only the projects booked after they
 * signed up and silently omits the older half — a client's annual total that
 * quietly halves, in the direction that understates, with nothing on the document
 * saying so.
 *
 * The resolved set is frozen into the snapshot so a reader can see which
 * identities the total covers rather than having to trust that it covered them.
 */
export function resolveClientIdentities(
  clientCompanyId: string
): Promise<{ companyId: string; name: string; placeholder: boolean }[]> {
  return query<{ companyId: string; name: string; placeholder: boolean }>(
    `select c.id as "companyId", c.name, c.is_placeholder as placeholder
       from companies c
      where c.id = $1 or c.claimed_by_company_id = $1
      order by c.is_placeholder, c.name`,
    [clientCompanyId]
  );
}

export interface PeriodBuildArgs {
  companyId: string;
  clientCompanyId: string;
  periodStart: string;
  periodEnd: string;
  sections: ReportSectionKey[];
  audience: ReportAudience;
  title?: string;
}

/**
 * §38.2's roll-up, and **the metric definitions are summed, never re-derived**.
 *
 * §38.2's own words: *"reuses the project metric definitions in §28.2 — summed,
 * never re-derived by a second code path"*. So this loads each project's
 * `AssetForBalance` set and runs the same `computeMassBalance` the project section
 * runs, then adds the results. A SQL aggregate over movements would be a second
 * definition of diversion, and the two would disagree the first time somebody
 * recorded a continuation out of storage.
 *
 * **Scoped to projects the generating company owns**, which is the check that is
 * easy to miss: resolving a client identity is not a licence to read projects
 * belonging to a different owner that happen to name the same client.
 */
export async function buildClientPeriodSnapshot(args: PeriodBuildArgs): Promise<SnapshotResult> {
  const identities = await resolveClientIdentities(args.clientCompanyId);
  if (identities.length === 0) throw new AppError('NOT_FOUND', 'Client not found');
  const ids = identities.map((i) => i.companyId);

  const [company, projects] = await Promise.all([
    queryOne<{ name: string }>(`select name from companies where id = $1`, [args.companyId]),
    query<{ id: string; name: string; starts_on: string | null; ends_on: string | null }>(
      `select p.id, p.name,
              to_char(p.starts_on, 'YYYY-MM-DD') as starts_on,
              to_char(p.ends_on, 'YYYY-MM-DD') as ends_on
         from projects p
        where p.owner_company_id = $1
          and p.client_company_id = any($2::uuid[])
          -- OVERLAP, not containment. A project that ran across the period
          -- boundary is part of that year's work, and requiring it to fit entirely
          -- inside would silently drop every long job from every annual report.
          and (p.starts_on is null or p.starts_on <= $4::date)
          and (p.ends_on is null or p.ends_on >= $3::date)
        order by p.starts_on nulls last, p.name`,
      [args.companyId, ids, args.periodStart, args.periodEnd]
    ),
  ]);

  let totalMassKg = 0;
  let allocatedKg = 0;
  let retainedKg = 0;
  let divertedKg = 0;
  let emissions: number | null = null;
  let avoided: number | null = null;
  const outcomeTotals = new Map<string, number>();
  const materialTotals = new Map<string, number>();
  const factorSets = new Map<string, ReportSnapshotMeta['factorSets'][number]>();
  const projectRows: ClientPeriodSnapshot['projects'] = [];

  for (const project of projects) {
    const [assets, names, materials, carbon] = await Promise.all([
      loadForBalance(project.id),
      destinationNames(project.id),
      loadMaterials(project.id),
      loadProjectCarbonView(project.id, args.companyId),
    ]);
    const balance = computeMassBalance(assets);

    totalMassKg += balance.handledKg;
    allocatedKg += balance.allocatedKg;
    for (const d of balance.byDestination) {
      const label = names.get(d.code) ?? d.code;
      outcomeTotals.set(label, (outcomeTotals.get(label) ?? 0) + d.massKg);
      if (d.countsAs.includes('RETAINED_IN_USE')) retainedKg += d.massKg;
      if (d.countsAs.includes('DIVERTED')) divertedKg += d.massKg;
    }
    for (const m of materials) {
      materialTotals.set(m.category, (materialTotals.get(m.category) ?? 0) + Number(m.mass_kg));
    }
    /*
     * Null and zero stay distinct all the way up (§41.1). A period in which no
     * project has been calculated reports **no figure**, not a total of zero; a
     * period in which one has reports that one. Folding a null in as zero would
     * silently claim the uncalculated projects emitted nothing, which is the
     * favourable direction and therefore the one to refuse.
     */
    if (carbon.projectEmissionsKgCo2e !== null) {
      emissions = (emissions ?? 0) + carbon.projectEmissionsKgCo2e;
    }
    if (carbon.avoidedKgCo2e !== null) avoided = (avoided ?? 0) + carbon.avoidedKgCo2e;
    for (const set of carbon.factorSets) factorSets.set(set.id, set);

    projectRows.push({
      id: project.id,
      name: project.name,
      startsOn: project.starts_on,
      endsOn: project.ends_on,
      massKg: balance.handledKg,
    });
  }

  const factorYears = [...new Set([...factorSets.values()].map((f) => f.reportingYear))].sort();

  const body: ClientPeriodSnapshot = {
    kind: 'CLIENT_PERIOD',
    client: {
      name: identities.find((i) => i.companyId === args.clientCompanyId)?.name ?? 'Client',
      identities,
    },
    projectCount: projectRows.length,
    projects: projectRows,
    totalMassKg,
    materials: massRows(
      [...materialTotals.entries()].map(([label, massKg]) => ({ label, massKg })),
      allocatedKg
    ),
    outcomes: massRows(
      [...outcomeTotals.entries()].map(([label, massKg]) => ({ label, massKg })),
      allocatedKg
    ),
    rates: {
      retainedInUsePct: allocatedKg > 0 ? (retainedKg / allocatedKg) * 100 : null,
      diversionPct: allocatedKg > 0 ? (divertedKg / allocatedKg) * 100 : null,
    },
    carbon: { projectEmissionsKgCo2e: emissions, avoidedKgCo2e: avoided },
    // §38.2: "a period spanning two factor sets says so."
    mixedFactorYears: factorYears.length > 1,
    factorYears,
  };

  const settings = await queryOne<{ report_disclaimer: string; report_logo_file_id: string | null }>(
    `select report_disclaimer, report_logo_file_id
       from sustainability_settings where company_id = $1`,
    [args.companyId]
  );

  const meta: ReportSnapshotMeta = {
    schemaVersion: 1,
    kind: 'CLIENT_PERIOD',
    audience: args.audience,
    title: args.title ?? `${body.client.name} — ${args.periodStart} to ${args.periodEnd}`,
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    contractor: {
      companyId: args.companyId,
      name: company?.name ?? 'Contractor',
      logoFileId: settings?.report_logo_file_id ?? null,
    },
    client: {
      companyId: args.clientCompanyId,
      name: body.client.name,
      logoFileId: null,
      logoSource: 'NONE',
    },
    disclaimer: settings?.report_disclaimer ?? '',
    sections: args.sections,
    factorSets: [...factorSets.values()],
    /*
     * Empty, deliberately. A period report cites many projects, and a staleness
     * banner naming forty amended diary days would be noise on a document whose
     * unit of citation is the project. Each project has its own report with its
     * own revisions, which is where that question belongs.
     */
    sourceRevisions: [],
    fileIds: settings?.report_logo_file_id ? [settings.report_logo_file_id] : [],
    display: { carbonUnit: 'AUTO', massUnit: 'AUTO' },
  };

  const snapshot: ReportSnapshot = { meta, body };
  return {
    snapshot,
    contentHash: contentHash(snapshot),
    factorSetIds: [...factorSets.keys()],
    clientCompanyId: args.clientCompanyId,
    files: settings?.report_logo_file_id
      ? [{ fileId: settings.report_logo_file_id, role: 'LOGO' as const }]
      : [],
  };
}
