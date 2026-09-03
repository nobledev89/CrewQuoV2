# Operating-model packets

CREWQUO_V2_PLAN.md §19.5 makes twelve questions a **planning input** for every
domain, not a document written after the fact: *"Before a phase hardens a new
domain, its planning packet must answer the operating questions below."*

This directory is where those answers live. One file per domain, named after the
domain rather than the phase, because domains outlive the phase that shipped them.

`TEMPLATE.md` is the reusable packet. Copy it, answer every heading, and delete
nothing — a heading with "not applicable, because …" is an answer; a missing
heading is an unasked question, which is the failure mode §19.5 exists to prevent.

| Domain | Packet | Shipped in |
|---|---|---|
| Access, sessions & platform security — factors and recovery, session/device lifecycle, rate limiting, secret rotation, support access | [access.md](./access.md) | Phase 6 |
| Commercial agreements — PAY rate proposals, engagement terms, acceptance | [commercial-agreements.md](./commercial-agreements.md) | Phase 6 |
| Company ownership & creation — the first-company allowance, additional-company approval, duplicate routing, trial eligibility | [company-creation.md](./company-creation.md) | Phase 6 |
| Durable delivery — transactional events/jobs, inbound webhooks, retry, dead letters and replay | [durable-delivery.md](./durable-delivery.md) | Phase 6 |
| Money identity — one currency per company, the project label snapshot, its pin and the tax-compliance gate | [money-boundary.md](./money-boundary.md) | Phase 6 |
| Observability & data lifecycle — request/tenant/job correlation, the scheduler, error tracking, what a customer may export, what deletion does to a cross-tenant record, and the recovery promise | [observability-data-lifecycle.md](./observability-data-lifecycle.md) | 6 |
| Notifications & the Action Centre — the durable per-recipient projection, channels, quiet hours, delivery evidence | [notifications.md](./notifications.md) | Phase 6 |
| Time & time zones — company/project IANA zones, instant-vs-date, DST, date-bound rules | [time.md](./time.md) | Phase 6 |
| Project evidence — locations, the storage layer, evidence, documents, the site diary, the capability model and the offline contract | [project-evidence.md](./project-evidence.md) | Phase 7 — `draft` |
| Assets & materials — asset types and lines, weight provenance, destination types and organisations, the movement ledger and the mass roll-up | [assets-materials.md](./assets-materials.md) | Phase 8 — `draft` |
| Sustainability & the carbon engine — emission factor sets and their importer, product carbon factors, project activities, the calculation ledger with its buckets and supersession, avoided-emissions claims and the §39 settings | [sustainability.md](./sustainability.md) | Phase 9 — `draft` |
| Reporting & client sign-off — `generated_reports` and its frozen snapshot, the twelve-section completion report, the evidence pack, the client-facing export, the disclaimer and its claim guards, `client_signoffs`, and the `CLIENT_PERIOD` aggregation | [reporting-signoff.md](./reporting-signoff.md) | Phase 10 — `adopted` |
| Commercial & operations — variations with their pricing and approval, `project_budgets` with computed actuals and per-category variance, `vehicles`, `schedule_assignments` with conflicts, availability and role requirements, and the §35 timeline read model | [commercial-operations.md](./commercial-operations.md) | Phase 11 — `adopted` |
| Compliance & analytics — reusable company certificates, date-derived status and alert ladder, optional work enforcement, client-period reporting UI, portfolio comparison and artifact retention | [compliance-analytics.md](./compliance-analytics.md) | Phase 12 — `adopted` |

Earlier domains (identity, rates, the delivery loop, portal/audit, invoices) were
built before the §19.5 decision was adopted on 2026-08-18 and have no packet. They
are not retro-fitted on principle: a packet is worth writing when it can still
change the design. Where one of those domains is next reopened, its packet gets
written then — which is exactly what `company-creation.md` is. It covers the part
of identity §3.1.1 reopens (who may create a tenant) and nothing else.

`access.md` is the second half of that sentence coming due. It read "auth, sessions
and invitations keep no packet until something reopens them" until 2026-08-19, when
the §42 security-hardening bullet reopened auth and sessions — so they got theirs.
Invitations still have none, and still do not need one.

