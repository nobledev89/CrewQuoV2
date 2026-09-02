# Operating-model packet — sustainability & the carbon engine

**Domain:** the Phase 9 record set — emission factor sets and their factors, the
product carbon factor library, project activities, the persisted
`carbon_calculations` ledger with its buckets and supersession,
`avoided_emissions_claims`, and `sustainability_settings` — together with the
data-completeness score (§28.3) that Phase 8 deliberately withheld and this phase
owes.
**Phase:** 9 · **Status:** **adopted** — §14 fully built, all ten steps shipped, and its
one open decision (§13.1, Scope 2 basis) built as recommended · **Last updated:** 2026-09-02
**Plan refs:** §26 (factor architecture), §27 (the calculation service), §28
(metrics and data quality), §38.1 (the organisation dashboard), §39 (the settings
table that governs six behaviours already shipped as parameters), §41 (all ten
non-negotiables land in this one phase), §43 (`sustainability`, `carbon_engine`,
`custom_factors`, `factor_sets`), §44 (the exhaustive-tests-first rule and the
firewall test), §45 (the licensing gate and the four decisions resolved on
2026-08-18), locked decision **#17** (avoided emissions never added to anything).

---

## 0. Why this packet, and why now

Every packet before this one has been written to protect a record. This one is
written to protect a **claim** — and the difference is the whole reason it exists
before the migration rather than after it.

Phase 8 produced a tonnage split. A wrong tonne is a wrong tonne: embarrassing,
correctable, and visible to anyone who recounts the chairs. Phase 9 multiplies
those tonnes by factors and publishes two numbers a customer puts in their own
annual report — *"3.84 tCO₂e emitted, 27.42 tCO₂e avoided"* — under a methodology
statement, over a reporting period, with a client's signature eventually attached
to it (§34). A wrong number here does not stay inside CrewQuo. It is quoted,
aggregated by §38.2 into a client's year, frozen into a §29.4 report snapshot that
is deliberately never recalculated, and defended by whoever published it.

§41 exists for exactly this and says so in its own last line: *"When a product
decision and one of these principles conflict, the principle wins — and the
conflict goes to the user, not into the code."* This phase is the first where all
ten principles bind at once, and **writing the packet found the plan's own DDL
contradicting, in four separate places, a rule stated elsewhere in the same
document** — one of them an owner decision that had already been taken.

### What writing it found

Ten findings. The first would not have been a migration to undo — it would have
been a published claim to retract, which is the more expensive of the two and the
one no schema change repairs.

**1. §39's `default_displacement_pct numeric(5,2) not null default 100`
contradicts an adopted owner decision, and it fails in the direction that
inflates the headline.**

Three statements, all currently in the plan:

- §45, resolved in the 2026-08-18 planning pass: *"**Displacement:** defaults to
  `UNKNOWN`, never 100%. A claim requires an explicit, attributable assumption."*
- §27.4: *"`UNKNOWN` produces no claim — it is counted as a data-quality gap, not
  silently treated as 100%. The org default lives in §39, never in code."*
- §39: `default_displacement_pct numeric(5,2) not null default 100`.

The column **cannot express `UNKNOWN` at all** — it is `not null` over a numeric —
and its default is the exact value the decision forbids. Built literally, every
company is created with a 100% displacement default; every reuse movement resolves
against it; and `avoided_emissions_claims.displacement_basis` records
`ASSUMED_FULL` on a claim nobody ever asserted. The avoided figure is the largest
number this product publishes and the one with the least external scrutiny, and
this makes it maximal by default, silently, on every project.

`avoided_emissions_claims` already has the correct shape one table over —
`displacement_pct` nullable, `displacement_basis` in
`('ASSUMED_FULL','USER_DEFINED','UNKNOWN')`. The settings row needs the same pair
rather than half of it:

```sql
default_displacement_basis text not null default 'UNKNOWN'
  check (default_displacement_basis in ('ASSUMED_FULL','USER_DEFINED','UNKNOWN')),
default_displacement_pct numeric(5,2),
constraint sustainability_settings_displacement_basis_matches_pct check (
  (default_displacement_basis = 'USER_DEFINED') = (default_displacement_pct is not null)
)
```

The check is the load-bearing half. Without it the two columns drift into a state
that reads as an assumption — a basis of `UNKNOWN` sitting next to a stored 80 —
and the resolver has to guess which one the operator meant. **A pct without a
basis is a number nobody claimed.** The `=` between the two predicates rather than
an implication is deliberate: it refuses `ASSUMED_FULL` carrying a stray 80 just as
firmly as it refuses `USER_DEFINED` carrying nothing, because 100% is what
`ASSUMED_FULL` *means* and a second copy of it is a second answer.

*Rejected — keep `not null default 100` and let the per-line value override it.*
It is what the DDL says and it is cheaper by one column. It also makes the
product's most consequential default the one an operator is least likely to
notice, and turns §45's decision into a line of documentation contradicted by the
schema underneath it. The failure is silent, favourable, and discovered by
whoever audits the customer.

*Rejected — nullable `default_displacement_pct` alone, null meaning `UNKNOWN`.*
One column, no check constraint, and it collapses the distinction the claim table
draws between `ASSUMED_FULL` and `USER_DEFINED`: 100 in the column could be either
a deliberate full-displacement assumption or a user-typed coincidence, and §27.4
requires the claim to record which. The basis is not derivable from the number.

**2. `unique (company_id, name, version)` does not constrain the platform
library, and this is the third table to make the same mistake.**

`emission_factor_sets` has a nullable `company_id` — *"null = platform-wide set"* —
and a unique constraint over it. In Postgres, nulls are distinct in a unique
index, so the constraint binds company rows and **does nothing whatsoever to
platform rows**. Two platform-wide sets named "UK Government GHG Conversion
Factors 2027" at version "v1.1" coexist happily, each holding a full copy of the
factors.

Phase 8 hit this precise shape in `destination_types` (its §0 finding 8) and fixed
it with the pair `asset_types` already had: one partial unique index for company
rows, one for the system catalog. The same pair is required here, and the
consequence of not having it is worse than a duplicate row. `resolveFactor` picks
from what the join returns; with two identical sets, **which factor id a
calculation cites depends on join order** — so the same project, recalculated
twice with nothing changed, produces rows citing different `factor_id`s. §41.2
requires every result to name its activity data, factor, factor version and
methodology. It can still name all four. They are just not stably the same four,
which is the failure §41.3's reproducibility promise cannot survive.

**`product_carbon_factors` is worse: it has no unique constraint at all**, and the
same nullable `company_id` platform-library intent. Its resolver walks a five-tier
preference order (§26.3), so a duplicate does not merely duplicate — it can outrank
itself, and an `ORG_SPECIFIC` factor entered twice is indistinguishable from an
organisation that genuinely holds two.

