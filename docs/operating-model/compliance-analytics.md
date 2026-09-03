# Operating-model packet — compliance & analytics

> Plan reference: §19.5. This packet answers the twelve planning gates before
> Phase 12 hardens the domain.

**Domain:** subcontractor compliance records, expiry escalation, optional
enforcement, portfolio analytics and client-period reports
**Phase:** 12 · **Status:** adopted · **Last updated:** 2026-09-03
**Plan refs:** §33, §38.1–§38.2, §41, §43–§44

## 0. Decisions the Phase 12 text requires but its DDL cannot express

1. `compliance_documents.mandatory` is added. Without it, the sentence “expired
   mandatory document” has no data behind the word *mandatory* and turning on
   `enforce_compliance` would either block on every optional certificate or on
   nothing.
2. Renewals are append-only through `supersedes_id`. Replacing `file_id` in place
   destroys the evidence that was relied on yesterday; leaving the old expired row
   current blocks the provider forever. One live successor per row makes “current”
   unambiguous under concurrency.
3. A self-filed document (`owner_company_id = subject_company_id`) is readable by
   every direct hiring company. A document tracked by one hirer is not leaked to a
   different hirer. This is the narrow reading of “upload once” that preserves the
   one-hop rule.
4. Status is derived from the record and the tracking company’s local date:
   `REJECTED` is an explicit review decision; no file is `MISSING`; past expiry is
   `EXPIRED`; 0–90 days is `EXPIRING`; otherwise `VALID`.
5. Compliance never blocks unless the project owner has explicitly enabled
   `enforce_compliance`. With it off, schedule writes succeed and return named
   warnings. With it on, expired, rejected or missing mandatory kinds refuse a
   provider booking or provider submission with those records named.
6. “Advanced analytics” means filterable, row-first portfolio comparison with
   explicit deltas between selected projects. It does not mean a second calculator,
   predictive scoring or a net-carbon figure.
7. The Phase 7 artifact-retention debt is discharged here. Project evidence and
   document bytes age from project completion/archival using the current plan's
   `artifact_retention_days` (Crew 1 year, Starter 3 years, Pro/Business 7 years,
   Enterprise indefinite). Signatures and company-level files are permanent;
   temporary project exports are 30 days. A frozen report/sign-off reference and
   variation approval evidence are holds. Metadata survives byte reclamation, and
   object deletion is a durable retry queue.

## 1. Persona / job

**Marta, compliance manager.** Desktop, reliable office connection. She records
what a subcontractor must hold, reviews a supplied certificate, sees the whole
portfolio ordered by urgency and replaces a lapsed version without erasing it.

**Femi, subcontractor manager.** Desktop or tablet. He files his company’s
certificate once and can see which direct hirers rely on it. He receives the same
expiry ladder as the hirer and renews before the booking is at risk.

**Priya, operations manager.** Desktop planner. She sees a named warning beside a
provider booking. Her existing plan is saved when enforcement is off; when her
company has deliberately enabled enforcement, the refusal says exactly which
record must be fixed.

**Asha, sustainability lead.** Desktop. She filters the portfolio, compares two or
more projects from the same row model, then produces a quarterly or annual client
report whose stored snapshot can be re-rendered unchanged.

## 2. Resource responsibility

| Resource | Creator / corrector | Owner | Reader | Reviewer / publisher | Export / retention owner |
|---|---|---|---|---|---|
| Compliance document | `compliance.manage` holder | tracking company | owner, subject, and direct hirers for self-filed rows | tracking company | tracking company |
| Compliance alert | nightly worker only | tracking company | tracking company and subject recipients | nobody edits | tracking company; permanent with the document |
| Dashboard response | nobody; derived | requesting company | `sustainability.read` holder | nobody | not stored |
| Client-period report | `report.generate` holder | generating company | generating company; client only after disclosure | generating company | generating company; report hold applies |

## 3. State machine

`MISSING → VALID|EXPIRING` when a file is supplied; `VALID → EXPIRING → EXPIRED`
is derived from the local date; any live record may be `REJECTED` with a reason.
A correction to metadata increments `revision`; a renewed file inserts a successor.
Deleted rows are tombstones and disappear from current reads. The unique live
successor index arbitrates concurrent renewals; the loser receives a conflict.

A report remains on Phase 10’s `GENERATED → SUPERSEDED|VOID` machine. Filtering or
viewing analytics stores nothing. Regeneration creates a new frozen report; it
never mutates the old snapshot.

## 4. Permission + scope matrix

| Operation | Feature | Capability | Company edge | Resource scope |
|---|---|---|---|---|
| List compliance | `compliance_tracking` on tracking company | `compliance.manage` | own or direct edge | self-filed rows cross only to direct hirers |
| Create/update/reject/renew | `compliance_tracking` | `compliance.manage` | subject is self or direct provider | only owner mutates; supplied file belongs to owner/subject |
| Compliance summary | `compliance_tracking` | `compliance.manage` | direct providers only | current rows only |
| Schedule provider | `scheduling` on project owner | `schedule.manage` | assigned provider | compliance uses that owner/provider edge only |
| Submit provider work | project’s existing work gate | existing submission capability | exact engagement | compliance uses that engagement only |
| Portfolio analytics | `sustainability` | `sustainability.read` | own company | only projects owned by the company |
| Client report | `client_reporting` | `report.generate` + `sustainability.read` | named direct client identity | only projects owned by generator |