**`access.md` is the first packet to have been written as `draft` and promoted to
`adopted`**, which is the template's own distinction being used rather than skipped.
Three of its questions — who must hold a second factor, what happens when somebody
loses both their device and their recovery codes, and whether platform support
access exists at all — changed *what* got built rather than how, so they went to the
owner instead of into a guess. All three were answered the same day and are recorded
in its §13 **with their rejected alternatives**, because a decision whose options are
lost reads a year later like something nobody considered.

It also earned its timing the way `money-boundary.md` did. Surveying `app.ts` to
answer §10 is what found the wide-open CORS and the absent login rate limit — neither
of which is in the §42 bullet the packet was written for, and the second of which is
the most severe hole in the product.

`observability-data-lifecycle.md` is the clearest case yet for writing the packet
before the code, and it did not have to look far. It was written because
`access.md` §13.3 **refused** platform support access — no impersonation, no
per-tenant operator read — on the strength of one following sentence: *"a customer
problem is diagnosed from audit rows and logs."* Surveying whether that sentence was
true is the whole of its §0, and it is not: an unhandled error is logged as a bare
stack trace with no request, no tenant and no user, and there is no correlation id
anywhere in the API. So the support model the access packet committed to does not
exist yet.

Answering §9's "what does the operator see when this fails" is what found the more
serious thing. Three deferred jobs exist and are deliberately one-shot, on the
correct reasoning that an external scheduler restarts a dead job where a
`setInterval` dies with its process — and **nothing schedules them**, in
`render.yaml` or anywhere else. Deployed, the outbox never drains, so no
notification is ever delivered, and the audit retention customers are sold is
enforced by nothing. That is the same fault `workers.cli.ts` was written to fix one
layer down; the caller got built and the thing that calls the caller did not. It is
step 1 of the build order and needs no decision from anybody, which is why the
packet says so rather than waiting to be adopted.

Its §13 is open. Four questions, and the load-bearing one is what deletion does to
an evidence row that belongs to two tenants at once: a subcontractor's time log is
also the hiring company's proof of an invoiced hour, so hard deletion is a
data-integrity attack anybody can run by asking politely, and deleting nothing
makes the promise a lie.

`money-boundary.md` is the same rule applied twice over: the money boundary
reopened **rates** and **invoices** together, so it was written before the
migration — and it earned that timing immediately. Writing §2's responsibility
table is what settled that nobody may edit a recorded rate; §3's pinning states
are what produced the row-lock-then-count concurrency rule rather than a
check-then-act; and §4's decision that a converted figure must cite its rate is
what turned "an invoice converts BILL rates" into "an invoice refuses them",
which removed a table from the migration instead of adding one.

**It is also the first packet to be substantially reversed, and it kept its
reasoning through the reversal.** Hours after the multi-currency design shipped,
the owner decided that a company works in exactly one currency and the currency is
a label. Migration 0017 undid most of 0013. The packet was rewritten rather than
patched, and it now carries a *What went, and why it is not coming back by
accident* section — because the way a withdrawn feature returns is one plausible
column at a time, added by somebody who never knew it had been removed on purpose.
The §3 pinning states and the row-lock concurrency rule survived the reversal
unchanged, which is a fair sign they were about the domain rather than about the
mechanism.

`project-evidence.md` is the first packet written for a phase that has not
started, which is the earliest §19.5 has ever been applied and the point of the
rule. Phase 7 opens the first new *class* of storage since Phase 0 — bytes — and
three of its findings would each have been a migration to undo. The API cannot
sniff a content type it never receives, so `READY` belongs to the worker that
downloads the object rather than to the request that completes it. `storage_gb`
cannot reuse `withinLimit` without changing what `projected` means, and a caller
taking the default would charge one gigabyte per upload. And
`evidence_uploads_per_month` is the product's first *windowed* meter, which needs
a month boundary, which needs the company IANA zone `time.md` already settled.