**3. `project_activities.created_by_user_id uuid not null references users(id)`
contradicts the closure promise, for the third time.**

`0030` found it, `0034` found it again, and the fix has not changed: nullable,
`on delete set null`, and the null **is** the tombstoned identity rather than a
missing value. The 2026-08-20 decision makes account closure anonymise the person
and preserve the record; `not null` makes *"close this account"* either impossible
or destructive of a project's activity ledger — and an activity row is an input to
a published emissions figure, so destroying one silently changes a number that has
already been reported.

That this is the third occurrence is itself the finding. The canonical DDL was
written before the closure decision existed, so **every remaining table in §26–§39
carrying `not null` on a user reference is wrong for the same reason**, and they
should be corrected as a class rather than rediscovered one migration at a time.
Checked, one by one: `project_activities.created_by_user_id` is `not null` and
wrong; `carbon_calculations.calculated_by_user_id`,
`product_carbon_factors.created_by_user_id`,
`emission_factor_sets.imported_by_user_id` and
`sustainability_settings.updated_by_user_id` are all already nullable and correct.
Only the first needs changing, which is worth stating positively: the DDL is right
four times out of five, and the exception is the one table that is field-captured.

**4. `project_activities.vehicle_id references vehicles(id)`, and `vehicles` is
Phase 11 (§31).**

Identical to Phase 8's finding 7, with the identical resolution and the identical
reason from `0030`: *"a column nothing writes and nothing reads is
indistinguishable, on inspection, from one whose writer is broken."* `vehicle_id`
is omitted and arrives with the migration that creates `vehicles`.

**`vehicle_category`, `fuel_type` and `distance_km` all stay**, and the distinction
is the same one Phase 8 drew: they have a Phase 9 consumer that needs no fleet.
§27.3 prices transport as `distance × factor(vehicle category, fuel)` or
`tonne.km × freight factor`, and a subcontractor's van is a vehicle category and a
fuel type without a `vehicles` row anywhere. The FK is what waits; the semantics
do not.

**5. The data-completeness score is this phase's debt, and it must read §39's
weights rather than constants.**