Passing one column never widens another. Cross-tenant misses are returned as not
found where revealing existence would itself disclose information.

## 5. Domain events

| Event | Payload | Idempotency key | Consumer / replay |
|---|---|---|---|
| `compliance.expiring` | document, owner, subject, kind, title, expiry, threshold, days | document + expiry + threshold | notification projection; replay deduplicates per recipient |

Writes and their audit rows commit together. The ladder’s `compliance_alerts` row
and outbox event commit together, so a crash cannot record “sent” without durable
work to deliver it.

## 6. Notification matrix

At 90/60/30 days, tracking-company managers and subject-company managers receive a
normal, digestible in-app task plus email. At 14/7 days the same durable task is
worded as escalation; it still respects quiet hours because a certificate does not
justify waking someone at 03:00. The in-product Action Centre is always present.
One row per expiry and threshold prevents daily duplicates.

## 7. Data classification + retention

Compliance metadata is commercial/evidence data; files inherit stored-file malware,
authorization and legal-hold rules. Insurer/reference/notes never appear in
analytics telemetry. Compliance rows and alerts follow the engagement/project
evidence retention, not `audit_retention_days`. A report and every file it cites are
held by `report_file_references`. Account closure anonymises user references and
preserves the business record. Company export includes owned compliance metadata;
subject access never includes another hirer’s private notes.

## 8. Offline / conflict policy

Compliance editing is a connected back-office job. PATCH requires
`expectedRevision`; a mismatch refuses with the current revision and the user
reloads. Renewal is an idempotent append through one-successor uniqueness. No
offline merge is attempted. Dashboard/report generation is read-only; duplicate
report generation reuses Phase 10’s content-addressed result.

## 9. Failure matrix

| Failure | Behaviour | Recovery |
|---|---|---|
| File still scanning / failed | terminal validation; no compliance row points at it | retry upload |
| Concurrent edit / renewal | conflict; no partial write | reload current row |
| Alert delivery transient failure | outbox retry/dead letter | operator replays durable event |
| One malformed candidate | candidate fails visibly; other worker work continues | inspect dead letter/job run |
| Analytics has no rows | empty state, never invented zeros for unknown emissions | widen filters or add data |
| Mixed factor years | report still generated with explicit disclosure | regenerate only after source correction |
| Report seal mismatch | refuse download | preserve row; generate a new report |

## 10. Security / threat model

Every subject, engagement, file and report identifier is independently checked.
Self-filed documents cross one direct edge only; a hirer’s notes never cross to a
different hirer. File readiness and ownership are checked before association.
Analytics accepts bounded filters and returns only owned projects, preventing a
provider’s project-level permission from becoming portfolio access. No compliance
route is available to platform support through tenant impersonation; existing
audited support controls remain the only operator path. No secrets or webhook
surface are added.

## 11. Analytics contract

Activation is the first compliance requirement recorded and the first client-period
report generated. Outcomes are renewal before expiry, zero expired mandatory
providers, and a disclosed quarterly/annual report. Funnel: provider engaged →
requirement recorded → current file present → valid at booking → period report
generated → disclosed. Quality metrics: percentage of engaged providers with no
blocking requirement, dashboard completeness by project, and percentage of period
projects with calculated carbon. Explicitly excluded: file names/contents, insurer,
policy reference, notes, people, rates, PAY/BILL values and client contacts.

## 12. Acceptance script

1. Marta opens an empty compliance register and sees every engaged provider, with
   “no requirements recorded” rather than “compliant”.
2. A Worker and a rival tenant are denied independently.
3. Marta records mandatory public liability as missing, then attaches a ready file;
   a scanning file is refused.
4. Rejection requires a reason; accepting recomputes the date-derived state.
5. Femi’s self-filed current certificate is visible to his direct hirer and not to
   an unrelated company.
6. The nightly pass moves valid → expiring → expired and emits each
   90/60/30/14/7 rung once to both companies.
7. With enforcement off, Priya’s provider booking saves and returns the named
   warning. With it on, the same booking and provider submission are refused.
8. A renewal succeeds once; a concurrent second successor is refused and the old
   row remains in history.
9. Asha opens an empty analytics period, then filters a populated portfolio and
   compares projects; unknown carbon remains an em dash and completeness is named.
10. She selects a client and a quarter/year, generates one `CLIENT_PERIOD` report,
    sees the contributing projects and mixed-factor-year disclosure, downloads it,
    and the client sees it only after deliberate disclosure.
11. Correcting live source data leaves the old report byte-identical; regeneration
    creates a new snapshot.

## 13. Build order

1. Pure compliance status/ladder/enforcement policy and tests.
2. `0048_compliance.sql`, feature placement and renewal constraints.
3. Compliance repository, CRUD/summary routes and file authorization.
4. Nightly status/alert pass and notification consumer.
5. Schedule/submission enforcement and visible warnings.
6. Compliance web register.
7. Client-period report web workflow.
8. Portfolio filters and cross-project comparison.
9. Live API and browser acceptance scripts; full verification.
10. Artifact-class retention sweep, immutable-document hold and durable object deletion.