Its §13 is open, and two of the seven are the packet doing the job the money
packet did. **Whose gigabyte is it** — §22.1 charges the uploader's company, which
bills a free subcontractor's plan for the hiring company's evidence pack. And
**what a free plan may capture**, which is the settled rule from
`commercial-agreements.md` with the sides swapped: proposing a rate is free
because the Crew plan exists so a subcontractor can work for nothing, and a
subcontractor who cannot photograph the floor cannot do the work either.

Its §14 is deliberately shaped so the phase does not stall on any of that. The
capability layer, project locations and the offline contract need no answer from
anybody, and each is a dependency of something later.

`assets-materials.md` was written the same way — before Phase 8's first line of
code — and it is the first packet whose most valuable finding is not a hole in the
product but **a contradiction between two rules of the plan itself**. §25.4 rule 1
caps the total quantity of an asset line's movements at the line's own quantity.
Rule 3 says that when material leaves storage, *a second movement* records the
real outcome. Twelve chairs into a warehouse and twelve out of it is twenty-four
against a line of forty-two that also donated thirty, so rule 1 refuses the
movement rule 3 requires. Enforced literally, storage becomes a one-way door and
locked decision #18 — *storage is not an outcome until a final destination is
recorded* — becomes unimplementable, which is the opposite of what that decision
exists to do.

The resolution is one nullable self-reference and a restatement of both the rule
and §28.2's mass definitions over the movements nothing continues. It is worth the
paragraph because of *when* it was found: the alternative was a migration on a
table holding a year of movements, and a published diversion rate that had been
wrong for that year. §41's ten principles are all about a number being defensible;
this is the first time one of them was defended by a foreign key.

Four of its nine findings are the canonical DDL disagreeing with a decision made
after it was written — a `not null` on `created_by_user_id` that the 2026-08-20
closure promise cannot honour, a foreign key to a Phase 11 table, a shadowing
model with no uniqueness to enforce it, and a partial index missing the tombstone
filter every Phase 7 index learned to carry. None of those is interesting on its
own. Together they are the argument for writing the packet at all: they were found
by reading the plan against the code that shipped since it was written, which is
work nobody does while implementing.

Its §13 has two open questions and **neither blocks the build** — both are
departures from a canonical DDL rather than product choices, so both are built as
recommended and recorded with their rejected alternatives. Three more entries are
recorded as *following precedent* rather than sent to the owner, which is the
first time a packet has done that: whose plan is checked when a subcontractor
works on somebody else's project was answered on 2026-09-01, and asking it again
with a different noun would be treating a settled rule as an open one.

`sustainability.md` is the third packet written before its phase started, and the
first written to protect a **claim** rather than a record. Phase 8 produced a
tonnage split, where a wrong tonne is embarrassing and correctable. Phase 9
multiplies those tonnes by factors and publishes two figures a customer puts in
their own annual report, under a methodology statement, frozen into a §29.4
snapshot that is deliberately never recalculated. A wrong number there does not
stay inside CrewQuo.

Its most valuable finding is the one that would not have been a migration to undo
but **a published claim to retract**. §45 records an owner decision from
2026-08-18 — *"displacement defaults to `UNKNOWN`, never 100%"* — and §27.4 states
the consequence, that `UNKNOWN` produces no claim rather than a silent full one.
§39's DDL was written before that pass and still says
`default_displacement_pct numeric(5,2) not null default 100`: a column that
cannot express `UNKNOWN` at all, defaulting to precisely the value the decision
forbids. Built literally, every company starts life claiming maximal avoided
emissions on every reuse movement, with `ASSUMED_FULL` recorded as the basis of an
assumption nobody made. It is the largest number the product publishes and the one
with the least external scrutiny, and the failure is silent, favourable, and
found by whoever audits the customer.

Two more findings are the same class of thing the assets packet found by reading
the plan against the code that shipped after it was written. `emission_factor_sets`
carries `unique (company_id, name, version)` over a **nullable** `company_id`,
which in Postgres constrains company rows and does nothing at all to the
platform library — the third table to make that mistake, after `asset_types` and
`destination_types`, and the first where the consequence is that a recalculation
can cite a different `factor_id` for the same activity depending on join order.
And a tombstoned asset movement leaves its `carbon_calculations` row standing with
`superseded_by` still null, so the mass balance and the carbon roll-up — rendered
side by side in the same section — disagree about whether the material exists.