Phase 8 shipped `describeGaps` and deliberately withheld the percentage, recording
why in its §13.5 and again in `assets.ts`: four of §28.3's five components were
computable, the fifth (*"avoided-emissions mass using a product-specific
non-generic factor"*) is Phase 9's, and *"a percentage published over four fifths
of a definition changes meaning when Phase 9 lands, downward, on projects nobody
touched."* This is the phase that discharges that.

Two things follow that are easy to get wrong.

**`computeDataQuality(inputs, weights)` already takes weights as a parameter in
§27.1's signature, and that is not decoration** — §28.3 says the weights are
configurable in §39, and §39 holds `data_quality_weights jsonb not null` with **no
default in the DDL**. So the defaults have to live somewhere a settings row can be
created from, and the only correct home is the shared module beside the components
they weight, seeded into the row at company creation. A default that lives only in
a migration cannot be read by the engine; one that lives only in the engine means
an edited settings row and the code disagree about what 100% means.

And **the score arrives on projects nobody edited.** A customer who has been
reading named gaps for a phase now sees a number for the first time. That is not a
regression but it will be reported as one, so the phase ships the score with its
components broken out — five rows, each with its weight and its measured value —
rather than a bare percentage. §38.1's rule is already this: *"any figure whose
data completeness is below a configurable threshold is shown with its completeness
percentage attached rather than presented as fact."*

**6. A tombstoned movement leaves its carbon calculation standing, and the index
says the calculation is current.**

`carbon_calculations` has exactly one currency mechanism: `superseded_by`, with
`create index on carbon_calculations (project_id, bucket) where superseded_by is
null`. Supersession is written by recalculation — a corrected weight, a re-imported
factor set.

Its inputs do not work that way. `project_assets` and `asset_movements` both carry
`deleted_at`, and Phase 8's roll-up excludes tombstoned rows on both sides
(`massBalance.ts` filters `deleted_at is null` in both queries) precisely because
§7 of the assets packet says a deleted line stops being counted while
`record_revisions` keeps what it was. **Delete a movement and its
`carbon_calculations` row is untouched, `superseded_by` is still null, and the
project's emissions total still contains it** — so the mass balance and the carbon
roll-up, rendered side by side in the same §28 section, disagree about whether the
material exists.

There is no schema fix; the fix is that **tombstoning is a recalculation trigger,
not merely an edit**. Stated as a rule the phase can be held to: any write that
changes what `massBalance.ts` would return must supersede the calculations derived
from it, and the writes that qualify are correcting a weight, tombstoning a line
or movement, and recording a continuation. The reason this is a §0 finding rather
than an implementation note is that it is invisible in testing — the calculation is
created, the movement is deleted, and every query still returns a plausible number.

**7. `RETAINED` displaces nothing while `RELOCATED` displaces, and both count as
retained-in-use.**

From `0033`'s seeded semantics, which Phase 9's `AVOIDED` bucket reads directly:

| code | tier | retained_in_use | diverted | displaces_replacement | ghg_treatment_key |
|---|---|---|---|---|---|
| `RETAINED` | 1 | ✔ | ✔ | — | — |
| `RELOCATED` | 1 | ✔ | ✔ | ✔ | — |

The consequence on screen: a project where the client kept everything reports
**100% retained-in-use and zero avoided emissions**, side by side, in the same
section. That reads as a bug and will be reported as one.

It is not a bug and the flag must not be flipped. `RETAINED` means the client kept
material in situ — the status quo, where no replacement purchase was in prospect
and therefore none was avoided. `RELOCATED` means it was moved to another site and
used there *instead of* something being bought for that site, which is a
counterfactual purchase and a defensible claim. Flipping `RETAINED` to
`displaces_replacement = true` would attach an avoided-emissions claim to every
piece of furniture nobody touched, which is the single largest inflation available
anywhere in this schema.

What the phase owes is therefore **a sentence, not a migration**: where
retained-in-use mass exists with no avoided claim behind it, §28.3's generated gap
text says so in the same plain language as the others — *"8.2 t was retained in
use by the client; no replacement was displaced, so no avoided-emissions claim is
made for it."* Recorded here so that the next person to notice the asymmetry finds
the reasoning rather than the flag.

**8. `ghg_treatment_key` is doing two jobs, and only one of them is a gap.**

§27.3 is emphatic: *"Where no suitable factor exists, nothing is produced and the
gap is disclosed — an absent factor is not a zero."* §28.3 gives the shape of the
disclosure: *"No waste-treatment factor exists for plasterboard in the 2027 factor
set — 1.2 t excluded from treatment emissions."*

But `ghg_treatment_key` is null on `RETAINED` and `RELOCATED`, and that null means
something completely different from a missing factor: **nothing was treated as
waste**, so no treatment emission exists to compute and no gap exists to disclose.
Read naively, every retained chair becomes a disclosed data gap, and the report
fills with warnings about material that was handled perfectly.

The rule the gap generator needs, stated once so it is not re-derived per call
site: a null `ghg_treatment_key` is **out of scope for treatment emissions and
generates no gap**; a non-null key with no matching factor in the selected set is
**in scope, unquantified, and disclosed by material and mass**. Two different
silences, and only the second one is a hole.

**9. Three entitlement keys and one limit do not exist, and one of them is checked
against a different company from the other two.**

`sustainability`, `carbon_engine` and `custom_factors` are absent from
`FEATURE_KEYS`, and `factor_sets` from `LIMIT_KEYS` (`asset_tracking` landed in
`0033`; nothing since).

The packaging rule settled on 2026-09-01 — *capture is free, the record is the
project owner's entitlement* — governs `sustainability` and `carbon_engine`
unchanged, because both are read over a project and the project owner is who
publishes the figure. **`custom_factors` and `factor_sets` are not project-scoped
at all.** A factor set is company reference data, imported once and used across
every project that company owns, so it is checked against the **importing
company's own plan** and against nothing else. That is a genuinely different noun
from the 2026-09-01 rule rather than the same rule again, which is why it is
written down instead of assumed: a subcontractor importing its own factors while
working on somebody else's project would otherwise consume the project owner's
allowance for data the project owner cannot see.

**10. There is no write capability for the one table in this phase anybody
writes by hand.**

§37's vocabulary shipped with `0026` and holds exactly three sustainability keys:
`sustainability.read`, `sustainability.factors.manage` and
`sustainability.settings.manage`. All three are Ama's. **None of them covers Ben
or Sam recording a project activity**, which is the only routine, field-captured,
non-admin write the phase adds.

The two ways of avoiding a new key are both worse than adding one. Gating the
write on `sustainability.read` fills one column of the §4 matrix and leaves the
rest empty, which this template calls a hole in as many words. Reusing
`asset.write` — the nearest neighbour, and already in the Supervisor bundle —
would mean anyone who can record a chair can also attribute a journey to a
subcontractor's van, which is `provider_company_id`, which is an assertion about
another business (§4).

So the phase adds **one** capability key, `sustainability.write`, in the migration
that creates `project_activities`, and places it in the Project Manager and
Supervisor bundles beside `asset.write` and `diary.write` — the two keys it most
resembles in who holds them and what they record. It is worth a finding rather
than a line of implementation because a capability added late gets added to
whichever bundle the failing test names, and the bundles are what `§44`'s
one-test-per-rule authorization suite is asserting against.

---

## 1. Persona / job

**Ama, sustainability lead at the contractor.** Desktop, office connectivity, once
or twice a week. She imports the year's factor set when the publisher releases it,
maintains the product carbon factor library, sets the company's assumptions once
(displacement basis, generic factors, data-quality weights, the report
disclaimer), and answers the question a client's ESG team asks in November about a
project that finished in March. **She is the only persona who ever sees a factor
set**, and the only one who can make an avoided-emissions claim defensible or
indefensible for every project at once.

**Ben, project manager.** Desktop, all day, the §28 project section open beside
the commercial one. He does not know what a factor set is and must never need to.
He records that a van did 240 km collecting from site, reads the two headline
figures, and — the job that actually matters — reads the named gaps so he knows
what to chase before the report goes out. **His failure mode is a number he cannot
explain to a client**, which is why every figure he sees clicks through to the
records behind it (§38.1).

**Sam, supervisor.** Phone or tablet browser on site, poor connectivity. Records
activity as it happens — a fuel fill, a load out — and never sees carbon at all.
Sam is in this packet only because `project_activities` is the one Phase 9 table
that is field-captured, which is what puts it under the Phase 7 sync contract
while nothing else here goes near it.

**Priya, the client's ESG analyst.** Reads a report a year after the work, never
logs in, and is the reason §41.3 exists. She is not a user of this phase and is
its most important reader: every decision below about supersession, snapshots and
disclosure is made on her behalf.

Nobody in this list wants a carbon figure. They want **a figure they can defend**,
which is a different product and the one §41 describes.

---

## 2. Resource responsibility

| Resource | Creator | Owner | Reader | Reviewer | Publisher | Corrector | Exporter | Retention owner |
|---|---|---|---|---|---|---|---|---|
| `emission_factor_sets` | Ama (import) or platform | importing company; null = platform | company members with `sustainability.read` | **nobody** | Ama (`active`) | Ama, by re-import as a new version — never in place | company export | company; platform rows outlive any company |
| `emission_factors` | the importer, in bulk | the set | resolver + anyone reading a citation | nobody | with the set | **nobody** — a factor row is never edited | with the set | with the set |
| `product_carbon_factors` | Ama | company; null = platform library | resolver, and the report that cites one | nobody | Ama (`active`) | Ama | company export | company |
| `project_activities` | Ben, Sam, or a subcontractor on its own work | project-owning company | project readers | nobody | n/a | creator or `sustainability.write`; tombstone, never a silent edit of a calculated row | project export | project retention |
| `carbon_calculations` | **the engine, never a person** | project-owning company | anyone who can read the figure | nobody | n/a | **nobody corrects a calculation — you correct its input and it supersedes** | referenced by report | project retention |
| `avoided_emissions_claims` | the engine, from a movement + a product factor | project-owning company | project readers; the client, in a report | nobody | frozen into a §29.4 snapshot | via supersession of its calculation | with the report | outlives the project while a report cites it |
| `sustainability_settings` | company creation, from shared defaults | company | `sustainability.read` | nobody | n/a | `sustainability.settings.manage` | company export | company |

Three of these say **nobody**, and each is load-bearing.

**Nobody reviews a factor set.** There is no approval state, and adding one would
be theatre: the reviewer would be the same person who imported it, and the thing
being reviewed is a published government workbook. What replaces review is the
importer's **dry-run diff** (§26.2) — you see what will change before it changes,
which is a better guarantee than a second click by the same hand.

**Nobody edits a factor row.** Not a permission gap — a design commitment.
§41.3's *"new factor sets never change old reports"* is only true if a factor is
immutable once cited, and the cheapest way to guarantee that is to have no code
path that updates one. A publisher's correction is a **new set at a new version**,
which is what the publisher itself does.

**Nobody corrects a calculation.** It is the assets packet's *"nobody corrects the
roll-up; you correct its inputs"* one layer up, and it is why `carbon_calculations`
has `superseded_by` instead of `updated_at`. A calculation is a record of what the
engine produced from stated inputs at a stated time. Editing it produces a row
that claims to be a derivation and is not one.

---

## 3. State machine

Most of this domain has no workflow, and saying so precisely is more useful than
inventing one.

### `emission_factor_sets` — two booleans, not a lifecycle

`active` and the `valid_from`/`valid_to` window. There is no
`DRAFT → PUBLISHED → RETIRED`, because a factor set is not authored here; it is
transcribed from a publisher who already did the publishing.

| From | To | Actor | Note |
|---|---|---|---|
| — | imported, `active = true` | `sustainability.factors.manage` | atomic with its factor rows, or not at all |
| `active` | `active = false` | same | **stops future selection; changes no existing calculation** |
| `active = false` | `active` | same | reversible, because deactivating is an operational act, not a judgement |

**Deactivation is deliberately not deletion and deliberately not retrospective.**
A set that has been cited by a calculation can never be removed —
`carbon_calculations` denormalises `factor_set_name`, `factor_set_version`,
`factor_reporting_year` and `factor_kg_co2e_per_unit` for exactly this reason, so
the citation survives even a hard delete, and the FK is a plain `references`
without `on delete cascade` so a delete is refused rather than silently cascading
through a year of reports.

### `carbon_calculations` — an append-only ledger with supersession

The only transition is `current → superseded`, and it is written by the engine, in
the same transaction as the row that replaces it.

```
  (no row)
     │  calculate
     ▼
  current  ──── recalculate (weight corrected · factor set re-imported ·
     │           movement tombstoned · continuation recorded) ────┐
     │                                                            │
     ▼                                                            ▼
  superseded_by = <new row>                                    current
```

**A superseded row is never deleted and never hidden from a citation.** It is
excluded from every sum by the partial index and included in every trace, which
is the distinction §41.2 draws between what a figure *is* and what it *was*.

**There is no `RECALCULATING` state and no queue.** Recalculation is synchronous
with the write that triggers it, inside the same transaction, because a project
whose carbon is briefly stale is a project whose two headline figures disagree
with the mass balance rendered beside them — and the window in which that is true
is a window in which somebody screenshots it.

### `avoided_emissions_claims` — no state at all

A claim exists or it does not. `UNKNOWN` displacement produces **no row**, which
is §27.4's rule expressed as an absence rather than a nullable flag, and is why
the data-quality gap for unknown displacement must be computed from *movements
lacking claims* rather than from claim rows. A claim is superseded by superseding
its calculation; `on delete cascade` from `carbon_calculations` is correct here
and is the only cascade in the domain, because a claim without its calculation is
not a record of anything.

### Concurrency

**One rule, and it is the assets packet's rule with a different table.** Two
actors correcting two weights on the same project at the same moment must not
produce two recalculations that each supersede the other's rows, leaving a project
with two current sets of calculations for the same bucket.

The lock is taken on the **project**, not the calculation:
`select id from projects where id = $1 for update` at the top of every
recalculation transaction. Row-lock-then-recalculate rather than check-then-act,
which is the pattern `money-boundary.md` §3 established and the assets packet
reused for the movement chain. It serialises a rare and cheap operation, and the
alternative — locking each calculation row — cannot work, because the set of rows
to supersede is not known until after the recalculation has run.

---

## 4. Permission + scope matrix

Four independent checks per operation. Three of the four capabilities this phase
needs already exist — `sustainability.read`, `sustainability.factors.manage` and
`sustainability.settings.manage` shipped with `0026`. **`sustainability.write` is
the exception and is added here** (finding 10); every other row below maps a route
onto a key that already has holders.

| Operation | Feature entitlement | Capability | Company edge | Resource scope |
|---|---|---|---|---|
| Import a factor set | `custom_factors` **on the importing company** | `sustainability.factors.manage` | own company only | n/a — company reference data |
| Read factor sets / factors | `sustainability` on own company | `sustainability.read` | own company + platform rows | n/a |
| Deactivate a set | `custom_factors` | `sustainability.factors.manage` | own company; **platform rows are immutable** | n/a |
| Create/edit a product carbon factor | `custom_factors` | `sustainability.factors.manage` | own company | n/a |
| Record a project activity | `sustainability` on the **project owner** | `sustainability.write` | assigned to the project | the project; a provider may record its **own** activity only |
| Read project carbon | `sustainability` on the **project owner** | `sustainability.read` | assigned to the project | **the project, for a provider as well as the owner** |
| Read the mass balance | `asset_tracking` on the project owner | `project.read` (mass-only) | assigned | unchanged from Phase 8 |
| Read the completeness score | `sustainability` | `sustainability.read` | assigned | the project |
| Read/write settings | `sustainability` | `sustainability.settings.manage` | own company | n/a |
| Organisation dashboard (§38.1) | `sustainability` | `sustainability.read` | own company | **only projects the company owns or is assigned to** |

Four rows deserve their reasoning.

**Factor sets are checked against the importer, not a project owner** — finding 9.
The gate is `custom_factors` on the company doing the importing, because the
artifact belongs to that company and is used across all of its projects. Nothing
about it is project-scoped, so there is no project owner to charge.

**Reading project carbon is project-scoped for a provider**, exactly as the mass
balance is, and for the reason `massBalance.ts` gives at length: *"a total is not
a row."* A subcontractor reading the project's emissions learns a mass times a
factor. It learns no counterparty identity, no rate, no margin and no other
provider's register. What it must **not** get is the organisation dashboard, which
aggregates across projects and would leak the shape of a portfolio it is not part
of — hence the explicit resource-scope column on that row.

**Recording an activity is `sustainability.write`, and a provider may record only
its own.** `project_activities.provider_company_id` exists for subcontractor
transport, and the write rule is the one `0033`'s `linked_company_id` comment
states: a row naming another business is an assertion that business cannot see or
contest. A provider sets `provider_company_id` to itself or leaves it null; it
cannot attribute a journey to a third party.

**Platform-owned rows are immutable to every customer**, which is the
`destination_types` rule from `0033` transferred without change — system rows are
immutable so the seeded semantics are always there to compare a company's own
against.

**The hole this matrix closes.** `sustainability.read` is **not** in the Supervisor
bundle, and Phase 8 already handled the consequence by giving `project.read` the
mass-only view. Phase 9 must not undo that: the §28 project section renders masses
for a Supervisor and omits — rather than nulls — the carbon headlines, the
completeness score and the gaps. An omitted key cannot be rendered as "0.00 tCO₂e".

---

## 5. Domain events

| Event | Transactional payload | Idempotency key | Consumers | Replay |
|---|---|---|---|---|
| `sustainability.factor_set_imported` | set id, name, version, reporting year, row count, **row counts by category**, importing user | set id | Action Centre; audit | safe — reports a completed import |
| `sustainability.factor_set_deactivated` | set id, name, version, count of projects with live calculations citing it | set id + `deactivated_at` | Action Centre (warning); audit | safe |
| `sustainability.calculations_superseded` | project id, trigger (`WEIGHT_CORRECTED` · `FACTOR_SET_REIMPORTED` · `MOVEMENT_TOMBSTONED` · `CONTINUATION_RECORDED`), superseded count, new count, **delta in kgCO₂e per bucket** | project id + trigger + the triggering row's id | Action Centre; audit | safe — the effect is already committed |
| `sustainability.claim_blocked` | project id, movement id, asset type, quantity, reason (`NO_PRODUCT_FACTOR` · `DISPLACEMENT_UNKNOWN` · `GENERIC_NOT_ALLOWED`) | movement id + reason | Action Centre — **this is a task, not a notice** | safe |

**`sustainability.claim_blocked` is the one that earns its place.** Every other
event here reports something that happened; this one reports something that
*didn't* — an avoided-emissions claim that could not be made, with the reason and
the quantity. §41.1's *"no factor, no number — say so instead"* is a rule about the
report, and a rule about the report alone means the first time anyone learns the
claim is missing is when the report is generated, which is after the client
meeting is booked. Routing it to the Action Centre makes the gap actionable while
there is still time to add the factor.

**`calculations_superseded` carries the per-bucket delta deliberately.** An audit
row saying "17 calculations superseded" is unreadable. One saying "project
emissions +0.12 tCO₂e, avoided −4.30 tCO₂e, trigger `WEIGHT_CORRECTED`" is the
sentence somebody needs a year later when a client asks why the number moved, and
it is the only place that answer is recorded — the superseded rows say what the
figures were, but only the event says what changed them and by how much.

**No event fires per calculation.** A re-imported factor set can supersede
thousands of rows across dozens of projects; one event per project per trigger is
the granularity anybody can act on, and the outbox is the same one `0012`
established.

---

## 6. Notification matrix

| Trigger | Recipient | Channel | Urgency | Digest / quiet hours | Escalation | Action Centre item |
|---|---|---|---|---|---|---|
| Factor set imported | importing user only | in-app | `LOW` | digest-eligible | none | yes, informational |
| Factor set deactivated **while cited by live calculations** | `sustainability.factors.manage` holders | in-app + email | `NORMAL` | digest-eligible | none | yes — names the projects |
| Claim blocked (`NO_PRODUCT_FACTOR`) | `sustainability.factors.manage` holders | in-app | `NORMAL` | **digested** — one item per project per day, never one per movement | none | yes, actionable: *add a factor for this asset type* |
| Claim blocked (`DISPLACEMENT_UNKNOWN`) | project manager | in-app | `LOW` | digested | none | yes — resolved by stating an assumption |
| Completeness below `data_quality_warn_below` at report time | project manager | in-app | `NORMAL` | immediate — it gates a report | none | yes |
| Calculations superseded | **nobody** | — | — | — | — | audit only |

**Supersession notifies nobody, and that is the deliberate half of this table.**
It is the most frequent event in the domain and the least actionable: it fires
because somebody corrected a weight, which is a thing they did on purpose and
already know about. Notifying would train every recipient to ignore the channel,
which is how the genuinely actionable `claim_blocked` item gets missed.

**`NO_PRODUCT_FACTOR` is digested per project per day, not per movement**, because
a single clearance of 400 chairs with no factor would otherwise generate 400
identical items. The digest names the asset type and the total quantity, which is
what the fix needs: one factor resolves all of them.

**Nothing here escalates and nothing is urgent.** No carbon figure is time-critical
— the report is, and that has its own gate. An escalation ladder on a factor gap
would be the second, harder compliance ladder that `0033` refused to build for
destination licences, for the same reason: §33 owns that mechanism and this phase
should not pre-empt it.

---

## 7. Data classification + retention

| Record | Class | Default visibility | Lifecycle | Legal hold | Export | Deletion |
|---|---|---|---|---|---|---|
| `emission_factor_sets` / `emission_factors` | **reference** — published third-party data, no personal or commercial content | company members; platform rows global | kept while any calculation cites it; **never** auto-purged | n/a | yes — the company's own imports, as rows | refused while cited; deactivation is the operation |
| `product_carbon_factors` | reference, with a commercial edge (`manufacturer`, `product_model`) | company | same | n/a | yes | same |
| `project_activities` | **commercial** — a van's movements are a subcontractor's operations | project members | project retention | inherits project hold | yes | tombstone; `record_revisions` keeps what it was |
| `carbon_calculations` | **derived** | follows the figure it produces | **outlives its inputs while a report cites it** | inherits | yes, with citations | never hard-deleted while cited |
| `avoided_emissions_claims` | derived, and **client-facing** | in a report, to the client | with its calculation | inherits | yes | cascade from calculation only |
| `sustainability_settings` | company configuration | company | company lifetime | n/a | yes | with the company |

**Nothing in this domain is personal data, and that is worth stating rather than
assuming.** The only user references are `imported_by_user_id`,
`created_by_user_id`, `calculated_by_user_id` and `updated_by_user_id` — all
nullable after finding 3, all `on delete set null`, all anonymised by closure. No
third-party contact details live here at all, which is the one way this domain is
simpler than `destination_organisations`.

**The retention rule that matters is the inversion.** Everywhere else in CrewQuo,
a derived record dies with its inputs. Here a `carbon_calculations` row **outlives
the movement it was derived from**, because §41.3 promises Priya that a report
generated in March still reconstructs in November, and because §29.4's snapshot
reads calculations rather than recomputing them. So: a tombstoned movement stops
counting toward the *current* figure (finding 6) and its superseded calculation is
**kept**, not deleted, because a report that cited it is still true about what was
known when it was issued.

**Export references factors the way the 2026-09-01 decision made it reference
files.** A calculation exports with its denormalised citation — set name, version,
reporting year, factor value, unit — rather than with a copy of the whole factor
set. The denormalised columns exist for reproducibility and they are exactly what
an auditor needs, so the export is complete without shipping a publisher's
workbook inside a customer's bundle, which would also be the redistribution §45's
licensing gate is about.

---

## 8. Offline / conflict policy

**One table in this phase is field-captured, and the rest never leave a desk.**

`project_activities` joins the Phase 7 sync contract (`0029`): a client-generated
id for deduplication, `revision` for expected-version checks, `deleted_at` for
tombstones, and the capture/upload timestamp distinction Sam's connectivity
requires. It is captured on site, one-handed, on a bad connection — a fuel fill or
a load-out recorded as it happens — which is the exact profile the contract was
designed against. Following `project_assets`, it carries `revision`, `deleted_at`
and a client id column, none of which the canonical §27.3 DDL has.

**Everything else is deliberately outside the contract**, and refusing it is the
answer rather than an omission:

- **Factor sets and product factors** are imported from a spreadsheet by one
  person at a desk. An offline import queue would be a merge conflict over a
  thousand-row file, resolved by somebody who cannot see either version.
- **`carbon_calculations` and `avoided_emissions_claims` are server-derived and
  have no client writer at all.** There is nothing to sync: a device that
  recalculated locally would produce a figure with no server-side trace, which
  §41.2 forbids more directly than any offline rule.
- **Settings** are one row per company edited rarely; last-write-wins with an
  expected version, and the refusal is visible on screen.

**What Sam sees when a change is refused** is the Phase 7 shape unchanged: the
activity stays in the local queue, marked as conflicted, showing what is on the
server beside what was captured, and the only two buttons are *keep mine* and
*keep theirs* — never a silent merge. An activity is a small enough record that
field-merging two versions of it produces a journey nobody made.

---

## 9. Failure matrix

| Failure | Retryable? | Partial success | Operator repair | User sees |
|---|---|---|---|---|
| Import: malformed CSV/XLSX | terminal | **none — the whole import is one transaction** | fix and re-upload | row and column of the first failure, with the value |
| Import: unit not recognised | terminal | none | map the column or correct the file | the unmapped unit, and the list of accepted ones |
| Import: duplicate set (name+version) | terminal | none | new version, or deactivate the old | *"this set already exists at v1.1"* — never a silent second copy (finding 2) |
| Import: a row's factor is negative | terminal | none | correct the source | the row; **zero is a legitimate factor and is accepted**, negative is not |
| Resolve: no factor for an activity | **not a failure** | n/a | add a factor | the activity, unquantified, and a named gap |
| Resolve: no product factor | **not a failure** | n/a | add one, or allow generic | `claim_blocked`, and no avoided figure |
| Resolve: two factor sets match the window | terminal | none | fix the validity windows | refuses to guess; names both sets |
| Recalculation deadlock | retryable | none — one transaction | none | transparent retry |
| Recalculation mid-report-generation | serialised by the project lock | n/a | none | the report waits |

**Two rows carry the argument.**

*"No factor"* is **not a failure**, and putting it in the failure matrix as a
non-failure is the point. §41.1 makes an absent factor a legitimate, reportable
state of the world rather than an error condition — so it must not raise, must not
retry, must not dead-letter, and must not produce a zero. It produces an
unquantified activity, a named gap, and an Action Centre item. This is the single
most important behavioural rule in the phase and the one most likely to be
"fixed" by somebody adding a fallback factor.

*"Two sets match"* **refuses rather than guesses**, which is the same instinct
finding 2 applies to uniqueness. Overlapping validity windows are an operator
error with no correct resolution — picking the newer one silently would change
which factors a project uses based on a data-entry mistake nobody has noticed.
Naming both sets makes the mistake fixable in one step.

**Imports are all-or-nothing.** A partially imported factor set is worse than none:
the resolver finds some factors and reports gaps for the rest, so the operator
sees a plausible half-result instead of a failure, and the missing half is
disclosed to a client as a data gap that does not exist.

---

## 10. Security / threat model

**Tenant boundary.** Every factor query is filtered to
`company_id = $ctx or company_id is null`. The `is null` arm is the platform
library and is read-only to everyone — which makes the boundary a *read* widening
and never a write one, so the worst outcome of a bug in it is a customer seeing a
published government factor.

**Forged identifiers.** A `factor_set_id` or `product_factor_id` supplied on a
write is validated against the acting company before use, exactly as
`projectAccess` does for projects. The specific attack this closes: citing another
tenant's private `ORG_SPECIFIC` product factor in your own calculation, which
would leak that factor's *value* through your own report — a competitor's costed
embodied-carbon assumption, readable one number at a time.

**The importer is an upload surface, and it is the largest one in the product
after evidence.** It takes a spreadsheet from a user and turns it into thousands
of rows.

- Size and row caps before parsing, not after, and the `factor_sets` limit checked
  **before** a byte is parsed — the presign precedent from Phase 7.
- **XLSX is a zip**, so decompressed-size and entry-count caps apply, or a
  40 KB upload becomes a multi-gigabyte parse.
- **Formulas are never evaluated.** Cell values only. A spreadsheet parser that
  evaluates is a code-execution surface, and the values are what the publisher
  published anyway.
- CSV cells beginning `=`, `+`, `-` or `@` are stored as text and **prefixed on
  export**, because the export is opened in Excel by the auditor this data exists
  for. Storing a formula is harmless; handing one back is CSV injection.
- Text columns (`activity`, `material`, `notes`, `source_reference`) are rendered
  as text in every UI and in the report. A factor set is company-scoped, so this
  is self-XSS in most cases — but the platform library is global, and a
  compromised operator account importing a platform set would reach every tenant.

**Privileged access.** Platform-wide factor sets are creatable only by the
platform admin console (`0010`), the write is audited, and it is the one write in
this domain with cross-tenant reach. `access.md` §13.3 refused per-tenant support
impersonation; nothing here reopens that.

**No secrets.** This domain holds no credentials and calls no third party — the
importer reads a file the user supplies. There is no rotation surface, which is
worth recording as an answer rather than a gap.

**The abuse case that is not obvious.** Nothing here is rate-limited by cost
except the importer, and its cost is per-row rather than per-request: one upload
can be the most expensive authenticated operation in the product. It runs under
the same durable-job substrate as the rest (`0012`), with the row cap as the real
control.

---

## 11. Analytics contract

| Metric | Event | Definition |
|---|---|---|
| Activation | `sustainability.first_calculation` | the first `carbon_calculations` row for a company — the moment the phase does anything for anybody |
| Outcome | `sustainability.report_ready` | a project reaching completeness ≥ `data_quality_warn_below` with both headline figures non-null |
| Funnel | factor set imported → activity or movement recorded → calculation produced → gap count falling → report generated | the drop-off between the third and fourth steps is the product question this phase asks |
| Quality | **share of avoided mass on a non-generic product factor** | §28.3's fifth component, and the honest measure of whether claims are defensible |
| Quality | count of `claim_blocked` per project per week | rising means the factor library is not keeping up with the work |

**Excluded from every payload, deliberately:** `kg_co2e` values, factor values,
`manufacturer` and `product_model`, company or project names, and any
`avoided_emissions_claims` field. The exclusion is stronger than the usual
personal-data rule because these are **commercially sensitive third-party
numbers** — an org-specific embodied-carbon factor is a costed assumption, and
`assumptions` and `uncertainty` on a claim are free text a person wrote about a
client's project. Counts, rates and booleans only.

**The quality metric is chosen to be uncomfortable.** Share of avoided mass on a
non-generic factor is a number that starts low and stays low until the factor
library is genuinely populated, and it is the number an internal reviewer would
most like to replace with "avoided tonnes published". §41's whole posture is that
the defensibility of a figure matters more than its size, and the analytics
contract should not be the one place that stops being true.

---

## 12. Acceptance script

Continues Phase 8's fixture rather than inventing one — the same project, the same
42 chairs, so the tonnage the milestone already proved is the tonnage the factors
multiply. **This is the script `verify:e2e` implements.**

**Setup.** The Phase 8 fixture: 42 operator chairs removed, 30 donated, 12
recycled, 933.0 kg handled · 693.0 kg allocated · 240.0 kg pending. Ama holds
`sustainability.*`; Ben holds `sustainability.read` and `sustainability.write`;
Sam holds `project.read` only.

1. **Empty.** Before any factor set exists, Ben opens the project's Sustainability
   section. The mass balance renders exactly as it did in Phase 8. Both carbon
   headlines are **absent, not zero**, and the section says why: no factor set is
   selected. *Asserts §41.1 at the top of the phase, where it is easiest to break.*
2. **Import.** Ama uploads a 2027 factor set. The dry-run diff reports rows to be
   added by category and changes nothing. She confirms; the set imports atomically
   and `sustainability.factor_set_imported` carries the row counts.
3. **Duplicate refused.** She uploads the identical file again. It is refused by
   name and version, with no second copy and no partial rows. *Finding 2.*
4. **Waste treatment.** 12 chairs recycled × their mass × the `RECYCLING`
   treatment factor produces `WASTE_TREATMENT` rows citing set, version, year and
   factor value. 30 donated chairs produce **no treatment emission** and **no
   gap** — `ghg_treatment_key = 'REUSE'` with a reuse factor present. *Finding 8's
   first silence.*
5. **A disclosed gap.** A plasterboard line whose treatment key has no factor in
   the 2027 set produces no number and a named gap quoting the material and the
   mass. *Finding 8's second silence, and §41.1's report half.*
6. **Displacement unknown by default.** With settings untouched, the 30 donated
   chairs produce **no avoided claim** and a `claim_blocked`
   (`DISPLACEMENT_UNKNOWN`) item. The avoided headline is absent. *This is finding
   1's regression test, and it fails loudly against any future migration that
   restores `default 100`.*
7. **A claim, stated.** Ama sets the basis to `USER_DEFINED` at 80% and adds an
   `EPD_VERIFIED` product factor for the chair. The 30 chairs produce an `AVOIDED`
   calculation and a claim recording baseline scenario, alternative scenario,
   displacement basis and pct, system boundary from the factor's
   `lifecycle_boundary`, enabling emissions, assumptions and methodology.
8. **Retained-in-use with no claim.** A relocated line and a retained line are
   added. The relocated mass claims; the retained mass does not, and the gap text
   says so in words. *Finding 7.*
9. **The firewall.** No API response anywhere in the run returns a total mixing
   `AVOIDED` with any other bucket, and no persisted sum crosses buckets. Asserted
   over **every** response body in the suite, not a chosen one. *Locked decision
   #17, §44's firewall test.*
10. **Denied.** Sam opens the same section: masses render, carbon headlines and
    the completeness score are **absent keys**, not nulls. Ben attempts a factor
    import and is refused on capability. A second company forges this project's id
    and gets the same 404 an unknown id gets.
11. **Correction, and the supersession trail.** Ben corrects a chair's weight. The
    affected calculations are superseded in one transaction, new rows replace them,
    `calculations_superseded` carries the per-bucket delta, and the superseded rows
    remain readable and remain excluded from every sum.
12. **Tombstone.** Ben deletes a movement. Its calculations are superseded — the
    project's emissions figure falls, and the carbon roll-up and the mass balance
    agree afterwards. *Finding 6, which no other step in this script would catch.*
13. **Reproducibility.** A 2028 factor set is imported and activated. The 2027
    project's existing calculations are **unchanged**, still citing 2027, still
    reproducing the same figures. *§41.3, and the one assertion Priya depends on.*
14. **Offline.** Sam records a fuel activity with a client id on a dropped
    connection, retries twice with the same id, and exactly one row exists.
    An expected-version mismatch on an edited activity produces a conflict showing
    both versions, not a merge.
15. **Completeness, with five components.** The score renders with all five
    components broken out, each with its weight and measured value, weights read
    from `sustainability_settings` rather than constants. Every Phase 8 gap
    sentence still renders. *Discharges the Phase 8 §13.5 debt.*

---

## 13. Decisions — one open, five recorded

### 1. Scope 2 electricity: location-based, market-based, or both? → **OPEN — built as recommended: location-based only, labelled**

§27.3 says *"`kWh × grid factor` for the reporting year and region (Scope 2, with
the WTT/T&D component reported where the publisher separates it)"* — one factor,
one figure. §27.5 then claims the results are *"structured so results can be
reported consistently with the GHG Protocol."*

