'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  formatCarbonKg,
  formatCompleteness,
  formatMassKg,
  formatRate,
  type ClientView,
  type OrgSustainabilityView,
} from '@crewquo/shared';
import {
  Badge,
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
import { api, refusedFeature } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncData } from '@/lib/useAsyncData';
import { useEntitlements } from '@/lib/useEntitlements';
import { FeatureLocked } from '@/components/FeatureLock';

/**
 * The organisation sustainability dashboard (§38.1) — step 9 of the Phase 9 build
 * order, and the last one.
 *
 * §38.1 gives it three rules and every one of them decides something visible here:
 *
 * **"No vanity metrics. Every figure is clickable through to the records behind
 * it."** So the table of projects is the page and the totals are a header on it —
 * not the other way round. A total nobody can decompose is a number nobody can
 * check, and every row links to the project section that produced it.
 *
 * **"Any figure whose data completeness is below a configurable threshold is shown
 * with its completeness percentage attached rather than presented as fact."** The
 * completeness column carries that on every row, and the rows below the threshold
 * are named again above the table, because a column somebody has to scan is not an
 * attachment.
 *
 * **The two headlines are never netted.** There is no combined figure on this page
 * and no expression that could produce one — the response has no field for it.
 *
 * §40's colour rule is why nothing here is green: *"the sustainability module must
 * not be green everywhere — a green wash makes every number look like good news,
 * including the landfill one."* The only tone used is the warning on a completeness
 * figure below the threshold, which is the one place a colour is carrying meaning.
 */
export default function SustainabilityDashboardPage() {
  return (
    <Shell>
      <Dashboard />
    </Shell>
  );
}

