# Operating-model packet — commercial & operations

**Domain:** the Phase 11 record set — `variations` and `variation_lines` with the
`DRAFT→…→INVOICED` machine and labour priced off the rate engine, approved
variations feeding `computeProjectSummary`, `project_budgets` with **computed**
actuals and per-category variance, `vehicles`, `schedule_assignments` with
day/week/month views, drag-and-drop, conflict warnings, availability windows and
per-project role requirements, and the §35 project timeline read model.
**Phase:** 11 · **Status:** **adopted** — §14 fully built, all ten steps shipped,
the §12 acceptance script implemented step for step, and its one genuinely open
decision (§13.2, the variation-versus-timesheet billing basis) built on the
conservative arm with the alternative recorded · **Last updated:** 2026-09-03
**Plan refs:** §30.1 (variations), §30.2 (planned vs actual), §31 (crew
scheduling), §35 (project timeline), §36 (`record_revisions` — variations are on
its starred list by name), §3.4 (the work workflow this status machine mirrors
deliberately), §3.5 (invoices — the source builder this plugs into), §6 (the rate
engine), §40 (colour communicates direction only), §41.1 (no source, no number),
§43 (`variations`, `scheduling`), §44 (state-machine, resource-scope and
accessibility tests), decision **#5** (one currency per company, and the project
label pin), decision **#21** (web-first sequencing).

---

## 0. Why this packet, and why now

The four packets before this one were each written about a new *kind* of thing.
Phase 8 produced tonnes. Phase 9 multiplied them by factors and published a
claim. Phase 10 froze the claim into an artefact that has to reproduce in 2028.
This one produces none of those. Every table it adds is money or time, and the
product has been handling money since Phase 2.

So the argument for writing it before the migration is a different one, and it is
narrower and sharper: **Phase 11 is the first phase to add a second writer to a
number that is already published.**

`computeProjectSummary` is the most reused function in the repository. The owner's
project screen renders it, the XLSX export asserts its own cells against it, the
client portal shows the client's half of it, the Phase 4 PDF prints it, and
`reporting-signoff.md` §29.5 seals a snapshot of it into a document a client keeps.
It has had exactly one source since Phase 3 — approved work — and one withholding
rule, which is that a line with no BILL card makes the total meaningless and the
total is therefore withheld rather than guessed.

§30.1 says, in eleven words, *"Approved variations feed project revenue and
profitability through `computeProjectSummary`, not through a second calculator."*
That sentence is right, and it is the reason this packet exists. A second writer
into a shared derivation is where two things go wrong that no amount of care at
the call site can catch: the double count, and the changed meaning of a figure
somebody else already put in a PDF. Both of those turn out to be real here, and
one of them is in the plan's own DDL.

**And it is the phase where three registries written ahead of time come due at
once.** `LOCATION_REFERENCE_TABLES` carries a comment with this phase's name on
it. `DRAG_EXEMPTIONS` in `keyboard.spec.ts` was shipped deliberately empty two
phases early so a drag-and-drop scheduler could not arrive without a registered
keyboard equivalent. `AttendanceSuggestion.source` is a union of one member so
that adding the schedule to §23's prefill would be a compile error at every
reader rather than a silent widening. None of those is interesting on its own.
Together they are the argument for having written them: the work of remembering
was done by whoever built Phase 7, and this phase only has to pay it.

### What writing it found

Twelve findings, **and six more the build added** — recorded at the end of this
section, because a packet that quietly absorbs what its own implementation found
loses the only evidence that writing §12 first was worth anything.

Two of the twelve would each be a published figure to retract rather than a
migration to undo, which is the standard Phase 9 set; one is a column the plan
declares that migration `0017` already deleted three copies of; and one is a rate
rule about to be hardcoded back into the product eleven phases after the owner had
it taken out.

**1. `project_budgets.currency` is the fourth copy of a column migration `0017`
was written to delete.**

§30.2 declares `currency text not null` on a table with `unique (project_id)` —
one row per project. Migration `0017_one_currency_per_company.sql` removed exactly
this column from `rate_cards`, `rate_proposals` and `invoices`, and PROGRESS
records why in one line: *"a copy that can drift is worse than no copy… two copies
make 'which is authoritative?' a real question with no answer."* A budget's unit
can only ever be `projects.reporting_currency`, which is *itself* the pin — a
snapshot taken at creation precisely so a company that changes its label next year
cannot relabel a project that closed last year. A second snapshot of a snapshot is
not more careful; it is one more thing that can disagree.

The column is not created. §30.2's DDL predates the 2026-08-19 decision, and this
is the same class of finding `assets-materials.md` and `sustainability.md` each
recorded — the canonical DDL disagreeing with a decision made after it was
written.

**2. Six of §30.2's ten actuals have no source anywhere in the schema, and
rendering them as zero is §41.1 in the commercial half of the product.**

This is the phase's largest finding and it is entirely a matter of what gets
printed.

§30.2 is precise about where actuals come from: *"from approved time logs (labour,
via the frozen PAY snapshots), approved expenses, asset movements and activities
(vehicles, mileage, waste), and approved variations (revenue)."* The first two are
real. The third is not, and the reason is checkable in one query:
`asset_movements` and `project_activities` between them carry `quantity`,
`mass_kg`, `distance_km`, `litres`, `kwh`, `tonne_km` and `journeys` — and **not
one money column.** Nothing anywhere in the schema prices a skip, a tonne, a
kilometre or a litre. Phase 8 and Phase 9 were built to answer *how much material
and how much carbon*, and they answer it completely; neither was ever asked what
it cost.

So `vehicle_cents`, `mileage_cents`, `waste_cents`, `materials_cents`,
`purchases_cents` and `other_cents` are budgets with nothing to compare against,
and the row a literal implementation renders is:

```
Vehicles      Budget £3,000    Actual £0    Variance −£3,000 / −100%
```

Every character of that is wrong in the favourable direction. It is not a
variance; it is an absence with a percentage attached, on a screen a contractor
reads immediately before a client meeting, in a product whose §41.1 says of the
carbon engine *"no factor, no number — say so instead."* The commercial half gets
the same rule and the same shape: `actualCents` is **`null`** where the product
holds no source, `varianceCents` and `variancePct` are null with it, and the row
prints *not tracked* with the reason rather than a figure.

Four categories compute completely and are worth having: **revenue** (BILL-priced
approved work plus approved variation sell), **labour** (own-company approved
logs, from their frozen PAY snapshots), **subcontractor** (other companies'
approved logs, same snapshots) and **expenses** (approved expenses). And the
honest thing to put beside them is the one breakdown the data does support: the
approved expense spend grouped by its own free-text `category`, so the person can
see *where the money went* even where the product cannot assign it to a budget
line they chose. Zero new tables, no invented mapping, and it answers the question
the six null rows raise.

The rejected alternative is worth recording because it is tempting and it is
wrong: **map an approved variation's cost lines onto the budget categories** —
`VEHICLE` lines to `vehicle_cents`, `WASTE` to `waste_cents`, and so on. The line
kinds line up almost exactly, which is what makes it tempting. It fails on finding
3: a variation's cost total is a **forecast** made when the extra works were
quoted, not a record of money spent. Presenting a forecast in the *Actual* column
is worse than an empty cell, because an empty cell is visibly empty.

**3. The variation's sell is the only record of the money and its cost is a
forecast, so folding both into the summary double-counts the cost.**

§30.1 puts `sell_total_cents` and `cost_total_cents` side by side on the row, and
the symmetric reading of *"approved variations feed project revenue and
profitability"* is to add the first to bill and the second to cost. The second half
is a double count, and it is silent.

The hours worked on extra works are logged as time logs like any other hours —
that is how the crew gets paid, and the PAY figure is frozen onto each log at
submit (§6). They are **already** in `laborCostCents`. `cost_total_cents` is what
the contractor expected the works to cost at the moment it quoted them, which is a
different fact about a different instant. Adding it counts the same labour twice
and inflates cost, which deflates margin — the one direction of error a
contractor does not catch, because it is pessimistic.

Revenue is asymmetric because nothing else records it. There is no BILL card for
*"the client agreed another £4,000 for the extra doors"*; the variation row is the
only place that number exists. So the summary folds in **sell and never cost**,
`variationCostCents` is reported as its own figure and never summed into
`totalCostCents`, and the asymmetry is stated in `summary.ts`'s own header —
because to anybody who finds it later without the reasoning, it reads exactly like
a missing line of code.

**4. A variation approved at £4,000 must not be able to become £4,500.**

§30.1 says the status machine *"mirrors the work workflow (§3.4) deliberately —
same shape, same guards"*, and §3.4's guard is that the provider side creates and
edits only while `DRAFT`/`REJECTED`. Transferred literally that is correct, and the
consequence here is stronger than for a timesheet, because of two columns §3.4
does not have: `client_approved_by` and `client_approved_at` record that a named
person **outside the tenancy** agreed a figure. A line that stays editable past
that point converts their agreement into a signature on a blank cheque, and the
audit trail would show a variation the client approved and a different total on
the invoice.