The GHG Protocol's Scope 2 Guidance requires **dual reporting** where a company
has contractual instruments — a location-based figure using the grid average, and
a market-based figure using the supplier's or instrument's rate. A contractor on a
certified-renewable tariff has a market-based electricity figure near zero and a
location-based one that is not, and CrewQuo currently computes only the second
while §27.5 implies alignment.

**Recommended: location-based only, labelled as such wherever electricity
emissions appear, and disclosed in the report's methodology section.** Market-based
reporting requires supplier contracts, REGO/GO certificates or a supplier-specific
emission rate — documents CrewQuo does not hold, cannot verify, and would be
taking a customer's word for on a figure that *reduces* their reported emissions.
§41.1 and §41.2 point the same way: no instrument, no market-based number, and say
which basis was used rather than leaving a reader to assume the favourable one.

*Rejected — both, with the customer entering a supplier rate.* It is what the
Protocol asks of a full corporate inventory, and it is a bigger phase than this
one: it needs an instruments record, a coverage calculation (partial instrument
coverage is the normal case), and a residual-mix factor for the uncovered
remainder, which is a dataset with its own licensing question. Built badly it
produces a market-based figure that is simply lower, which is precisely the number
nobody should be handed on trust.

*Rejected — market-based only, from a company-level setting.* One number, no
labelling problem, and it inverts §41.1: it is the arm where an unverified claim
reduces a reported figure.