function Dashboard() {
  const ctx = useSessionCtx();
  const ent = useEntitlements();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [clientCompanyId, setClientCompanyId] = useState('');
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);

  const clients = useAsyncData<ClientView[]>(
    ctx ? () => api.listClients(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );

  const data = useAsyncData<OrgSustainabilityView>(
    ctx
      ? () =>
          api
            .sustainabilityDashboard(ctx.accessToken, ctx.companyId, {
              from: from === '' ? undefined : from,
              to: to === '' ? undefined : to,
              clientCompanyId: clientCompanyId === '' ? undefined : clientCompanyId,
            })
            .then((r) => r.dashboard)
      : null,
    [ctx?.companyId, from, to, clientCompanyId]
  );

  if (!ent.loading && !ent.has('sustainability')) {
    return <FeatureLocked feature="sustainability" />;
  }

  if (data.error) {
    // A 403 that arrives anyway — the reader's plan has the key and their bundle
    // does not — is a different sentence from a plan refusal, and says which.
    return refusedFeature(data.error) ? (
      <FeatureLocked feature="sustainability" />
    ) : (
      <Stack>
        <PageHeader eyebrow="Reports" title="Sustainability" />
        <ErrorText>{data.error}</ErrorText>
      </Stack>
    );
  }

  const d = data.data;

  return (
    <Stack>
      <PageHeader
        eyebrow="Reports"
        title="Sustainability"
        description="Every project this company owns or works on, and what each one has handled and emitted."
      />

      <Section title="Period">
        <Row>
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Client">
            <Select value={clientCompanyId} onChange={(e) => { setClientCompanyId(e.target.value); setSelectedProjects([]); }}>
              <option value="">All clients</option>
              {clients.data?.map((client) => (
                <option key={client.clientCompanyId} value={client.clientCompanyId}>{client.name}</option>
              ))}
            </Select>
          </Field>
        </Row>
      </Section>

      {data.loading || !d ? (
        <p className="cq-muted">Loading…</p>
      ) : d.projects.length === 0 ? (
        <Section title="Nothing in range">
          <EmptyState title="No projects to report on">
            Figures appear once a project has assets or activity recorded against it. Nothing
            is estimated in the meantime, and an empty period is not a zero-tonne one.
          </EmptyState>
        </Section>
      ) : (
        <>
          <Section
            title="Across every project"
            description={
              d.factorSetNames.length > 1
                ? `This period spans ${d.factorSetNames.length} factor sets: ${d.factorSetNames.join(', ')}. Figures from different sets are not directly comparable.`
                : d.factorSetNames.length === 1
                  ? `Calculated against ${d.factorSetNames[0]}.`
                  : undefined
            }
          >
            <Stack>
              <div className="cq-metrics">
                <div className="cq-metric">
                  <span className="cq-overline">Material handled</span>
                  <div className="cq-metric__value">
                    {formatMassKg(d.totals.handledKg, d.display.massUnit)}
                  </div>
                  <p className="cq-metric__context">
                    {formatMassKg(d.totals.pendingKg, d.display.massUnit)} still pending a final
                    destination
                  </p>
                </div>
                <div className="cq-metric">
                  <span className="cq-overline">Project GHG emissions</span>
                  <div className="cq-metric__value">
                    {formatCarbonKg(d.totals.projectEmissionsKgCo2e, d.display.carbonUnit)}
                  </div>
                  <p className="cq-metric__context">Scope 1, 2 and 3 across {d.totals.projectCount} projects</p>
                </div>
                <div className="cq-metric">
                  <span className="cq-overline">Estimated avoided emissions</span>
                  <div className="cq-metric__value">
                    {formatCarbonKg(d.totals.avoidedKgCo2e, d.display.carbonUnit)}
                  </div>
                  <p className="cq-metric__context">Reported separately · never deducted</p>
                </div>
              </div>

              {d.totals.avoidedKgCo2e !== 0 ? <Notice>{d.methodologyWarning}</Notice> : null}

              <Table label="Diversion rates across every project">
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
                  {/*
                    Reuse above recycling, everywhere it is shown (§25.5, §41.8), and
                    never merged into one "diverted" figure as if they were equivalent
                    — diversion is its own row, reported separately.
                  */}
                  <tr>
                    <td className="cq-table__primary">Retained in use</td>
                    <td className="cq-numeric">{formatRate(d.rates.retainedInUse)}</td>
                    <td className="cq-numeric">
                      {formatMassKg(d.totals.retainedInUseKg, d.display.massUnit)}
                    </td>
                  </tr>
                  <tr>
                    <td className="cq-table__primary">Reuse</td>
                    <td className="cq-numeric">{formatRate(d.rates.reuse)}</td>
                    <td className="cq-numeric">{formatMassKg(d.totals.reuseKg, d.display.massUnit)}</td>
                  </tr>
                  <tr>
                    <td className="cq-table__primary">Recycling</td>
                    <td className="cq-numeric">{formatRate(d.rates.recycling)}</td>
                    <td className="cq-numeric">
                      {formatMassKg(d.totals.recyclingKg, d.display.massUnit)}
                    </td>
                  </tr>
                  <tr>
                    <td className="cq-table__primary">Energy recovery</td>
                    <td className="cq-numeric">{formatRate(d.rates.recovery)}</td>
                    <td className="cq-numeric">
                      {formatMassKg(d.totals.recoveryKg, d.display.massUnit)}
                    </td>
                  </tr>
                  <tr>
                    <td className="cq-table__primary">Landfill</td>
                    <td className="cq-numeric">{formatRate(d.rates.landfill)}</td>
                    <td className="cq-numeric">
                      {formatMassKg(d.totals.landfillKg, d.display.massUnit)}
                    </td>
                  </tr>
                  <tr>
                    <td className="cq-table__primary">Diversion from landfill</td>
                    <td className="cq-numeric">{formatRate(d.rates.diverted)}</td>
                    <td className="cq-numeric">
                      {formatMassKg(d.totals.divertedKg, d.display.massUnit)}
                    </td>
                  </tr>
                </tbody>
              </Table>

              <Notice>
                These rates are shares of the {formatMassKg(d.totals.allocatedKg, d.display.massUnit)}{' '}
                that has reached a final destination.{' '}
                {d.totals.pendingKg > 0
                  ? `A further ${formatMassKg(d.totals.pendingKg, d.display.massUnit)} is still pending and is in none of them — not counted as diverted, and not counted as landfill.`
                  : 'Nothing is pending, so they are also shares of everything handled.'}
              </Notice>

              {d.belowThreshold.length > 0 ? (
                <Notice>
                  <strong>
                    {d.belowThreshold.length}{' '}
                    {d.belowThreshold.length === 1 ? 'project is' : 'projects are'} below{' '}
                    {d.warnBelow}% data completeness
                  </strong>{' '}
                  — their figures above are a floor rather than a total:{' '}
                  {d.belowThreshold.map((p, i) => (
                    <span key={p.projectId}>
                      {i > 0 ? ', ' : ''}
                      <Link href={`/projects/${p.projectId}?section=sustainability`}>
                        {p.projectName}
                      </Link>{' '}
                      ({Math.round(p.pct)}%)
                    </span>
                  ))}
                  .
                </Notice>
              ) : null}
            </Stack>
          </Section>

          <Section
            title="Compare projects"
            description="Select projects in the table below. Differences are against the first selected project; unknown carbon stays unknown."
          >
            {selectedProjects.length < 2 ? (
              <p className="cq-muted">Select at least two projects to compare them side by side.</p>
            ) : (
              <Table label="Cross-project comparison">
                <thead><tr><th scope="col">Project</th><th scope="col" className="cq-numeric">Handled</th><th scope="col" className="cq-numeric">Diversion</th><th scope="col" className="cq-numeric">Emissions</th><th scope="col" className="cq-numeric">Completeness</th><th scope="col" className="cq-numeric">Handled vs first</th></tr></thead>
                <tbody>
                  {selectedProjects.map((id, index) => {
                    const project = d.projects.find((row) => row.projectId === id);
                    const baseline = d.projects.find((row) => row.projectId === selectedProjects[0]);
                    if (!project || !baseline) return null;
                    const delta = project.handledKg - baseline.handledKg;
                    return <tr key={id}>
                      <td className="cq-table__primary"><Link href={`/projects/${id}?section=sustainability`}>{project.projectName}</Link>{index === 0 ? <span className="cq-table__note">Baseline</span> : null}</td>
                      <td className="cq-numeric">{formatMassKg(project.handledKg, d.display.massUnit)}</td>
                      <td className="cq-numeric">{project.allocatedKg === 0 ? '—' : formatRate(project.divertedKg / project.allocatedKg)}</td>
                      <td className="cq-numeric">{project.projectEmissionsKgCo2e === null ? '—' : formatCarbonKg(project.projectEmissionsKgCo2e, d.display.carbonUnit)}</td>
                      <td className="cq-numeric">{formatCompleteness(project.completenessPct)}</td>
                      <td className="cq-numeric">{index === 0 ? '—' : `${delta > 0 ? '+' : ''}${formatMassKg(delta, d.display.massUnit)}`}</td>
                    </tr>;
                  })}
                </tbody>
              </Table>
            )}
          </Section>

          <Section
            title="By project"
            description="Every figure here clicks through to the records behind it."
          >
            <Table label="Sustainability by project">
              <thead>
                <tr>
                  <th scope="col">Compare</th>
                  <th scope="col">Project</th>
                  <th scope="col" className="cq-numeric">
                    Handled
                  </th>
                  <th scope="col" className="cq-numeric">
                    Diverted
                  </th>
                  <th scope="col" className="cq-numeric">
                    Emissions
                  </th>
                  <th scope="col" className="cq-numeric">
                    Avoided
                  </th>
                  <th scope="col" className="cq-numeric">
                    Completeness
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.projects.map((p) => (
                  <tr key={p.projectId}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Compare ${p.projectName}`}
                        checked={selectedProjects.includes(p.projectId)}
                        onChange={(event) => setSelectedProjects((current) => event.target.checked ? [...current, p.projectId] : current.filter((id) => id !== p.projectId))}
                      />
                    </td>
                    <td className="cq-table__primary">
                      <Link href={`/projects/${p.projectId}?section=sustainability`}>
                        {p.projectName}
                      </Link>
                      {p.clientCompanyName ? (
                        <span className="cq-table__note">For {p.clientCompanyName}</span>
                      ) : null}
                    </td>
                    <td className="cq-numeric">{formatMassKg(p.handledKg, d.display.massUnit)}</td>
                    <td className="cq-numeric">
                      {p.allocatedKg === 0
                        ? '—'
                        : formatRate(p.divertedKg / p.allocatedKg)}
                    </td>
                    {/*
                      An em dash, never 0.00 tCO₂e. A project with no factor set has
                      not emitted nothing — nobody has measured it, and a zero in a
                      dashboard column is the most confident possible way to say the
                      opposite.
                    */}
                    <td className="cq-numeric">
                      {p.projectEmissionsKgCo2e === null
                        ? '—'
                        : formatCarbonKg(p.projectEmissionsKgCo2e, d.display.carbonUnit)}
                    </td>
                    <td className="cq-numeric">
                      {p.avoidedKgCo2e === null
                        ? '—'
                        : formatCarbonKg(p.avoidedKgCo2e, d.display.carbonUnit)}
                    </td>
                    <td className="cq-numeric">
                      {p.completenessPct !== null && p.completenessPct < d.warnBelow ? (
                        <Badge tone="warning">{formatCompleteness(p.completenessPct)}</Badge>
                      ) : (
                        formatCompleteness(p.completenessPct)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Section>
        </>
      )}
    </Stack>
  );
}