Lines and prices are writable in `DRAFT` and `REJECTED` only. From `APPROVED`
onward the totals are what was approved, a correction is a **new variation**, and
the refusal says so. This is not a new invariant — `issueDraftInvoice` established
exactly this shape in Phase 6, where issue assigns a number and makes the document
immutable — it is that invariant arriving in a second place.

**5. The header totals and the line totals are two answers to one question, and
one of the two can be a check constraint.**

`variation_lines` carries `unit_cost_cents`, `unit_sell_cents`, `cost_cents` and
`sell_cents`; the last two are `quantity ×` the first two. `variations` carries
`sell_total_cents` and `cost_total_cents`, which are the sums of the lines. Both
are denormalisations, and neither is one the product can afford to let drift,
because §30.1 sends the header into `computeProjectSummary` and into an invoice.

The line totals get an actual **check constraint** — `cost_cents = round(quantity
* unit_cost_cents)` — which is exact, immutable and enforced against every writer
including a future one that has not read this file. The header totals cannot be a
constraint (a `check` cannot aggregate), so they are recomputed inside every
transaction that touches a line, exactly the way `recalculateInvoiceTotals`
already does, and are **never accepted from a caller**. The acceptance script
asserts the two agree, because a drift here is money on an invoice.

**6. A schedule assignment carries no shift type, and every rate the engine
resolves is keyed on one.**