**It does not block the build.** The column that would eventually carry a basis is
`carbon_calculations.method`, whose check constraint can take a new value, and the
labelling is a string. Whichever way this is answered, the location-based path is
written first, because it is the arm that exists under both answers.

### 2. Does `default_displacement_pct` default to 100? → **RECORDED — no; the DDL predates the decision that answers it**

Finding 1. This is **not** an open question and must not be sent as one: the owner
answered it on 2026-08-18 (*"defaults to `UNKNOWN`, never 100%"*), and §27.4
states the consequence. §39's DDL was written before that pass and was not
revisited afterwards.

Built as recommended — `default_displacement_basis` defaulting to `UNKNOWN`,
nullable `default_displacement_pct`, and the check constraint pairing them —
recorded here with its rejected alternatives because the way a reversed default
returns is one plausible column at a time, added by somebody who never knew it had
been removed on purpose. `money-boundary.md` learned that the expensive way, and
step 6 of the acceptance script is the regression test.

### 3. Whose plan is checked for `custom_factors` and `factor_sets`? → **RECORDED — the importing company's own**

Finding 9. The 2026-09-01 rule — *capture is free, the record is the project
owner's entitlement* — governs `sustainability` and `carbon_engine` unchanged.
It does **not** transfer to factor imports, because a factor set is company
reference data used across every project that company owns, and there is no
project to find an owner of. Recorded rather than assumed precisely because the
last three phases have all transferred that rule by analogy, and this is the first
noun it does not fit.

