import Link from 'next/link';
import styles from './landing.module.css';

const capabilities = [
  ['01', 'Commercial control', 'Separate PAY and BILL rates, effective dates, holiday rules and live project margin—without exposing your markup to providers.'],
  ['02', 'Crew & field operations', 'Plan people, subcontractors and vehicles. Capture time, expenses, diaries, variations and approvals from the site.'],
  ['03', 'Evidence & compliance', 'Keep project photos, documents, signatures and compliance records attached to the work they prove.'],
  ['04', 'Assets & destinations', 'Track items in bulk or individually, record weight provenance and follow every split movement to its final outcome.'],
  ['05', 'Sustainability accounting', 'Calculate operational and waste emissions from versioned factors, with avoided emissions reported separately and transparently.'],
  ['06', 'Client-ready reporting', 'Give clients a controlled portal, immutable sign-off and reproducible evidence, completion and sustainability reports.'],
] as const;

const workflow = [
  ['Plan', 'Scope the job, budget the work and schedule the right crew.'],
  ['Deliver', 'Run the day from a focused supervisor workspace.'],
  ['Capture', 'Record time, evidence, costs, assets and destinations once.'],
  ['Control', 'Approve work, monitor variance and protect commercial data.'],
  ['Report', 'Produce a defensible client record from the same source data.'],
] as const;