§31: *"planned labour cost resolves through the rate engine for §30.2's budget
line."* Its DDL gives an assignment `starts_at timestamptz` and `ends_at
timestamptz`. `resolveRate(cards, shiftType, isoDate, rules)` takes a `ShiftType`,
and there is no function anywhere in `rate-engine/` that derives one from a clock
time — deliberately. `types.ts` says so in as many words: *"Time of day is carried
by `shiftType` itself, because `time_logs` records hours worked and not clock
times — there is no start time to compare an hour range against."*

An implementation that reads `starts_at.getHours() >= 20 ? 'NIGHT' : 'WEEKDAY_DAY'`
puts a rate rule back into code, in a phase whose subject is not rates, eleven
phases after the owner decided that **nothing about rates may be hardcoded** and
the `FRI_SAT_NIGHT` branch was deleted from `resolveRateLabel` for precisely this
reason. It would also be wrong in a way nobody would notice for months, because it
is only consulted for a *planned* figure.

So the assignment carries an explicit nullable `shift_type`, the scheduler's form
offers it, and a planned cost is computed **only when it is set**. Otherwise the
figure is withheld rather than guessed — which is not a new rule either, it is
what `resolveBillCentsForLog` already does when no BILL card covers a line.

**7. §31 names two tables in prose and declares neither.**

*"Availability & requirements: per-user availability windows and per-project role
requirements ('2 × Rigger, 1 × Supervisor, Mon–Wed') drive an unfilled-requirement
indicator. Requirements live on the project, not the schedule."* There is no DDL
for either, and the last sentence is a design instruction that only means anything
if there is a table for it to be true of.

Both are declared here. `project_role_requirements` is the straightforward one.
`resource_availability` is the one worth a sentence: §31 describes it as
*per-user*, but the same paragraph's other rule — *"deliberate double-booking of a
subcontractor's company is normal and only warns when headcount exceeds a stated
availability"* — needs an availability for a **company**, and there is no reason a
vehicle off the road for a service should need a third table. One table with the
same `resource_type` discriminator `schedule_assignments` already uses serves all
three, and the headcount warning becomes the same comparison as the other two
rather than a special case somewhere else in the code.

**8. `project_activities.vehicle_id` comes due, and it is the third time the
column has been sent forward.**

`assets-materials.md` finding 7 and `sustainability.md` finding 3 both recorded a
foreign key to `vehicles` being omitted because the table was Phase 11 and
`0030`'s rule refuses *"a column with no reader"*. This phase creates the table,
so the column lands with a reader on the day it exists: an activity recorded
against a fleet vehicle prefills `vehicle_category` and `fuel_type` from the
vehicle row instead of asking a supervisor to retype what the office already
knows, which is what `vehicles.emission_factor_activity` was declared for.

Two properties are kept deliberately. The stored `vehicle_category` and
`fuel_type` columns **stay** — a subcontractor's van is a category and a fuel with
no fleet row, which is the reason those columns exist rather than a join in the
first place. And the prefill **copies rather than joins**, so retiring a vehicle
or correcting its category next year cannot restate last year's emissions. That is
§41.3 (*a newer basis is never applied retrospectively*) enforced by the shape of
the write rather than by remembering.

**9. Three registries written ahead of time each have an entry with this phase's
name on it — and one of them exposed a Phase 8 gap.**

`LOCATION_REFERENCE_TABLES` in `locations.ts` carries the literal comment *"Phase
11 adds `schedule_assignments.location_id`"*: one line. `DRAG_EXEMPTIONS` in
`keyboard.spec.ts` is a build gate that fails the moment `onDrop`/`draggable`
appears without a registered non-drag equivalent — so the scheduler's keyboard
path has to *exist and be asserted* before the suite goes green, which is what it
was shipped empty for. `AttendanceSuggestion.source` is a one-member union so that
adding `'SCHEDULE'` is a compile error at every reader, and
`DiaryPrefillResponse.sources.schedule` has been shipping `false` since 7.5 saying
so out loud.

The gap: **`project_assets.origin_location_id` and
`asset_movements.from_location_id` shipped in Phase 8 and neither was added to the
location registry.** The failure mode is not data loss — the foreign key defaults
to `no action`, so Postgres refuses — but the refusal reaches the caller as a
`23503` rather than as the sentence the registry exists to produce, which is the
exact defect `countLocationReferences` was written to prevent. Two lines, fixed
here rather than recorded and left, because this phase is editing that array
anyway and leaving a known 500 in place to preserve a convention would be
choosing the convention over the product.

**10. The timeline is a read model over ten tables, and two of §35's thirteen
event types have no source.**

§35 lists thirteen kinds of thing: *project creation · crew assignments · diary
entries · time entries · photos · asset movements · waste records · document
uploads · variations · approvals · incidents · client sign-offs · completion.*
Eleven have a table with a real timestamp. Two do not.

`incidents` has no table anywhere in the plan's DDL — not §3, not §25, not §30
through §35. That is the same absence `reporting-signoff.md` recorded when it gave
`PACK_INCIDENTS` an `availableFrom` of `null`, and it gets the same treatment
here: declared in the registry with the honest value, because the next reader of
§35 will come looking for exactly this line.

*Completion* has no timestamp. `projects` carries a `status` and no `completed_at`,
so **the instant a project was completed is not a fact this schema holds.** It is
reported from the client sign-off instead, which is the record that actually
attests completion and carries a server-clock `signed_at` — and where there is no
sign-off, the timeline says nothing rather than inventing a date from
`updated_at`, which is the timestamp of the most recent edit to anything.

**11. A variation is the first record whose client-facing half is an approval by
somebody with no login — and §29.2 has been waiting for its section.**

`client_approved_by text` and `client_approved_at timestamptz` are the same shape
`client_signoffs.signer_name` has, and for the same reason: the person who agreed
the extra works is standing next to a supervisor with a phone, has no membership
and frequently no login, and the columns are **evidence about them** rather than
identity for them. `approval_evidence_file_id` is the photograph of the signed
docket and takes `on delete restrict` for the reason a signature does — it is the
one file whose loss makes the record worthless.

And `CURRENT_BUILD_PHASE` moves from 10 to 11. That single line makes
`PACK_VARIATIONS` appear in the evidence pack's toggle list and in the document,
with no edit to the catalog and no change to any report already generated, because
Phase 10 stored each report's chosen section set on its own row precisely so this
would be true.

**12. `created_by_user_id not null`, for the fourth time.**

§30.1, §30.2 and §31 each declare it, and `0030`, `0034` and `0040` each already
made it nullable with `on delete set null` because the closure promise of
2026-08-20 anonymises a person and preserves the record. Recorded as a class
rather than as three findings: of the **five** user references Phase 11 adds, all
five are nullable with `on delete set null`, and the packet checked the class
rather than the instance — there is no sixth.

---

### The three findings the build added

**13. `Math.round(quantity * unitCents)` disagrees with Postgres, and `0008` has
been carrying that disagreement for five phases.**

Finding 5 turns §30.1's line totals into check constraints — `cost_cents =
round(quantity * unit_cost_cents)`. The obvious TypeScript body for the matching
function is `Math.round(quantity * unitCents)`, and it is wrong: Postgres computes
the product in exact decimal and IEEE 754 does not. `0.29` is a legal
`numeric(12,2)` quantity and 50 cents an ordinary unit price; the exact product is
`14.50`, which `round()` sends to 15 and which JavaScript evaluates as
`14.499999999999998` and rounds to 14. The insert is then refused with a `23514`,
which reaches the caller as a 500 — **on a line somebody typed perfectly.**

The unit test caught it on its first run, which is the whole argument for writing
the pure core before the migration. `lineTotalCents` does the arithmetic in integer
hundredths instead, where it is exact, and the divergent cases were found by
enumeration rather than by reasoning — the set of two-decimal quantities whose
product lands a hair under an exact half is not something anybody derives correctly
at a keyboard.

**And the same defect was already live.** `invoice_items` has carried
`check (amount_cents = round(quantity * unit_amount_cents))` since `0008`, and
`calculateInvoiceItemAmount` was `Math.round(quantity * unitAmountCents)` — so a
manual invoice line at quantity `0.29` and 50 cents has always been refused by the
database. It is fixed here rather than recorded and left, because it is one line of
application code with no migration behind it and the failure is a 500 on a
legitimate write; and it is fixed by **delegating to `lineTotalCents`** rather than
by copying its body, so the two money identities in this product cannot drift apart
again.

**14. `0008` named its table-level constraints anonymously, and the obvious guess
is backwards.**

`0045` widens `invoice_items.source_type` to include `VARIATION`, which means
dropping and recreating the paired constraint that requires a `source_id`. Postgres
has no `alter constraint`, and `0008` declared both of its table-level checks
without names — so the generated ones are `invoice_items_check` for the **amount
identity** and `invoice_items_check1` for the source pairing.

The first draft of `0045` dropped `invoice_items_check`. **Nothing would have
failed.** No test asserts that constraint by name, the migration applies cleanly,
and the loss of the guard that keeps an invoice line's total equal to its quantity
times its unit price would have surfaced years later as one invoice that did not
add up — on a table whose rows are sent to clients.

Caught by reading the live catalog rather than by reasoning about the file. The
pairing is now dropped by its real name, and the amount identity is re-declared as
`invoice_items_amount_identity` so that `invoice_items_check` stops being a name
anybody has to look up. The parity test asserts both.

**15. Two SQL failures that `tsc` cannot see, and one of them bit three times.**

A **backtick inside a SQL comment ends the enclosing template literal.** A comment
reading ``-- No `deleted_at` filter, because…`` broke the query it documented; the
container failed to boot with *"Expected ) but found deleted_at"*, and
`tsc --noEmit` passed, because what remained was still parseable TypeScript. It
recurred twice more in the same phase — once in the replacement comment, once in
the demo fixture — which is why every SQL comment in this phase's code quotes
identifiers in plain text. **Prose inside a SQL template is code.**

And a **`union all` takes its column names from the first branch.** §35's timeline
builds its CTE from whichever clauses a caller's `types` filter left in, so
`?types=VARIATION_RAISED` alone produced a CTE with no `kind` column and a 500,
while the unfiltered request was perfectly fine. That is the worst shape a bug can
have — correct in the case everybody tries first — and the fix is that every clause
names and casts its own seven columns rather than relying on position.

**16. The demo fixture drifted in exactly the way finding 5 says a check constraint
cannot catch.**

The Phase 11 demo slice writes both a variation's lines and its header totals by
hand, which no other writer in the product does — everything else goes through
`recalculateVariationTotals`. Its line ids were derived from `variation.id.slice(0,
8)`, which is the shared `ea000000` prefix, so all three variations' first lines
claimed the same id and `on conflict (id) do nothing` silently dropped two of the
three sets. The seed reported identical counts on a re-run and looked entirely
healthy; what it had produced was two variation headers whose totals did not match
their missing lines.

A `CHECK` cannot aggregate, so nothing in the schema could have caught it. The
assertion now lives where the hand-written total does — the seed queries for drift
before it finishes and **throws**, because a demo account whose variation totals do
not add up is worse than no demo account: somebody will read the figure off the
screen.

**17. Two controls in one form with the same accessible name, found by a
strict-mode violation.**

The variation drawer had a `Description` for the variation and a `Description` on
every line. Playwright refused to fill either — *"strict mode violation: resolved to
2 elements"* — and the tempting fix is `.first()` in the test.

It is a real defect. §42's WCAG gate is about a screen-reader user, and one hearing
"Description" twice inside a single form has nothing to tell the two apart; the axe
sweep passes it happily, because both labels are correctly associated with their own
control. The line field is now **"Line description"**, and the fix is in the panel
rather than in the selector.

Worth recording as its own finding because of *what caught it*: Playwright's strict
mode is the only tool in this repository that reads a form the way an assistive
technology does — by accessible name — and it therefore finds ambiguity that neither
a scanner nor a human reviewer reliably does. `.first()` would have silenced the one
check that noticed.

**18. The "Book someone" picker had no people in it, and nothing else could have
said so.**

`SchedulePanel` takes a `members` prop for §31's `USER` assignments, and the project
page passed `members={[]}` — a placeholder that survived to the first browser run.
The drawer rendered perfectly, the `<select>` was present, focusable and correctly
labelled, and **there was no way to book one of your own team through the UI at
all.**

Nothing else in the stack could have caught it. TypeScript is satisfied by an empty
array; `verify:e2e` drives the API and never opens the drawer; the axe sweep sees a
valid, labelled, empty select. The browser suite found it by timing out on a
`selectOption` that could never succeed — the failure mode of a control that is
present and useless.

The fix loads the company's members, gated on `schedule.manage` (a picker nobody can
submit is a request made for nothing) and filtered to `ACTIVE` (booking somebody
whose membership was removed puts a person on a site they can no longer sign in to
see). Recorded because it is the clearest case in this phase of a defect that only
a *rendered page* test can be wrong about, which is the sentence
`project-commercial.spec.ts`'s header opens with.

---

## 1. Persona / job

**Ade — contract manager, contractor, desktop.** Runs three live jobs. His week is
two jobs: agreeing the extra works a client keeps asking for and getting them
approved before the crew does them, and knowing on Thursday whether the labour
budget on Marina Bay is going to hold. He does both today in a spreadsheet that
nobody else can see and that disagrees with the invoices.

**Priya — planner / resource coordinator, contractor, desktop, two screens.**
Owns the week. Puts named people and vans on jobs across three sites, moves them
when a client changes a date, and needs to see the clash *at the moment she makes
it* rather than on Monday when two crews arrive at the same address. §31's
drag-and-drop exists for her and for nobody else; every other role in this
product reads the schedule.

**Dana — client project lead, no login on the contractor's tenancy.** Approves
extra works verbally on site and signs a docket. She is not a user, and the
variation records what she agreed rather than authenticating her — the same shape
§34 uses for a signature.

**Femi — supervisor, phone/tablet on site.** Raises the variation *from* the site,
because the moment the client asks for the extra doors is the moment the price
should be captured; a variation raised on Friday from memory is the one that gets
argued about. He may create and he may not approve — those are two capability keys
in §37 and they were separated for this.

**Tunde — finance, desktop.** Turns approved variations into invoice lines and
answers *"why is this invoice bigger than the quote?"* He has `variation.approve`
and `commercial.manage` and no `diary.close`, which is the split §37 exists for.

**Not a persona:** the client, for the schedule. A client seeing which named
person is on which site on which day is the shape of the contractor's operation,
and §29.5's whole boundary is that this does not cross. The portal gets approved
variations at their sell figure and nothing else from this phase.

---

## 2. Resource responsibility

| Resource | Creator | Owner | Reader | Reviewer | Publisher | Corrector | Exporter | Retention owner |
|---|---|---|---|---|---|---|---|---|
| `variations` | `variation.create` on a project the company can reach (Femi, Ade) | project-owning company | project owner + the recording company; client sees `APPROVED`+ at sell | `variation.approve` (Ade, Tunde) | disclosure to the client is implicit in `APPROVED` — there is no separate publish | **nobody**, past `APPROVED`: a correction is a new variation (finding 4) | owner-side export; the client's copy is the §29.5 statement | project-owning company; retained for the life of the company — §36's financial carve-out |
| `variation_lines` | as above, `DRAFT`/`REJECTED` only | via the variation | as above | — | — | **nobody** past `APPROVED` | with the variation | with the variation |
| `project_budgets` | `commercial.manage` | project-owning company | `commercial.read` **only** — a budget is margin by subtraction | — | never leaves the tenancy | `commercial.manage`, freely and always: a budget is a plan and revising a plan is what planning is | owner-side only | project-owning company |
| computed actuals | **nobody — there is no row** (§30.2) | — | `commercial.read` | — | — | corrected by correcting the work | derived into the export | n/a |
| `vehicles` | `crew.manage` | the company | any member (a vehicle is company reference data, like a role) | — | — | `crew.manage`; retired via `active`, never deleted while referenced | company export | the company |
| `schedule_assignments` | `schedule.manage` (Priya) | project-owning company | project owner + the assigned provider's own rows | the assigned party may `CONFIRM` | never client-visible | `schedule.manage`; `CANCELLED` rather than deleted once the day has passed | owner-side | project-owning company |
| `resource_availability` | `crew.manage` | the company that owns the resource | the company; a provider's stated crew count is readable by the hiring company it was stated to | — | — | `crew.manage` | company export | the company |
| `project_role_requirements` | `project.manage` | project-owning company | anyone with `project.read` on the project | — | — | `project.manage` | owner-side | project-owning company |
| the timeline | **nobody — it is a query** | no row exists | whoever can read the underlying record, per source | — | client variant returns only already-client-visible items | corrected by correcting the record | not exported separately | n/a |

Three rows say **nobody** and each says something different. The computed actuals
and the timeline have no writer because they have no row — that is finding 2's
resolution and §35's design respectively. A variation past `APPROVED` has no
corrector because it has a client's agreement attached to it, which is finding 4.

A budget, by contrast, is the one commercial record in this product that **anyone
with the capability may rewrite at any time, with no supersession chain and no
reason required**, and that is deliberate. It is a plan. A plan that cannot be
revised without ceremony is a plan people keep in a spreadsheet instead, which is
the state this feature exists to replace. Its history is `record_revisions`, which
answers *what did we think in March* without making March's number binding.

---

## 3. State machine

### `variations` — six states, mirroring §3.4 and adding two

```
                  ┌──────────────── reject (reviewer) ─────────────┐
                  │                                               ▼
  DRAFT ──submit──▶ SUBMITTED ──approve──▶ APPROVED ──complete──▶ COMPLETED
    ▲                   │                     │                      │
    └── withdraw ───────┘                     │                  invoice
                                              │                      │
  REJECTED ──resubmit──▶ SUBMITTED            └──────────────────────▶ INVOICED
    ▲                                                (COMPLETED or APPROVED)
    └────── reject ────────