### 4. Does §39 arrive in this phase, and do the behaviours Phase 8 parameterised now bind? → **RECORDED — yes, and first**

Phase 8 deferred three things to §39 and built each as a parameter rather than a
table: display units (`formatMassKg(kg, unit)` takes a `MassUnit` and defaults to
`AUTO`), the data-quality weights, and `capture_gps_on_evidence`. Its §13.4 said
*"when it lands, the caller passes a value instead of taking the default and this
function does not change."*

This is the phase it lands in, so `sustainability_settings` is **step 9.1, before
the factor tables**, not a settings screen bolted on at the end. Three consumers
need it before they can be correct: the displacement basis (decision 2), the
data-quality weights (finding 5) and the display units. Building the engine first
and the settings last would mean writing the engine against constants and then
changing every signature.

**`capture_gps_on_evidence` ships with the table, defaulted false, and Phase 9
builds nothing that reads it.** That closes the Phase 7 §13.7 open question the
way its own recommendation proposed — capture nothing, which is the default and
needs no decision — and leaves the column in the one place §39 says it belongs.
The camera that would honour it is Phase 13.

**`report_disclaimer text not null` also ships here**, with §29.3's default text,
because `not null` with no DDL default means every settings row insert must supply
one and Phase 10 would otherwise inherit a table it cannot insert into. Phase 9
does not render it.