Its §13 has **one** genuinely open question, and it is a methodology question
rather than a schema one: whether Scope 2 electricity is reported location-based,
market-based, or both. It is built as recommended — location-based only, labelled —
because market-based reporting requires supplier instruments CrewQuo does not hold
and cannot verify, on a figure that *reduces* a customer's reported emissions.
Five further entries are recorded rather than asked, including the displacement
default above: an owner decision already answers it, and sending it back would
treat a settled rule as an open one.

`reporting-signoff.md` is the fourth packet written before its phase started, and
the first written about an **artefact** rather than a record or a claim.
Everything CrewQuo holds so far is corrected by correcting its inputs — the mass
balance is derived, the roll-up is derived, and `massBalance.ts` says in its own
header that *"nobody corrects the roll-up; you correct its inputs."* §29.4 breaks
that on purpose: a generated report stops being derived and becomes a record of
what was said, which has to reproduce in 2028 after two factor sets have been
imported and three weights corrected.

Its first finding is the phase's own milestone, and it was found by rendering the
same document twice. *"Regenerable byte-identical a year later"* is not achievable
with the Phase 4 renderer, because jsPDF stamps every file with a wall-clock
`/CreationDate` carrying the rendering machine's UTC offset and a `/ID` of 32 hex
characters from `Math.random()`. Two renders of identical content produce
different files, and the difference is invisible to anyone comparing the PDFs on
screen — so the test fails and the obvious conclusion is that the test is wrong.
The fix is two lines of public jsPDF API, and it improves the document: the
creation date becomes a fact about the report, and the file's `/ID` becomes the
first half of the content hash of the snapshot it renders.

Three more findings are the plan's §29 disagreeing with itself now that the
client-export decision of 2026-08-17 has put its paragraphs side by side. §29.5
sends the client export to a `generated_reports` snapshot whose `kind` constraint
has no value it can be. §29.1's Project overview names the subcontractors and
§29.5 forbids naming them in a file that leaves the building — with a
`client_visible` boolean one route away from doing it. And `content_hash` is
specified as *"sha256 of the canonicalized snapshot"* in a repository that
canonicalizes nothing, over a `jsonb` column that reorders keys on write: hash the
object you built, read it back to verify, and the seal fails on every row, which
is the same as having no seal.

The most consequential of those is the disclosure one, and its resolution is why
the packet was worth writing before the migration. A file is authorized once and
then it is a file — emailed, printed, forwarded to a party CrewQuo has never heard
of. So the boundary gets three independent layers rather than a filter: an
immutable `audience` column, a check constraint binding `client_visible` to it,
and **two snapshot builders over two type families**, so the client's document has
no field that can hold a PAY figure or a provider name. §29.5 asked for exactly
that in words — *"the exclusion cannot be forgotten by a later edit the way a
`select` list can"* — and one snapshot with a disclosure flag would have made it
the forgettable kind.

It is also the packet that pays off three deferred debts at once, which is what
being fourth in a row buys. `project-evidence.md` §13.6 said the report-versus-
amended-diary conflict *"bites in Phase 10, not here"*; it does, and it is closed
as that packet recommended and generalised to every record class a snapshot cites.
Decision #27's promise that evidence referenced by an issued report remains
addressable had nothing enforcing it, because a `jsonb` reference is not a
reference. And the artifact-class hold Phase 7 refused to build — *"a mechanism
with no caller"* — now has two callers on the day it lands: it is the retention
hold, and it is the disclosure grant that lets a client open a photograph inside a
document they were given without that photograph having to be published to them
generally.