export default function LandingPage() {
  return (
    <div className={styles.site}>
      <a className={styles.skipLink} href="#main-content">Skip to content</a>
      <header className={styles.header}>
        <div className={styles.navInner}>
          <Link className={styles.brand} href="/" translate="no">
            <span className={styles.brandMark} aria-hidden="true">CQ</span>
            <span>CrewQuo</span>
          </Link>
          <nav className={styles.navLinks} aria-label="Main navigation">
            <a href="#platform">Platform</a>
            <a href="#operations">Operations</a>
            <a href="#sustainability">Sustainability</a>
            <a href="#reporting">Reporting</a>
          </nav>
          <Link className={styles.signIn} href="/login">Open workspace <span aria-hidden="true">↗</span></Link>
        </div>
      </header>

      <main id="main-content">
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>Contractor operations software</p>
            <h1>Run the job.<br />Know the margin.<br />Prove the outcome.</h1>
            <p className={styles.heroLead}>CrewQuo connects commercial control, crews, subcontractors, field evidence, assets and sustainability reporting in one operational record.</p>
            <div className={styles.heroActions}>
              <Link className={styles.primaryAction} href="/login">Open CrewQuo</Link>
              <a className={styles.secondaryAction} href="#platform">Explore the platform <span aria-hidden="true">↓</span></a>
            </div>
            <dl className={styles.heroPrinciples}>
              <div><dt>One source</dt><dd>From rate card to client report</dd></div>
              <div><dt>One-hop privacy</dt><dd>Commercial data stays protected</dd></div>
              <div><dt>Full traceability</dt><dd>Every result links to its evidence</dd></div>
            </dl>
          </div>

          <div className={styles.productFrame} aria-label="CrewQuo project operations preview">
            <div className={styles.frameTopbar}>
              <span className={styles.frameBrand}><span className={styles.miniMark}>CQ</span> CrewQuo</span>
              <span className={styles.frameCompany}>Northstar Projects / Harbour House</span>
              <span className={styles.avatar}>NP</span>
            </div>
            <div className={styles.frameBody}>
              <aside className={styles.frameRail} aria-hidden="true">
                <span className={styles.railActive}>Overview</span><span>Schedule</span><span>Crew</span><span>Time & costs</span><span>Site diary</span><span>Evidence</span><span>Assets</span><span>Sustainability</span><span>Reports</span>
              </aside>
              <div className={styles.frameContent}>
                <div className={styles.projectHeading}>
                  <div><span className={styles.kicker}>ACTIVE PROJECT · NS-2418</span><strong>Harbour House clearance</strong><small>London · 08–19 Sep 2026</small></div>
                  <span className={styles.status}>On track</span>
                </div>
                <div className={styles.frameMetrics}>
                  <FrameMetric label="Contract value" value="£42,800" meta="Approved" />
                  <FrameMetric label="Actual cost" value="£28,460" meta="66.5% of revenue" />
                  <FrameMetric label="Gross margin" value="£14,340" meta="33.5%" positive />
                  <FrameMetric label="Crew today" value="18" meta="3 providers" />
                </div>
                <div className={styles.frameSplit}>
                  <div className={styles.workPanel}>
                    <div className={styles.panelHeading}><strong>Today’s operation</strong><span>Monday, 14 Sep</span></div>
                    <table className={styles.previewTable}>
                      <thead><tr><th>Team</th><th>Area</th><th>Progress</th><th>Status</th></tr></thead>
                      <tbody>
                        <tr><td>Clearance crew</td><td>Floor 3</td><td><Progress value="82%" width="82%" /></td><td><span className={styles.good}>Active</span></td></tr>
                        <tr><td>ITAD team</td><td>Comms room</td><td><Progress value="64%" width="64%" /></td><td><span className={styles.good}>Active</span></td></tr>
                        <tr><td>Reuse partner</td><td>Loading bay</td><td><Progress value="100%" width="100%" /></td><td><span className={styles.complete}>Complete</span></td></tr>
                      </tbody>
                    </table>
                  </div>
                  <div className={styles.activityPanel}>
                    <div className={styles.panelHeading}><strong>Attention</strong><span>3 items</span></div>
                    <ul>
                      <li><span className={styles.alertDot} />4 time logs await approval<small>Commercial review</small></li>
                      <li><span className={styles.warnDot} />420 kg has no final destination<small>Assets & materials</small></li>
                      <li><span className={styles.neutralDot} />Diary closes at 18:00<small>Site record</small></li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.sectorBar} aria-label="Industries served">
          <p>Built for subcontractor-heavy field operations</p>
          <div><span>Commercial removals</span><span>Office clearance</span><span>Fit-out</span><span>Facilities</span><span>ITAD</span><span>Reuse & recycling</span></div>
        </section>

        <section className={styles.platform} id="platform">
          <div className={styles.sectionIntro}>
            <p className={styles.eyebrow}>One operational system</p>
            <h2>Follow every job from mobilisation to client sign-off.</h2>
            <p>The commercial record, the site record and the sustainability record stay connected—because they belong to the same project.</p>
          </div>
          <ol className={styles.workflow}>
            {workflow.map(([title, body], index) => <li key={title}><span className={styles.workflowNumber}>0{index + 1}</span><strong>{title}</strong><p>{body}</p></li>)}
          </ol>
        </section>

        <section className={styles.capabilitySection} id="operations">
          <div className={styles.capabilityIntro}>
            <p className={styles.eyebrow}>The complete platform</p>
            <h2>Operational depth where the work actually happens.</h2>
            <p>CrewQuo replaces the disconnected rate sheets, timesheets, camera rolls, waste logs and reporting workbooks that make commercial jobs hard to control.</p>
          </div>
          <div className={styles.capabilityList}>
            {capabilities.map(([number, title, body]) => <div className={styles.capabilityRow} key={number}><span>{number}</span><h3>{title}</h3><p>{body}</p></div>)}
          </div>
        </section>

        <section className={styles.commercialSection}>
          <div className={styles.commercialCopy}>
            <p className={styles.eyebrow}>Commercial command</p>
            <h2>Margin is a live operational number, not a month-end surprise.</h2>
            <p>Resolve PAY and BILL rates from the job context, freeze provider cost when work is submitted, and compare approved actuals with budget and variations.</p>
            <ul className={styles.checkList}>
              <li>Effective-dated hourly, shift and daily rates</li>
              <li>Provider PAY kept separate from client BILL</li>
              <li>Holiday, overtime and minimum-hour rules</li>
              <li>Budget, actual and variance by cost category</li>
            </ul>
          </div>
          <div className={styles.financeView}>
            <div className={styles.financeHeader}><div><span>PROJECT PERFORMANCE</span><strong>Harbour House · Cost control</strong></div><span>Updated today, 16:42</span></div>
            <div className={styles.financeTotals}><FrameMetric label="Budget" value="£31,200" meta="Cost plan" /><FrameMetric label="Actual" value="£28,460" meta="Approved + committed" /><FrameMetric label="Remaining" value="£2,740" meta="8.8%" positive /></div>
            <table className={styles.financeTable}>
              <thead><tr><th>Category</th><th>Budget</th><th>Actual</th><th>Variance</th></tr></thead>
              <tbody>
                <tr><td>Labour</td><td>£16,400</td><td>£17,240</td><td className={styles.over}>+£840</td></tr>
                <tr><td>Subcontractors</td><td>£8,600</td><td>£7,980</td><td className={styles.under}>−£620</td></tr>
                <tr><td>Vehicles & mileage</td><td>£3,800</td><td>£2,940</td><td className={styles.under}>−£860</td></tr>
                <tr><td>Waste & materials</td><td>£2,400</td><td>£300</td><td className={styles.under}>−£2,100</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className={styles.sustainabilitySection} id="sustainability">
          <div className={styles.sustainabilityTop}>
            <div>
              <p className={styles.eyebrow}>Evidence-led sustainability</p>
              <h2>Report outcomes with the source record still attached.</h2>
            </div>
            <p>Weights retain their provenance. Destinations follow the waste hierarchy. Emissions resolve against versioned factor sets. Avoided emissions remain separate from the project inventory.</p>
          </div>
          <div className={styles.sustainabilityBoard}>
            <div className={styles.massColumn}>
              <div className={styles.boardLabel}>MATERIAL OUTCOMES</div>
              <div className={styles.massTotal}><strong>21.72 t</strong><span>Total material handled</span></div>
              <Outcome label="Retained & relocated" value="4.50 t" width="21%" tone="blue" />
              <Outcome label="Reused & donated" value="7.92 t" width="36%" tone="navy" />
              <Outcome label="Recycled" value="7.18 t" width="33%" tone="gray" />
              <Outcome label="Recovery & landfill" value="0.78 t" width="4%" tone="amber" />
              <Outcome label="Pending destination" value="1.34 t" width="6%" tone="light" />
            </div>
            <div className={styles.carbonColumn}>
              <div className={styles.boardLabel}>CARBON ACCOUNT</div>
              <div className={styles.carbonFigures}>
                <div><span>Project GHG emissions</span><strong>3.84 <small>tCO₂e</small></strong><p>Scope 1, 2 & 3 inventory</p></div>
                <div><span>Estimated avoided emissions</span><strong>27.42 <small>tCO₂e</small></strong><p>Comparative estimate · reported separately</p></div>
              </div>
              <div className={styles.qualityRow}><div><span>Data completeness</span><strong>92%</strong></div><div className={styles.qualityTrack}><span /></div></div>
              <p className={styles.inlineWarning}><span aria-hidden="true">!</span> 1.34 t is awaiting a final destination and is excluded from outcome rates.</p>
            </div>
          </div>
        </section>

        <section className={styles.fieldSection}>
          <div className={styles.phone} aria-label="CrewQuo supervisor mobile workspace preview">
            <div className={styles.phoneBar}><span>09:41</span><strong>CrewQuo</strong><span>●●●</span></div>
            <div className={styles.phoneBody}>
              <span className={styles.kicker}>TODAY · MON 14 SEP</span>
              <h3>Harbour House</h3><p>London · Floor 3</p>
              <span className={styles.startShift}>Start shift</span>
              <div className={styles.mobileActions}><span>Crew<small>18 on site</small></span><span>Tasks<small>6 open</small></span><span>Add photo<small>Evidence</small></span><span>Site diary<small>Open</small></span><span>Assets<small>126 lines</small></span><span>Waste / reuse<small>3 pending</small></span><span>Expense<small>Add cost</small></span><span>Variation<small>Extra works</small></span></div>
              <div className={styles.completeDay}>Complete day <span>→</span></div>
            </div>
          </div>
          <div className={styles.fieldCopy}>
            <p className={styles.eyebrow}>Built for the loading bay</p>
            <h2>A focused field experience, not the desktop squeezed onto a phone.</h2>
            <p>Supervisors get the project, date and location pre-filled. One tap opens the job they need: add evidence, close the diary, record removed assets, log a cost or capture client sign-off.</p>
            <div className={styles.fieldStats}><div><strong>1</strong><span>project context</span></div><div><strong>1×</strong><span>data entry</span></div><div><strong>1</strong><span>shared record</span></div></div>
          </div>
        </section>

        <section className={styles.reportingSection} id="reporting">
          <div className={styles.reportCopy}>
            <p className={styles.eyebrow}>Client confidence</p>
            <h2>Turn the project record into a report your client can use.</h2>
            <p>Generate completion, evidence and sustainability packs from approved source data. Every published report freezes its figures, factors, assumptions and evidence set for reproducible re-rendering.</p>
          </div>
          <div className={styles.reportPreview}>
            <div className={styles.reportPaper}>
              <div className={styles.reportMasthead}><span className={styles.miniMark}>CQ</span><span>PROJECT COMPLETION & SUSTAINABILITY REPORT</span></div>
              <div className={styles.reportTitle}><span>HARBOUR HOUSE</span><strong>Clearance & asset recovery</strong><p>08–19 September 2026 · Northstar Projects</p></div>
              <div className={styles.reportStats}><div><strong>21.72 t</strong><span>Material handled</span></div><div><strong>91.8%</strong><span>Diverted from landfill</span></div><div><strong>62.4%</strong><span>Retained in use</span></div></div>
              <div className={styles.reportFooter}><span>Evidence-backed · Methodology disclosed</span><span>Page 01 / 24</span></div>
            </div>
            <div className={styles.reportIndex}><span>01 Executive summary</span><span>02 Project overview</span><span>03 Asset outcomes</span><span>04 Carbon summary</span><span>05 Evidence</span><span>06 Client sign-off</span></div>
          </div>
        </section>

        <section className={styles.trustSection}>
          <div><p className={styles.eyebrow}>Controls by design</p><h2>Operational access without commercial leakage.</h2></div>
          <dl>
            <div><dt>Company-scoped</dt><dd>Every request resolves the active company and membership before data is selected.</dd></div>
            <div><dt>One-hop visibility</dt><dd>Companies see only the direct client or provider relationship they are part of.</dd></div>
            <div><dt>PAY/BILL guard</dt><dd>Providers can never read the client-side bill rate or computed margin.</dd></div>
            <div><dt>Immutable history</dt><dd>Approvals, revisions, sign-offs and reports retain a defensible audit trail.</dd></div>
          </dl>
        </section>

        <section className={styles.finalCta}>
          <p className={styles.eyebrow}>CrewQuo</p>
          <h2>One job. One operational record.<br />No gaps between the site and the numbers.</h2>
          <Link className={styles.primaryAction} href="/login">Open your workspace</Link>
        </section>
      </main>

      <footer className={styles.footer}>
        <Link className={styles.brand} href="/" translate="no"><span className={styles.brandMark} aria-hidden="true">CQ</span><span>CrewQuo</span></Link>
        <p>Professional contractor operations software.</p>
        <p>© 2026 CrewQuo</p>
      </footer>
    </div>
  );
}

function FrameMetric({ label, value, meta, positive }: { label: string; value: string; meta: string; positive?: boolean }) {
  return <div className={styles.frameMetric}><span>{label}</span><strong>{value}</strong><small className={positive ? styles.positive : undefined}>{meta}</small></div>;
}

function Progress({ value, width }: { value: string; width: string }) {
  return <span className={styles.progress}><span><i style={{ width }} /></span><small>{value}</small></span>;
}

function Outcome({ label, value, width, tone }: { label: string; value: string; width: string; tone: 'blue' | 'navy' | 'gray' | 'amber' | 'light' }) {
  return <div className={styles.outcome}><div><span>{label}</span><strong>{value}</strong></div><div className={styles.outcomeTrack}><span className={styles[tone]} style={{ width }} /></div></div>;
}