### 5. Does Phase 9 publish the data-completeness percentage? → **RECORDED — yes; this is the phase that owes it**

Phase 8's §13.5 withheld the score and named the condition for publishing it: the
fifth component becoming computable. `avoided_emissions_claims` and
`product_carbon_factors` are what make it computable, so the debt falls due here.
It ships with its five components itemised rather than as a bare percentage
(finding 5), and `describeGaps` keeps working unchanged — the gaps were never
contingent on the score and each remains true on its own.

### 6. Is a factor dataset bundled into the seed? → **RECORDED — no; external gate, and the build does not wait**

§45's licensing gate is unchanged and unanswered: redistribution terms for the UK
Government GHG Conversion Factors (and any WRAP/Defra resource dataset) are not
confirmed. §26.2 already states the consequence — *"factor sets are imported, not
shipped… zero fabricated rows"* — and the importer plus org-owned factors is the
whole of what Phase 9 ships regardless.

The one thing this constrains: **`verify:e2e` and the demo seed need factor data,
and it cannot be a real published dataset.** Both use a small, obviously synthetic
fixture set named as such (`"CrewQuo Test Factors 2027"`, source organisation
`"CrewQuo — synthetic test data"`), which satisfies the suites without putting a
row in the product that could be mistaken for a published factor. A fixture that
looked real would be the fabricated row §26.2 forbids, wearing a test label.