It is also the first packet whose own resolution was corrected by its acceptance
script. Finding 10 settled that a re-render reads the snapshot and a live
comparison adds a banner; the first implementation put that banner on the cover of
the PDF, and §12 step 7 failed — correcting a weight bumped a revision, the banner
appeared, and the same report rendered as two different files. A live comparison
inside a frozen document makes the document a function of the present, which is the
one thing §29.4 forbids. The divergence is reported beside the document instead,
and `RenderInput` now has no field a live fact could occupy. It is recorded as
finding 12 rather than folded into finding 10, because a packet that quietly
rewrites what it recommended loses the only evidence that writing §12 first was
worth anything.

Its §13 has one open entry and it is packaging rather than design: §43's tier
placement for the four new feature keys is followed as proposed, with one stated
departure — `client_signoff` on Starter rather than Pro, because a sign-off is how
a small contractor proves a job is finished and costs nothing to serve, and
putting the proof of completion two tiers above the work would stop the
free-to-Starter path one step short of the thing the customer is selling.

`commercial-operations.md` is the fifth packet written before its phase started, and
the first about a domain the product had **already been handling for nine phases**.
Money is not new here. What is new is narrower and sharper: Phase 11 is the first
phase to add a **second writer to a number that is already published.**

`computeProjectSummary` is the most reused function in the repository — the owner's
project screen, the XLSX export's own cell assertions, the client portal, the Phase 4
PDF, and a §29.5 snapshot sealed into a document a client keeps. It has had one
source since Phase 3 and one withholding rule. §30.1 says, in eleven words, that
approved variations feed it *"not through a second calculator"*, and that sentence is
right and is the reason the packet exists: a second writer into a shared derivation
is where the double count and the silently-changed figure both live.

Its largest finding is entirely about what gets printed. §30.2 declares ten budget
categories and says actuals come from *"asset movements and activities (vehicles,
mileage, waste)"* — and those two tables carry mass, distance, fuel and energy and
**not one money column between them.** Nothing in the schema prices a skip, a tonne
or a litre; Phases 8 and 9 were built to answer how much material and how much
carbon, and neither was ever asked what it cost. So six of the ten have a budget and
nothing to compare it against, and the row a literal implementation renders is
*"Vehicles · Budget £3,000 · Actual £0 · Variance −£3,000 / −100%"* — an absence with
a percentage attached, on a screen a contractor reads immediately before a client
meeting. §41.1 forbids exactly that for carbon (*"no factor, no number — say so
instead"*); the resolution is the same rule applied to money, and the browser suite
now asserts it row by row.

Three more findings are the plan disagreeing with a decision that followed it, and
one of them is a column: §30.2 declares `currency text not null` on `project_budgets`,
and migration `0017` deleted exactly that column from three other tables on the
reasoning that *"a copy that can drift is worse than no copy."* A budget's unit can
only ever be its project's own pin. And §31 asks for a planned labour cost through
the rate engine while giving an assignment two instants — so a literal implementation
derives `NIGHT` from `starts_at.getHours()`, putting a rate rule back into code
eleven phases after the owner had the `FRI_SAT_NIGHT` branch removed for precisely
that reason.

**Two of its findings were added by the build rather than by the packet**, and both
came from a test failing on its first run. `Math.round(quantity * unitCents)` — the
obvious body for a line total — disagrees with Postgres at the half-cent boundary
(`0.29 × 50` is exactly `14.50`, which IEEE 754 evaluates as `14.499999999999998`),
and `0045` turns that identity into a check constraint, so the divergence surfaces as
a `23514` refusing a write on a line somebody typed perfectly. **`invoice_items` has
carried the same constraint since `0008` and the same latent defect with it**, which
made the Phase 6 defect a live one rather than a hypothetical. And the first draft of
`0045` dropped `invoice_items_check` intending to replace the source pairing — that
name is the *amount identity*, and nothing would have failed: the migration would
have applied cleanly and the loss would have surfaced years later as one invoice that
did not add up.

Its §13 has **one** genuinely open decision, and it is commercial rather than
technical: whether a variation's lump sum should exclude the hours behind it from the
invoice. CrewQuo bills from approved time logs at BILL rates, so a variation quoted
*as* the price of those hours would be billed twice — and the product cannot tell
from the data which basis was agreed. It is built on the conservative arm, with the
ambiguity put in front of the only person who knows, at the moment they create the
invoice.