```

| From | To | Actor | Notes |
|---|---|---|---|
| `DRAFT` | `SUBMITTED` | creator's company, `variation.create` | Totals are recomputed from the lines and frozen into the header at this instant, not read live. |
| `SUBMITTED` | `DRAFT` | creator's company, `variation.create` | Withdraw. The same escape hatch §3.4 gives a timesheet. |
| `SUBMITTED` | `APPROVED` | project owner, `variation.approve` | The one transition that requires `client_approved_by` **or** an explicit acknowledgement that the client has not agreed it yet — see below. |
| `SUBMITTED` | `REJECTED` | project owner, `variation.approve` | `reject_reason` required. A rejection with no reason is a message nobody can act on, which is §3.4's rule for a timesheet and matters more here. |
| `REJECTED` | `SUBMITTED` | creator's company | Resubmit, after editing. |
| `APPROVED` | `COMPLETED` | project owner, `variation.approve` | The works were done. Optional: a variation may be invoiced without passing through `COMPLETED`, because a contractor invoicing a stage payment on agreed extra works is normal. |
| `APPROVED` \| `COMPLETED` | `INVOICED` | **not a route** | Set by the invoice domain, inside the transaction that creates the line. Never by a caller — see the concurrency rule. |
| `INVOICED` | `APPROVED` | **not a route** | Restored by voiding the invoice, inside that transaction, exactly as a voided invoice makes a time log eligible again. |

`APPROVED`, `COMPLETED` and `INVOICED` are **not terminal in the §3 sense** —
`INVOICED` returns to `APPROVED` when an invoice is voided — but all three are
terminal for *editing*, which is the property finding 4 is about. `REJECTED` is
the only state that is both editable and a decision.

**The client-approval gate on `APPROVED` is a warning, not a block.** §30.1 gives
the columns and does not say they are required, and requiring them would refuse
the commonest real sequence: the client says yes on the phone on Tuesday and sends
the paperwork on Friday, and the crew works on Wednesday. So approval without
`client_approved_by` is permitted and the variation carries
`clientApprovalRecorded: false` on every response that mentions it, which is what
the panel badges and what §29.2's pack section prints beside the row. An
unevidenced approval that nobody can see is the failure; refusing the work is not
the fix.

**Concurrency.** Two reviewers pressing Approve on the same `SUBMITTED` variation:
the transition is a conditional update (`where id = $1 and status = 'SUBMITTED'`)
and the loser gets a 409 naming the state it is actually in — the row-lock-then-act
shape `money-boundary.md` §3 settled and `transitionInvoice` already implements.

Two invoices racing to claim the same approved variation is the case that matters,
because the failure is a double bill. It is handled by the mechanism Phase 6
already built for the identical problem with time logs: `createProjectInvoice`
takes `pg_advisory_xact_lock` on `invoice-project:<id>`, and the variation source
query selects `for update` and filters on `not exists (… invoice_items where
source_type = 'VARIATION' and source_id = v.id and i.status <> 'VOID')`. The second
invoice finds nothing to claim. No new mechanism, which is the point of plugging
into the existing source builder rather than writing a second one.

### `schedule_assignments` — three states, and none of them gate anything

`PLANNED → CONFIRMED` (either party) · `PLANNED | CONFIRMED → CANCELLED` (the
scheduling company).

There is no approval flow and no rejection path, and that is the settled precedent
rather than a new decision. `commercial-agreements.md` §9 answered this for
project assignments: a provider's acceptance is *"recorded and surfaced, and
deliberately not a gate on work capture — gating it would stop a crew logging
hours they had already worked, hours after a decision taken by a different
company."* A schedule assignment is a weaker statement than an assignment and
gating on it would be a stronger claim; it is a plan about next Tuesday, and next
Tuesday's timesheet does not need its permission.

`CANCELLED` rows are retained and **never conflict** (§31 says so explicitly),
which is why cancel is a status and not a delete: a cancelled row is the answer to
*"was Femi ever booked on Marina Bay that week?"*, and it is the row Priya needs to
see when the client asks why nobody turned up.

### `variation_lines`, `project_budgets`, `vehicles`, availability, requirements

No states. A line's lifecycle is its variation's; the other four are configuration
with an `active` flag or a date window, and inventing a machine for them would be
ceremony. `vehicles` retires rather than deletes, which is the same rule
`asset_types` and `destination_types` follow.

---

## 4. Permission + scope matrix

Four independent checks per operation. A row filling in one column is a hole.

| Operation | Feature entitlement | Capability | Company edge | Resource assignment |
|---|---|---|---|---|
| `GET /v1/projects/:id/variations` | `variations` **on the project owner** | `project.read` | owner or assigned provider | project reachable; a provider sees **its own rows only** |
| `POST …/variations` | `variations` on the project owner | `variation.create` | owner or assigned provider | project reachable |
| `PATCH /v1/variations/:id` (+ lines) | as above | `variation.create` | recording company, or the project owner | `DRAFT`/`REJECTED` only |
| `POST /v1/variations/:id/submit` | as above | `variation.create` | recording company | `DRAFT`/`REJECTED` |
| `POST /v1/variations/:id/approve\|reject` | as above | `variation.approve` | **project owner only** | `SUBMITTED` |
| `POST /v1/variations/:id/complete` | as above | `variation.approve` | project owner only | `APPROVED` |
| `GET /v1/projects/:id/budget` | `variations` on the project owner | `commercial.read` | **project owner only** | — |
| `PUT /v1/projects/:id/budget` | as above | `commercial.manage` | project owner only | — |
| `GET\|POST\|PATCH /v1/vehicles` | `scheduling` on the **acting** company | read: `project.read` · write: `crew.manage` | own company | — |
| `GET /v1/projects/:id/schedule` | `scheduling` on the project owner | `project.read` | owner or assigned provider | a provider sees **only rows naming it or its people** |
| `POST\|PATCH\|DELETE …/schedule` | as above | `schedule.manage` | **project owner only** | — |
| `POST /v1/schedule/:id/confirm` | as above | `schedule.manage` | owner **or** the named provider | `PLANNED` |
| `GET\|PUT /v1/projects/:id/role-requirements` | `scheduling` on the project owner | read `project.read` · write `project.manage` | project owner only | — |
| `GET\|PUT /v1/availability` | `scheduling` on the acting company | `crew.manage` | own company; a provider's row is readable by a hiring company it named | — |
| `GET /v1/projects/:id/timeline` | **none** — per-source (below) | `project.read` | owner or assigned provider | per-source scoping applied inside the union |
| `GET /v1/portal/projects/:id/variations` | `client_portal` on the project owner | — (a client has no capability set) | client side of the engagement | `APPROVED`+ only, sell only |

Four things in that table are decisions rather than transcription.

**`variations` and `scheduling` are asked of the project owner, not the actor** —
the 2026-09-01 rule for the fifth and sixth time, and `entitlements.ts` already
carries it for eight keys. A Crew-plan subcontractor raising a variation on a
paying customer's job consumes that customer's entitlement, because the customer
is who invoices it and answers for it. Femi with a phone and a free account
capturing the extra doors on the day the client asked for them is the whole point;
gating it on his own plan reproduces the failure the free tier was invented to
prevent. **`vehicles` is the exception** and it is the same exception
`custom_factors` is: a fleet is company reference data with no project to find an
owner of, so it is checked against the acting company's own plan.

**A budget is `commercial.read`, and the schedule is not.** A budget is margin by
subtraction — revenue minus cost, on one screen, by category — so it belongs to
the key §37 created to keep margin away from a supervisor. The schedule
deliberately is *not* gated that way: Femi needs to know he is on Marina Bay on
Tuesday, and `schedule.manage`/`project.read` carries it without telling him what
the job is worth. That distinction is the entire reason the capability layer
exists, and this is the first phase where both sides of it appear on the same
screen family.

**The timeline has no feature key**, for the reason §21's locations have none: it
is structure rather than content. It also could not have one honestly, because it
is a union over ten record classes whose features differ — a company without
`site_diary` still has time logs and photographs. Each source is filtered inside
the union by the feature that governs it and the scope that governs it, so a
reader sees exactly the events they could have read one at a time and the timeline
is not a way around anything.

**A provider sees only its own schedule rows**, following `activities.ts`'s rule
rather than the mass balance's. A total is not a row: `massBalance.ts` shows a
project's tonnage to everybody on it because a tonnage names nobody, while a
schedule row names a person, a van and a registration — the shape of another
business's operations. A subcontractor learning which of the hiring company's own
crews are on site next week is a disclosure nobody agreed to.

### Forged identifiers

Every id in a request body is checked for **reachability by this caller**, never
merely for existence, which is the rule `activities.ts` and `movementsRoutes.ts`
both state: without it a subcontractor attaches an arbitrary id to its own row and
reads the record back through the expanded response.

- `role_id` → must be in the acting company's `role_catalog`.
- `vehicle_id` → must belong to the **scheduling** company (a hiring company
  cannot book a subcontractor's van; it books the subcontractor and a headcount).
- `user_id` → must hold a live membership in the scheduling company. Booking a
  person in another tenancy is an assertion about somebody else's employee.
- `provider_company_id` → must be a `project_assignments` row on this project, so
  the one-hop rule is checked and not assumed.
- `location_id` → must be on this project.
- `approval_evidence_file_id` → must be a `stored_files` row this company may
  already read, through the existing registry.
- `invoice_id` on a variation is **never accepted from a caller** at all.

A counterparty's variation answers **404, not 403**, which is
`movementsRoutes.ts`'s shape: a 403 confirms the id exists.

---

## 5. Domain events

| Event | Payload | Idempotency key | Consumers | Replay |
|---|---|---|---|---|
| `variation.submitted` | variationId, projectId, companyId, ownerCompanyId, reference, sellTotalCents, currency | `variation-submitted:<id>:<revision>` | notifications | Safe. The `dispatchNotification` aggregate key collapses a resubmit into the same item. |
| `variation.decided` | variationId, projectId, decision, reason, sellTotalCents, decidedBy | `variation-decided:<id>:<status>` | notifications | Safe; keyed on the resulting status so approve-after-reject is a second event and re-approve is not. |
| `variation.invoiced` | variationId, invoiceId, projectId, sellTotalCents | `variation-invoiced:<id>:<invoiceId>` | audit only | Safe. |
| `schedule.assigned` | assignmentIds[], projectId, providerCompanyId \| userIds[], from, to, warnings[] | `schedule-assigned:<batchClientId>` | notifications | Safe. **One event per batch**, not per row. |
| `schedule.changed` | assignmentId, projectId, what moved (from/to), status | `schedule-changed:<id>:<updatedAt>` | notifications | Safe. |
| `budget.set` | projectId, categories changed | — | audit + `record_revisions` only | n/a |

**`schedule.assigned` is a batch event and that is the load-bearing choice in this
table.** Priya's Monday morning is one act: eleven people onto three jobs for a
week. Eleven — or fifty-five — Action Centre items is a channel every recipient
turns off, and then the one that mattered is missed. This is the same reasoning
`evidence.batch_uploaded` and `asset.lines_recorded` were both decided on, and it
is the third time, so the mechanism is reused rather than re-argued: a
client-supplied `batchClientId` keys the single event, exactly as
`project_evidence.batch_client_id` does.

**Two events are deliberately absent.**

`variation.created` is not an event. A draft is a piece of thinking; telling
anybody about it is telling them about a thought. `variation.submitted` is when a
person acquires a decision to make, which is what an event is for. (The same
distinction `report.generated` was refused on.)

`budget.set` is **audit and revisions only, with no outbox event and no
notification**, and it is the one entry here that could plausibly go the other
way. A revised budget is a genuinely interesting fact — but it is interesting to
the person who revised it, who did it on purpose thirty seconds ago, and to nobody
else in a way that survives the second week. The durable trail is
`record_revisions`, which answers *what did we think in March* without producing an
item somebody has to clear. This is `sustainability.calculations_superseded`'s
reasoning with a different noun.

---

## 6. Notification matrix

| Kind | Recipient | Channels | Action? | Urgency | Digest / quiet hours | Escalation |
|---|---|---|---|---|---|---|
| `variation.submitted` | project owner's `variation.approve` holders | PUSH + EMAIL | **yes** | NORMAL | ordinary rules | none automatic; it sits in the Action Centre until decided |
| `variation.decided` | the recording company's managers, and the submitter | PUSH + EMAIL | no | NORMAL | ordinary | — |
| `schedule.assigned` | each assigned provider's managers; assigned internal users | PUSH | no | NORMAL | ordinary | — |
| `schedule.changed` | the assigned party | PUSH | no | NORMAL | ordinary | — |

Four kinds, and the shape of the table is decided by what is not in it.

**`variation.submitted` earns email, and it is the only one of the four that
does.** Money being negotiated is worth an email for the reason
`rate_proposal.submitted` was given one: it is rare, and the person who must
decide is frequently not the person watching the app. A variation is the same
event with a different counterparty — and it has a deadline nobody records,
because the crew is going to do the work on Wednesday whether or not anybody
approved it.

**`schedule.assigned` is push-only, and that is the honest reading.** "You are on
Marina Bay on Tuesday" is news, not a task: there is nothing owed to anybody, and
an Action Centre item that can only be dismissed is an inbox that teaches people
to dismiss without reading. Priya's plan changes four times a week.

**There is no `variation.overdue` and no `schedule.tomorrow`.** Both are the
class of kind that fires on a clock rather than on an act, which is Phase 12's
alert-ladder machinery (§33) and needs the nightly job to own it. Inventing a
second scheduler here would be building the thing Phase 12 is for, one phase
early and in the wrong module.

**And there is no notification for a conflict.** A clash is surfaced *in the
response to the save that created it*, to the person who created it, at the moment
they created it — which is §31's own wording (*"surfaced at save time with the
clash named"*) and is strictly better than an item they read later. A conflict
warning that arrives as a notification is a conflict warning that arrives after
the crew has been told.

Every kind lands as a durable Action Centre item first, per `notifications.md`'s
standing rule: email and push are never the only copy of a task.

---

## 7. Data classification + retention

| Record | Class | Default visibility | Lifecycle | Legal hold | Deletion | Export |
|---|---|---|---|---|---|---|
| `variations` header | **commercial**, with one personal field | project owner + recording company; client from `APPROVED` | permanent | yes, once invoiced | never deleted while an invoice cites it (`restrict`); project delete refuses | owner export; client sees it in the §29.5 statement |
| `variations.client_approved_by` | **personal** (a named person outside the tenancy) | as above | permanent | with the record | survives an erasure request as a name; it is evidence of an agreement, not a profile | included; **never** used to contact anybody |
| `variation_lines` | commercial | via the header | permanent | with the header | with the header | with the header |
| `approval_evidence_file_id` | **evidence** | via the header | permanent | **yes** — `on delete restrict`, the artifact-class hold Phase 10 built | never reclaimed by a retention sweep | referenced, not carried (2026-09-01) |
| `project_budgets` | commercial, **internal only** | `commercial.read` on the owner | mutable, freely | no | with the project | owner export only; **excluded from every client-facing document** |
| `vehicles` | commercial reference; `registration` is **quasi-personal** for a sole trader | the company | retired, not deleted | no | anonymised on closure with the company | company export |
| `schedule_assignments` | commercial + **personal** (`user_id` is a named person's whereabouts) | owner + the named provider | `CANCELLED`, not deleted | no | anonymised on closure | owner export |
| `resource_availability` | **personal** where it names a user — an availability window is a person's private time | own company; stated crew counts to the hiring company | mutable | no | with the membership | company export |
| `project_role_requirements` | commercial | project readers | mutable | no | with the project | owner export |
| the timeline | **derived — no rows, no retention** | per source | n/a | n/a | n/a | not exported separately |

Three entries are decisions.

**`project_budgets` is excluded from every client-facing document, structurally.**
A budget is a statement of expected margin: revenue minus cost, by category, on
one screen. §29.5's boundary exists so a PAY figure never reaches a client, and a
budget is the *forecast* of every PAY figure on the project plus the markup. It is
therefore not filtered out of a client snapshot — the `ClientExportSnapshot` and
`ClientWorkforceSummary` types have no field it could occupy, which is the
mechanism finding 3 of the reporting packet established and the reason to reuse
those types rather than add a flag.

**`resource_availability` naming a user is personal data about someone's private
time.** "Unavailable, 14–21 August" is a holiday; "unavailable Thursday
afternoons" is frequently a medical appointment. It is readable by the employing
company and by nobody else — never by a hiring company, which gets a stated crew
*count* and no window — and it carries no `reason` column at all, deliberately, so
there is nowhere for the medical appointment to be written down.

**`client_approved_by` survives an erasure request.** It is the same carve-out
`client_signoffs.signer_name` takes: the row is evidence that a named person agreed
a sum of money, and erasing the name leaves an unattributable claim on an invoice.
The contact detail — there is deliberately no `client_approved_email` column — is
where an erasure would bite, and it does not exist.

Retention: `record_revisions` rows backing a variation are held **for the life of
the company**, not for `audit_retention_days`. §36 makes that carve-out for
revisions attached to a generated report and for approved time and rates; a
variation is on §36's starred list by name, and it is money on an invoice.

---

## 8. Offline / conflict policy

Two of the six record classes in this phase are field-captured and the other four
are not, and only the two get the sync contract.

**`variations` — full contract.** Femi raises one on a phone in a stairwell with
the client standing next to him. `client_id` for idempotency (the retry that
cannot tell whether the first attempt landed must be able to ask), and
`expected_revision` on every update with `detectConflict` deciding, exactly as
`project_activities` does. A conflict is **refused rather than merged**: a
variation is a price, and field-merging two versions of a price produces a figure
nobody quoted. Both versions travel with the 409 so the device can show *keep
mine* / *keep theirs*, which is the Phase 7 shape.

**A tombstone rather than a delete**, so a draft deleted at the desk cannot be
resurrected by a phone that has been in a pocket since Tuesday. `GONE` rather than
`NOT_FOUND`, because the device has to tell *stop queueing edits for this* from
*you may not see this*.

**`schedule_assignments` — idempotency only, and deliberately no expected-version
merge.** Priya schedules from a desk on a wired connection; §31 and §32 both make
mobile *read-plus-confirm, not drag*. What the schedule does need is
`batchClientId`, because "Monday's plan" is one act of eleven rows and a retry
must not produce twenty-two. `PLANNED → CONFIRMED` is idempotent by construction:
confirming a confirmed row is a no-op that returns the row.

**The other four take neither**, and saying so is the answer rather than a gap: a
budget, a vehicle, an availability window and a role requirement are all typed at
a desk, and an idempotency ledger for a `PUT` that is already idempotent is
machinery with no failure to prevent. `PUT /v1/projects/:id/budget` is a whole-row
upsert; sending it twice sets the same numbers.

**What Priya sees when a conflict happens** — which is the question §8 is actually
about, and the answer is *not a conflict dialog*. A schedule clash is not a
concurrency conflict; it is a real-world one, and §31 says it warns rather than
blocks. So the save **succeeds** and the response carries `warnings[]` with the
clash named — *"Femi Adeyemi is also on Pier 9, 07:00–17:00 Tuesday"* — rendered
beside the row she just created, with a link to the other one. Refusing the save
would be wrong on the facts: sometimes the double-booking is the plan, because the
job at Pier 9 finishes at noon and the schedule does not know that.

---

## 9. Failure matrix

| Failure | Class | Partial success | Operator repair | What the user sees |
|---|---|---|---|---|
| Approve loses the race | terminal | none — conditional update | none needed | 409 naming the state it is actually in, and the current row |
| Two invoices claim one variation | terminal for the loser | none — advisory lock + `for update` | none needed | the second invoice simply has no variation line; the panel shows it as already invoiced with a link |
| Header total ≠ Σ lines | **must be impossible** | — | a parity query in the acceptance script | never surfaced; the check constraint and the in-transaction recompute are the two mechanisms |
| Planned cost has no rate card | **not a failure** | figure withheld | the gap is the message: *no BILL/PAY card covers this role on this date* | the planned column reads *not priced* with the reason, never £0 |
| Actual has no source (finding 2) | **not a failure** | — | none — it is the truth | *not tracked* with the reason, never £0 / −100% |
| Assignment overlaps another | **not a failure** | row is saved | none | `warnings[]` beside the saved row, clash named, linked |
| Assignment outside availability | **not a failure** | row is saved | none | as above |
| Requirement unfilled | **not a failure** | — | none | a shortfall indicator on the project, `2 × Rigger` → `1 short` |
| `vehicles` delete with assignments | terminal | none | none | refusal naming the count, offering Retire — the `restrict` shape §3.3's locked rate cards established |
| Timeline source table absent | **skipped, not fatal** | partial union | none | the registry may describe the product ahead of its migrations, exactly as `countLocationReferences` allows |
| Project delete with variations | terminal | none | none | the existing refusal sentence, extended to name variations |

**Six rows in this table say "not a failure", and that is the shape of the phase
rather than an accident.** Phase 11's whole subject is figures that are sometimes
unknowable — a plan with no rate, an actual with no source, a clash that might be
intentional — and the recurring mistake in all three is rendering the unknown as a
number. Every one of those six resolves the same way: report the absence, name the
reason, and never print a zero. That is §41.1 lifted out of the carbon engine,
where it was written, and applied to money, where it was always going to be needed.

**The timeline's skip rule is copied from `countLocationReferences` deliberately.**
A union over ten tables in a codebase where migrations arrive one phase at a time
will, at some point, name a table that is not there — and a timeline that 500s
because Phase 12 has not shipped is a worse failure than the one the registry
prevents. Existence is checked against `information_schema` once per request and
absent sources are omitted, with the registry naming what is expected so nobody
mistakes an omission for a bug.

---

## 10. Security / threat model

**Tenant boundary.** Every query is scoped by `project_id` through `projectAccess`
or by `company_id` directly. The two new cross-company reads are both narrow and
both stated: a hiring company reads a provider's *stated crew count* (a number the
provider chose to state to them, not their staff list), and a provider reads its
own schedule rows on a project it is assigned to. Nothing else crosses.

**Forged identifiers** — the seven checks in §4, each of which is a reachability
check rather than an existence check. The one worth naming separately is
`vehicle_id`: it is checked against the **scheduling** company, so a hiring
company cannot book a subcontractor's van. Booking somebody else's asset is an
assertion about their business, and it is the same reasoning
`project_activities.provider_company_id` was restricted to the acting company on.

**Upload surface.** One new field points at `stored_files`
(`approval_evidence_file_id`) and it adds no new upload path — it accepts a file id
the caller can already read, through the existing registry, and the storage
layer's own presign limits are unchanged. It joins `FILE_ACCESS_GRANTS` so the
docket photograph is readable by the parties to the variation, and it joins
`FILE_CLIENT_DISCLOSURES` **only for an `APPROVED` variation on a client-visible
project** — the client may see the docket they signed, which is narrower than
publishing the photograph to them generally and is the exact grant shape Phase 10
built for a report's evidence.

**Privileged access.** Unchanged and still none: `access.md` §13.3 refused
platform support access and this phase adds no operator read. The super-admin
console gains nothing from Phase 11.

**Abuse.** `POST …/variations` and `POST …/schedule` are both authenticated,
company-scoped, capability-gated writes with body limits, so the abuse surface is
a member of a company writing rows in their own company — bounded by
`active_projects`, which is unset, and by nothing else. Worth stating rather than
implying: **there is no ceiling on variations or assignments per project**, and the
`storage_gb` reasoning does not transfer because a row is not a gigabyte. If a
limit is ever wanted it is a `LIMIT_KEYS` entry and a `withinLimit` call, and §43
proposes none.

**One genuine new exposure, and it is in a response body rather than a route.**
`schedule_assignments` joined to `users` and `vehicles` produces the most
operationally sensitive payload this API has ever returned: named people, their
roles, their registrations and their whereabouts by the hour, for a week, in one
GET. Three things bound it — a provider sees only rows naming it, the client sees
none of it at all, and the query is `project_id`-scoped so there is no
company-wide "everybody's week" endpoint that a project-level read could be
widened into. The company-wide planner view Priya works in is assembled
**client-side from the projects she can already read**, which keeps the boundary
where every other read in this product keeps it.

---

## 11. Analytics contract

| Metric | Event | Definition |
|---|---|---|
| Activation — variations | `variation.first_submitted_in_company` | The first variation to leave `DRAFT` in a company. Drafts do not activate: a draft is a thing somebody tried, and counting it would report a feature as adopted by everyone who opened the panel. |
| Activation — scheduling | `schedule.first_week_planned` | The first calendar week with **≥ 3** assignments in one company. One assignment is a trial; a week with three is somebody running their operation on it. |
| Activation — budgets | `budget.first_set` | A `project_budgets` row with at least one non-zero category. |
| Outcome — variations | `variation.approved_with_client_evidence` | Approved **and** carrying `client_approved_by`. The outcome is not "a variation exists"; it is a contractor able to prove the client agreed to pay. |
| Outcome — scheduling | `schedule.conflict_resolved_before_the_day` | A warned assignment moved or cancelled before its `starts_at`. The feature's value is catching the clash in the office rather than on site, and this is the only event that measures it. |
| Funnel | created → submitted → approved → invoiced | Per company, with dwell time at each step. |
| Quality | `variation.approval_lag_days` · `schedule.warned_assignment_rate` · `budget.untracked_category_share` | The third is finding 2 turned into a number: the share of budgeted money in categories with no source. If it stays high, the six null rows are a product gap rather than a documentation one. |

**Excluded from every payload as sensitive:** `sell_total_cents`,
`cost_total_cents` and every budget figure (a customer's margin is not telemetry);
`client_approved_by`, `requested_by`, `reference` and `description` (free text, and
the first two are names); `registration`; `user_id` and every availability window.
Counts, states, lags and shares only — the same rule `scrub.ts` already applies.

`budget.untracked_category_share` is the one metric here that exists to hold this
packet to account, and that is deliberate. Finding 2 says six categories have no
source and argues the honest answer is to say so. If real customers budget most of
their money in those six, then the honest answer was the right *rendering* and the
wrong *scope*, and this number is how anybody would find that out.

---

## 12. Acceptance script

Ade's contractor company on Pro. Marina Bay, a live project with a client
(Dana's), one subcontractor assigned, approved time logs and approved expenses
already on it from the Phase 3/4 fixtures. This is the script `verify:e2e`
implements step for step.

1. **The empty project.** `GET …/budget` on a project with no budget row returns
   the ten categories with `budgetCents: 0`, the four computable actuals as
   **numbers**, the six others as **`null` with `coverage: 'NO_SOURCE'`**, and
   every variance null where its actual is. `GET …/variations` returns `[]`. `GET
   …/schedule` returns `[]` with `warnings: []`. **Nothing anywhere is `0` where
   the truth is "not tracked", and nothing is `-100`.**
2. **Denied four ways, and each refusal names a different thing.** A member
   holding only the Worker bundle is refused `POST …/variations` naming
   `variation.create`. A supervisor with `variation.create` is refused
   `POST /v1/variations/:id/approve` naming `variation.approve`. A supervisor is
   refused `GET …/budget` naming `commercial.read` — **the check that proves the
   capability layer earns its existence.** And a Starter-plan company is refused
   the whole domain naming the feature `variations`; the subcontractor on Marina
   Bay, on the free Crew plan, is **allowed** to create one, because the feature is
   the project owner's.
3. **Raise, price off the rate engine, submit.** Femi creates a variation with a
   `LABOUR` line carrying `roleId` and 16 hours and **no prices**; the response
   fills `unitCostCents` and `unitSellCents` from the PAY and BILL cards in effect
   on `requestedOn`, and `costCents`/`sellCents` are `round(quantity × unit)`. A
   `MATERIAL` line is added with prices stated directly. The header totals equal
   the sums of the lines. Submit; the totals are frozen; `variation.submitted`
   reaches the owner's `variation.approve` holders and **not** the submitter.
4. **The rejection, and the resubmit.** Ade rejects with a reason; a rejection with
   no reason is refused 422. The variation is editable again, a line price is
   changed, it is resubmitted, and `record_revisions` carries the before and after
   of that price with `changedFields` naming it.
5. **Approve with no client evidence, then with it.** Approve without
   `clientApprovedBy`: permitted, and every response carries
   `clientApprovalRecorded: false`. Record `clientApprovedBy` + an
   `approvalEvidenceFileId`; the flag flips, and the client on the engagement can
   now `GET` that file — where a photograph on the same project that was never
   attached to an approved variation still answers 403.
6. **The summary, and the asymmetry.** `GET …/summary` now carries
   `variationSellCents` equal to the approved sell, `variationCostCents` equal to
   the approved cost, `revenueCents = billCents + variationSellCents`, and
   `totalCostCents` **unchanged from step 1** — the variation's cost is not in it.
   Margin is recomputed over revenue. The XLSX export's own cells agree with the
   endpoint, and the client portal shows the sell and **no cost figure of any
   kind**.
7. **The edit that must be refused.** `PATCH` a line on the approved variation:
   409, with a sentence saying a correction is a new variation. `PATCH` the header
   total directly: the field is not in the schema, and a caller supplying
   `sellTotalCents` has it ignored rather than honoured. Re-read: unchanged.
8. **Budget versus actual, including the approved variation.** `PUT …/budget` with
   `revenue`, `labour`, `subcontractor` and `expenses` set and `vehicle` set to a
   non-zero figure. `GET …/budget`: the four computed rows carry real actuals and
   signed variances; `revenue`'s actual **includes the approved variation**;
   `vehicle` carries `budgetCents > 0`, `actualCents: null`,
   `coverage: 'NO_SOURCE'` and a `reason` naming what would have to exist. The
   expense breakdown beside it sums to the expenses actual.
9. **Invoice it once.** Create an invoice with `includeApprovedWork`; it carries a
   `source_type: 'VARIATION'` line for exactly the approved variation, the
   variation moves to `INVOICED` with `invoice_id` set, and a **second** invoice on
   the same project gets no variation line at all. Void the first invoice: the
   variation returns to `APPROVED` and becomes eligible again — the same behaviour
   a voided invoice already has for a time log.
10. **A week's crew, with the clash surfaced.** Priya books Femi on Marina Bay
    Tuesday 07:00–17:00 and a van with him, in one batch with a `batchClientId`.
    Then books Femi on Pier 9 for the overlapping window: the save **succeeds**,
    and the response carries a `USER_OVERLAP` warning naming Marina Bay, the
    window and the other assignment's id. The van double-booked warns
    `VEHICLE_OVERLAP`. A `CANCELLED` row in the same window warns **nothing**.
    Replaying the batch with the same `batchClientId` produces the same rows and
    not a second copy.
11. **Availability, headcount and the unfilled requirement.** Femi is marked
    unavailable Wednesday; an assignment on Wednesday warns
    `OUTSIDE_AVAILABILITY`. The subcontractor states a crew count of 4; a
    `PROVIDER` row for 6 warns `PROVIDER_HEADCOUNT` naming both numbers, and a row
    for 3 warns nothing. A requirement of `2 × Rigger, Mon–Wed` against one
    assigned rigger reports a shortfall of 1; a second rigger clears it.
12. **The schedule reaches the two places §31 says it must.** `GET
    …/diary/prefill` now returns `sources: { timeLogs: true, schedule: true }` and
    offers a suggestion with `source: 'SCHEDULE'` for a scheduled person with no
    timesheet — and **does not** double-offer somebody who has both. The
    assignment's planned labour cost resolves through the rate engine when
    `shiftType` is set and is **withheld with a reason** when it is not (finding 6).
13. **The timeline reads like a story.** `GET …/timeline` returns project
    creation, the assignment, the diary entry, the approved time, the photographs,
    the asset movement, the document, the variation and its approval, and the
    sign-off — in event-time order, keyset-paginated, each item carrying type,
    timestamp, actor, one line of description and a link. Filtering by
    `types[]=VARIATION` returns only those. The **client variant** returns only
    already-client-visible items: no PAY figure, no unpublished photograph, no
    schedule row, and no budget.
14. **The correction path.** Correct a weight behind the project (Phase 8) and
    re-read: the timeline shows the movement at its original time and the summary's
    variation figures are untouched — a variation is not a function of a weight.
    Then supersede the *variation* the only way permitted, by raising a second one,
    and assert both are visible with the first still `INVOICED`.
15. **Delete refusals.** `DELETE` the project: refused, naming the variations
    alongside the reports and sign-offs it already names. `DELETE` a vehicle with
    assignments: refused, naming the count and offering Retire. `DELETE` a
    location used by a schedule assignment: refused with the registry's sentence —
    and, because the registry gained two entries this phase, also refused for a
    location used by an asset line.

---

## 13. Decisions

### 1. Which plans get `variations` and `scheduling`? → **OPEN — seeded exactly as §43 proposes, and the packaging is the owner's**

§43's table puts both at **Starter and up**, and both are seeded that way with no
departure. This is the fourth time this entry has appeared and the first time the
answer is "§43 exactly": `client_signoff` was moved a tier down with a stated
reason, and the storage figures were kept as a pricing judgement. Neither applies
here. Variations and scheduling are both *operating* features rather than
publishing ones, they cost nothing marginal to serve, and Starter is described as
*"run your own subcontractors"* — which is exactly who has extra works and a
week to plan.

The **rule** is settled and is not open: the feature is the **project owner's**,
which is the 2026-09-01 decision for the fifth and sixth time. What stays open is
the placement, like every other §43 figure.

### 2. Does a variation's lump sum exclude the hours behind it from the invoice? → **OPEN, and the build takes the conservative arm**

This is the phase's one genuinely commercial question and it cannot be answered
from the plan.

CrewQuo's invoice is built from approved time logs priced at BILL rates plus
approved expenses at cost. A variation adds an agreed lump sum. If the crew logged
16 hours doing the extra doors — and they did, because that is how they get paid —
those hours are approved time logs, and the invoice bills **both** the £4,000
variation and the BILL-rate value of the same 16 hours. That is a double bill, on
a document a client receives.

Three arms:

- **(a) Bill both, and say so.** What the build does. It is correct for the common
  case: a time-and-materials engagement where the variation records additional
  *scope* the client agreed to pay for over and above the hours — a fixed price
  for the doors, and the hours are the contractor's own cost. It is wrong when the
  variation was quoted *as* the price of those hours.
- **(b) Mark time logs as belonging to a variation and exclude them from BILL
  derivation.** Correct, and it needs a `variation_id` on `time_logs`, which is a
  Phase 3 table with five readers and a frozen rate snapshot. It also asks a
  supervisor logging hours to know which commercial instrument they belong to,
  which is a question about paperwork asked of somebody holding a tape measure.
- **(c) Refuse to bill a variation on a project that has approved time logs in its
  date window.** Refuses the common case to prevent the rare one.

**Built as (a), with the ambiguity made visible rather than resolved silently.**
The invoice line is labelled as a variation and carries the reference; the
variations panel shows, beside an approved variation, the count of approved time
logs on the project inside its date window — *"3 approved timesheets fall in this
window; check you are not billing these hours twice"* — and the acceptance script
asserts the variation is billed exactly once. The product cannot know from the
data which basis was agreed, so it declines to guess and puts the question in front
of the only person who does know, at the moment they are creating the invoice.

Recorded rather than asked because it is answerable by looking: if
`variation.approved_with_client_evidence` is high and customers complain about
double billing, (b) is the answer and the migration is additive.

### 3. §30.2 declares ten categories and the product can compute four → **RECORDED — say so; do not invent a mapping**

Finding 2. Both alternatives are worse: rendering £0 is §41.1's invented number,
and mapping variation cost lines onto budget categories puts a **forecast** in the
*Actual* column (finding 3). The four that compute are worth having on their own —
labour is where the money is — and the expense breakdown beside them answers the
question the six null rows raise.

Not sent to the owner because it is not a product choice. There is no money column
on an asset movement, and no decision makes one appear.

### 4. Is a schedule assignment a gate on logging time? → **RECORDED — no, following settled precedent**

`commercial-agreements.md` §9 answered this for project assignments on the same
reasoning, and asking it again with a weaker noun would be treating a settled rule
as an open one. A schedule is a plan about Tuesday; Tuesday's timesheet does not
need its permission. The assignment **prefills** the log-time screen (§31) and
gates nothing.

### 5. Do conflicts block? → **RECORDED — no; §31 says so in words**

*"Conflict detection is a warning, not a block."* Recorded here anyway because it
is the single most likely thing for a later reader to tighten in good faith, and
because the reason is not obvious from the sentence: the double-booking is
sometimes the plan, and the schedule does not know that Pier 9 finishes at noon.
Enforced structurally — `detectScheduleConflicts` is a pure function returning
`warnings`, with no code path from a warning to a refusal.

### 6. Does the client see variations? → **RECORDED — yes; `APPROVED` and later, sell only**

A client who agreed to pay for extra works is entitled to see what they agreed to.
It reaches them through the shape §29.5 already built rather than a new one: the
portal returns `APPROVED`+ variations with `sellTotalCents` and the description,
and the type carries **no field a cost figure could occupy**. `DRAFT` and
`SUBMITTED` never cross — a price the contractor is still thinking about is not a
disclosure — and `REJECTED` never crosses, because a client seeing a variation
their own team rejected is a conversation the product should not start.

### 7. Does the timeline get a feature key? → **RECORDED — no, and it could not honestly have one**

Structure rather than content, like §21's locations. And a union over ten record
classes whose features differ has no single key to be gated on: a company without
`site_diary` still has time logs and photographs. Each source is filtered by the
feature and the scope that governs it, so the timeline shows exactly the events its
reader could have read one at a time.

### 8. Is `project_activities.vehicle_id` added now? → **RECORDED — yes; this is the phase that supplies its reader**

Finding 8, and the third time the column has been deferred. `0030`'s rule refuses a
column with no reader; the reader arrives with `vehicles`. The prefill copies
rather than joins so that retiring a vehicle cannot restate last year's emissions.

---

## 14. Build order

Ten steps. The pure core first, for the reason §27.1 and §44 both give: the
arithmetic has to be right before anything renders a figure — and here the
arithmetic includes deciding, in one place, what "no source" looks like.

- **11.0 — the pure core.** `packages/shared/src/variations.ts` (the status machine
  as data, the transition table, `computeVariationTotals`, the line-total identity
  finding 5 turns into a constraint), `budgets.ts` (the ten categories with their
  `coverage`, `computeVariance` returning nulls rather than zeros),
  `scheduling.ts` (`detectScheduleConflicts`, `unfilledRequirements`,
  `windowsOverlap`), `timeline.ts` (the event-type registry with §35's two
  sourceless kinds declared honestly). Exhaustive unit tests **before any
  migration**: every transition by actor and source state, the round-trip identity
  on line totals, and — the one that matters — that no variance function can return
  `0` or `-100` for an absent actual. *Needs no answer from anybody.*
- **11.1 — migration `0045`: variations.** `variations` + `variation_lines`, the
  line-total check constraints (finding 5), `on delete restrict` on the evidence
  file and on the invoice, five nullable user references (finding 12),
  `invoice_items.source_type` gains `VARIATION`, and the `variations` feature key.
- **11.2 — migration `0046`: budgets.** `project_budgets` with **no `currency`
  column** (finding 1) and `unique (project_id)`.
- **11.3 — migration `0047`: scheduling.** `vehicles`, `schedule_assignments` with
  its `shift_type` (finding 6), `resource_availability` and
  `project_role_requirements` (finding 7), `project_activities.vehicle_id`
  (finding 8), and the `scheduling` feature key.
- **11.4 — the variations API.** CRUD in `DRAFT`/`REJECTED`, labour lines priced
  through `resolveRate` against both PAY and BILL, the six transitions, revisions
  on every price change, and the reachability checks in §4.
- **11.5 — the summary and the invoice.** `computeProjectSummary` gains
  `variationSellCents`, `variationCostCents` and `revenueCents` — **sell folded in,
  cost never** (finding 3), with the asymmetry in the function's header — and
  `loadDerivedItems` gains a third source with the `not exists` guard and the
  advisory lock it already has for the other two. The one step that touches code
  five other readers depend on, so it comes with a parity assertion.
- **11.6 — budget vs actual.** The `PUT`/`GET` pair, four computed categories, six
  declared `NO_SOURCE` with reasons, the expense breakdown beside them, and per
  category signed variance.
- **11.7 — the scheduling API.** Vehicles, assignments with batch idempotency,
  confirm, cancel, availability, requirements, and `warnings[]` on every write.
  Plus the two connections §31 requires: the diary prefill's second source, and
  planned labour cost through the rate engine.
- **11.8 — the timeline.** The union, keyset-paginated, per-source scoped and
  feature-filtered, with the `information_schema` skip; the client variant over
  already-client-visible items only.
- **11.9 — the screens.** Three project sections (Variations, Budget, Schedule) and
  a company-level week planner with **drag-and-drop and a registered keyboard
  equivalent** — the `DRAG_EXEMPTIONS` entry is part of this step and the suite does
  not go green without the control it names. Plus the timeline panel, the fleet
  screen, and the portal's variations list. `CURRENT_BUILD_PHASE` → 11, which is
  what makes `PACK_VARIATIONS` appear.
- **Milestone:** budget vs actual including approved variations, and a week's crew
  scheduled with conflicts surfaced — with the six untracked categories saying so
  rather than reading as −100%.

**Shipped 2026-09-03.** All ten steps built. `verify:e2e` is **1,963 checks** (from
1,770), the browser suite **161** (from 147), and unit tests **1,602** (from 1,475).
The §12 script is implemented step for step across three sections, and the milestone
is asserted at three levels — pure unit tests on the variance and conflict functions,
the live API suite on the summary/invoice/schedule path, and the browser suite on
what the four panels actually render.

**Four findings were added by the build rather than by this packet** (§0, findings
13–18), and every one of them was caught by something failing rather than by
somebody noticing: a unit test on its first run, a query against the live catalog, a
container refusing to boot, a fixture whose counts looked perfectly deterministic
while its totals had quietly stopped adding up, a browser strict-mode violation
that turned out to be a real accessibility defect, and a picker that rendered
perfectly with nothing in it.