---

## 14. Build order

Ten steps. The engine first for §27.1's stated reason, and the settings second
because three later steps read them.

- **9.0 — the pure engine.** `packages/shared/src/carbon-engine/`, §27.1's eight
  functions, with exhaustive tests **before anything renders a number** (§44):
  every branch of factor selection (year, region, validity window, overlap,
  missing), every unit conversion, every rounding boundary, the five-tier product
  factor resolver, and every avoided path including `UNKNOWN` displacement and the
  no-factor case. Every function returns the inputs it used; nothing returns a bare
  number. The bucket firewall is a **type**, so a sum crossing buckets does not
  compile. *Needs no answer from anybody.*
- **9.1 — `sustainability_settings` (§39).** Decision 4. Ships the displacement
  basis pair with its check constraint (decision 2), the data-quality weight
  defaults seeded from shared code, the display units Phase 8 parameterised,
  `capture_gps_on_evidence` defaulted false, and §29.3's disclaimer text.
- **9.2 — factor sets, factors and the importer (§26.1–§26.2).** With the two
  partial unique indexes finding 2 requires, the `custom_factors` feature and the
  `factor_sets` limit, column mapping, dry-run diff, atomic import, and the §10
  upload defences.
- **9.3 — product carbon factors and the preferred-source resolver (§26.3).**
  Uniqueness first (finding 2), then the five-tier walk, then
  `allow_generic_product_factors` from 9.1.
- **9.4 — `project_activities` (§27.3).** Nullable `created_by_user_id` with
  `on delete set null` (finding 3), no `vehicle_id` (finding 4), and the Phase 7
  sync columns (§8). **Adds the one new capability key**, `sustainability.write`,
  into the Project Manager and Supervisor bundles (finding 10).
- **9.5 — `carbon_calculations`, supersession and the recalculation trigger
  (§27.2).** The project lock (§3), the four triggers including tombstoning
  (finding 6), and the denormalised citation columns.
- **9.6 — `avoided_emissions_claims` (§27.4).** Enabling emissions deducted from
  activities linked to the same movement; `UNKNOWN` produces no row; the
  methodology warning travels with every avoided figure rather than living in an
  appendix.
- **9.7 — the completeness score, five components (§28.3).** Decision 5. Weights
  from 9.1; components itemised; Phase 8's gaps unchanged, plus the retained-in-use
  sentence (finding 7) and the two silences (finding 8).
- **9.8 — the project Sustainability section (§28).** Mass balance, two headlines
  never netted, completeness with named gaps, and the Supervisor's omitted keys.
- **9.9 — the organisation dashboard (§38.1).** Every figure click-through to its
  records; completeness attached to any figure below the threshold; scoped to
  projects the company owns or is assigned to (§4).
- **Milestone:** 3.84 tCO₂e emissions and 27.42 tCO₂e avoided, side by side, every
  number traceable to a factor and a version.
