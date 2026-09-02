# Operating-model packet — assets & materials

**Domain:** the Phase 8 record set — asset types, project asset lines and their
weight provenance, destination types, destination organisations, and the
movement ledger that says where the material actually went — together with the
mass roll-up (§28.1–§28.2) that is the first figure this product puts in front of
a client without a human having typed it.
**Phase:** 8 · **Status:** draft · **Last updated:** 2026-09-02
**Plan refs:** §25 (the whole domain), §28.1–§28.3 (the metrics that read it),
§36 (record revisions), §37 (capabilities — three asset keys already shipped),
§39 (the settings that govern display units and data-quality weights),
§41.1/§41.5/§41.6/§41.7/§41.8/§41.9 (six of the ten non-negotiables constrain
this one domain), §43 (`asset_tracking`), locked decisions **#18** (storage is
not an outcome) and **#20** (hierarchy semantics are data, not code).

---

## 0. Why this packet, and why now

§25 opens with the only sentence in the plan that describes a phase as
load-bearing for three others: *"The heart of the expansion. Everything in
§26–§29 is downstream of getting this record right."* The carbon engine
multiplies these masses by factors. The report renders those products. The client
sign-off attests to them. Every one of those phases inherits whatever this schema
decides, and none of them can correct it — a factor applied to a double-counted
tonne produces a double-counted tonne of CO₂e with a full audit trail behind it.

Three things make this a packet that has to exist before the migration.

**It is the first domain where a wrong record is not a wrong record but a wrong
claim.** Evidence filed under the wrong day is a filing error somebody notices. A
diversion rate computed over the wrong denominator is a number on a client's
sustainability report, and the whole of §41 exists because that failure is silent,
plausible and legally interesting. §41.9's *"never round mid-calculation"* is a
rule about arithmetic; the rules that actually bite here are §41.7 (storage is not
an outcome) and §41.8 (diverted is not reused), and both are enforced by the shape
of the movement table rather than by a validator somebody can forget to call.

**Four shipped things already point at tables this phase creates,** which means
the phase is not starting from a blank sheet and the shapes are not free:

- `capabilities.ts` ships `asset.write`, `asset.destination.set` and
  `asset.weight.verify`, already bundled — Supervisor gets the first two and
  deliberately **not** the third, with the reason recorded in the source.
- `documents.ts` ships `WASTE_TRANSFER_NOTE`, `WEIGHBRIDGE_TICKET`,
  `RECYCLING_CERTIFICATE` and `DONATION_RECEIPT` under a comment saying these four
  are *"load-bearing beyond this phase … Phase 8's asset rows point at these
  documents directly."*
- Migration `0030` omits `asset_id` and `asset_movement_id` from
  `project_evidence` and says why: *"Each of the five arrives with the migration
  that creates the table it points at, where it can carry a real foreign key and
  a real consumer on the same day."* Two of the five are this migration's job.
- `entitlements.ts` has a `FEATURE_KEYS` list §43 says needs `asset_tracking`
  added, and two Phase 7 comments settling — twice — whose entitlement is checked
  when a subcontractor works on somebody else's project.

**And 13.5 puts this record set on a phone.** *"Assets & waste — Assets Removed,
Waste/Reuse, destination assignment on site."* The argument that put the sync
contract in Phase 7 rather than Phase 13 — client ids and expected revisions are
cheap to design into an endpoint and expensive to retrofit into a shipped one —
applies to `project_assets` and `asset_movements` identically, and the canonical
DDL in §25.2 and §25.4 has neither column.

### What writing it found

Nine things. Two are contradictions inside the plan's own rules that would each
have been a migration *and* a published metric to undo; four are the canonical DDL
disagreeing with a decision made after it was written; three are gaps a careful
reader closes without asking anybody.

**1. §25.4 rule 1 and rule 3 cannot both be true.** This is the finding that
justifies the packet on its own.

> Rule 1: `sum(movements.quantity) <= project_assets.quantity`.
> Rule 3: *"when the material later leaves storage a **second** movement records
> the real outcome"*.

Take the milestone's own line — 42 chairs — and route 12 of them through a
warehouse. Movement 1: 12 to `STORAGE`. Movement 2, a month later: 12 to
`RECYCLING`. Movement 3: 30 to `DONATION`. `sum(quantity)` is 54 against a line of
42, and rule 1 refuses the movement rule 3 requires. Enforce rule 1 as written and
storage becomes a trap — material can enter it and never be recorded leaving.
Drop rule 1 and a clerk can donate 500 of 42 chairs.

The resolution is one nullable self-reference, `continues_movement_id`, and a
restatement of rule 1 over the **open** movements — those nothing continues:

```
sum(quantity) over movements with no continuation  <=  project_assets.quantity
```

Movement 2 continues movement 1, so movement 1 stops counting against the ceiling
and stops counting as pending; the sum over the open movements is 30 + 12 = 42.
The chain is preserved rather than overwritten, which is what makes it a ledger.
*"420 kg of stored furniture, final destination currently unknown"* — §28.3's own
example gap — is answerable while the material is in the warehouse, and *"left
site 4 March, recycled 2 April"* is answerable afterwards. It also protects Phase
9: §27.4 attaches avoided-emissions claims to `asset_movements` **by id**, and
without the chain a superseded storage leg and its real outcome are two unrelated
movements a claim can be attached to twice.

**A departure from a canonical DDL, so it is raised as §13.1 rather than quietly
taken** — and, like Phase 7's `READY`, built as recommended, because the phase
cannot ship a movement table that refuses the movement its own rule 3 describes.

**2. §28.2 defines pending mass per line, and it breaks on the split the
milestone requires.** *"pending mass = asset mass not yet allocated, plus mass
whose **latest movement** is `STORAGE`."* On the 42-chair line above, the latest
movement by sequence is whichever was recorded last; read literally, one storage
leg makes the whole line's mass pending and the 30 donated chairs vanish from the
reuse numerator. Mass is a property of movements, not of lines — rule 3 already
says exactly that for the numerator (*"metrics aggregate movements with
`is_final_outcome = true`, not asset lines"*), and §28.2 then defines the
denominator's complement over lines. Restated over movements, with the chain from
finding 1, it is exact and needs no special case:

```
allocated   = Σ mass of OPEN movements whose destination IS a final outcome
inStorage   = Σ mass of OPEN movements whose destination is NOT final
unallocated = (line quantity − Σ quantity of OPEN movements) × line unit weight
pending     = inStorage + unallocated
handled     = allocated + pending
```

**Unallocated mass is computed from quantity and never by subtracting masses**,
and the difference is not cosmetic. A movement may override its weight — the
weighbridge weighed the recycling load and the line holds an estimate — so
`line mass − Σ movement mass` can go negative and report a project as having
`−4.6 kg` awaiting a destination. Quantity cannot: the ceiling in finding 1
guarantees it is non-negative. The consequence is that handled mass may exceed
the line's own stated mass, which is correct — the parts were weighed better than
the whole, and §41.6 requires that distinction to survive into every total rather
than be reconciled away.

Continued movements contribute to nothing, which is the entire point of continuing
them. This is arithmetic, so it lives in `packages/shared` with a unit test per
branch, and it is step 0 of the build order for the reason the rate engine was:
everything downstream renders what it returns.

**3. `sum(movements.quantity) <= project_assets.quantity` is a check-then-act,**
and this repository has already paid for one. `money-boundary.md` §3 produced the
row-lock-then-count rule after the same shape appeared in rate pinning: two
requests read the same total, both find room, both insert. Here the losing outcome
is 54 chairs of destinations against a line of 42 — a mass balance that does not
balance, in the table the client report reads. The fix is the one already written:
`select … from project_assets where id = $1 for update` before counting, in the
same transaction as the insert. Reusing the rule rather than inventing one is the
whole value of having written it down. Phase 7 found two such races in its own new
code by looking for this shape deliberately; this phase looks for it in the same
three places — the ceiling, the `sequence` allocation, and `outcome_state`.

**4. A movement's `weight_kg` is *"derived from the asset unless overridden"*,
and a stored derivation goes stale the first time somebody corrects a weight.**
§25.3 *expects* weight corrections — every one writes a `record_revisions` row —
and a weighbridge ticket arriving a week after an estimate is the normal case, not
the exception. If `weight_kg` were copied at write time, a corrected line and its
movements would disagree, and the mass balance reads the movements.

So `weight_kg` stays nullable and **null means "derive"**: a movement with no
weight is `quantity × line unit weight`, computed at read time at full precision;
a movement with a weight is an overriding claim somebody made on purpose — the
weighbridge ticket, which is exactly the case where the movement knows better than
the line. One nullable column does what a boolean plus a value would do, and there
is no back-fill: correcting a line's weight moves every derived movement with it
and touches no overridden one. The canonical DDL already has `weight_kg` nullable;
what this adds is that **nothing writes it by default**, which is the opposite of
what *"derived from the asset"* invites an implementer to do.

**5. `weight_document_id` points at a document *version*, in a chain that hides
superseded rows by default.** §25.3 makes `VERIFIED` and `DOCUMENTED` require an
attached document; `documents.ts` makes a new version a new row with
`supersedes_id`, and the old row *stays and is hidden*. A weight citing v1 of a
weighbridge ticket therefore cites a row the document manager no longer shows.

Pinning the version is right, and the alternative is worse. A weight's provenance
is a claim about the document that was on the table when the weight was recorded;
re-pointing it at v2 would let a re-issued ticket retroactively change what a
weigher is recorded as having read — the same failure `supersedes_id` exists to
prevent, one table over. What the API owes instead is a **derived** disclosure,
computed by the join `documents.ts` already runs for `supersededById`, so a weight
whose document has since been superseded says so in the UI and in §28.3's gap
list, with neither row moving. Deleting the cited document is the one case that
must be refused rather than disclosed: a `DOCUMENTED` weight whose document is
gone is an undocumented weight wearing a badge.

**6. `created_by_user_id uuid not null references users(id)` contradicts the
closure promise,** exactly as it did in `0030`. The decision of 2026-08-20 makes
account closure anonymise the person and preserve the record; `not null` here
makes *"close Ekene's account"* either impossible or destructive of a hiring
company's asset register. Same fix, same reasoning, already written into
`project_evidence`: nullable, `on delete set null`, and the null **is** the
tombstoned identity rather than a missing value.

**7. `asset_movements.vehicle_id references vehicles(id)`, and `vehicles` is
Phase 11 (§31).** `0030` set the precedent and gave the reason — *"a column
nothing writes and nothing reads is indistinguishable, on inspection, from one
whose writer is broken."* `vehicle_id` is omitted and arrives with the migration
that creates `vehicles`. `distance_km` **stays**, because unlike the vehicle
reference it has a Phase 9 consumer that needs no fleet: §27.3 prices transport
from `tonne_km` and a freight factor, and a subcontractor's van is distance
without a `vehicles` row.

**8. `destination_types` has a shadowing model and no uniqueness to enforce it.**
`asset_types` ships two partial unique indexes — one for company rows, one for the
system catalog — and the sentence that makes them meaningful: *"a company row with
the same `code` shadows the system one."* `destination_types` has the same
nullable `company_id`, the same shadowing intent (decision #20 is entirely about a
company adjusting its own `counts_as` flags), and no index at all. Without one a
company can hold two `RECYCLING` rows with different `counts_as_diverted` flags,
and its diversion rate depends on a join order. It gets the same pair of indexes
and — per the §0 DDL convention it is the only table in §25 to skip —
`created_at`/`updated_at`.

**9. The serial-number index has no tombstone filter, and collides across
projects.** `unique (company_id, serial_number) where serial_number is not null
and tracking_mode = 'ITEM'`: every Phase 7 index learned to carry
`where deleted_at is null`, and without it a deleted asset line blocks its own
re-creation — which on a syncing device is a permanent failure with no visible
cause. That half is a straightforward fix.

The other half is a real question, and it is §13.2. The same server, relocated off
one project and recycled from another a year later, is one physical thing and two
`project_assets` rows in one company; company-wide uniqueness refuses the second
row. Loosening to `(company_id, project_id, serial_number)` permits the same
serial to be recycled twice and reported as two tonnes — the exact double-count
§41 exists to prevent, and the reason the recommendation is to **keep the
uniqueness and fail loudly**, naming the project the serial already lives on so
the user can go and record the movement where it belongs.

---

## 1. Persona / job

**Ekene, clearance supervisor** — subcontractor, Crew or Starter plan; a phone on
a stripped floor with no signal; **Supervisor** bundle. Strips a floor. At the end
of a run they need to say *"42 operator chairs, 8 desks, 3 pedestals, out of Floor
2"* in under a minute, with a photograph, and get on with the next floor. They
know a chair weighs "about 16 kilos" and they do not know what `weight_confidence`
means. **They hold `asset.write` and `asset.destination.set` and deliberately not
`asset.weight.verify`** — they can record that a chair weighs 16.5 kg, and they
cannot record that the figure is verified.

**Rafiat, sustainability lead** — the project-owning company, Pro plan; a laptop;
**Sustainability** bundle. Owns the number that leaves the building. Receives the
weighbridge ticket three days after the material did, corrects the estimate to the
measured figure, attaches the ticket, marks it `VERIFIED`, and reads §28.3's gap
list as a to-do list. **The only persona whose edits move a published figure,**
which is why `asset.weight.verify` is theirs and why every weight edit writes a
`record_revisions` row.

**Dolapo, project manager** — the project-owning company; a laptop; **Project
Manager** bundle. Runs the job. Does the bulk entry the supervisor's phone did not
— pastes sixty lines out of the client's asset schedule — assigns destinations
when the charity confirms collection, and is the person who discovers that twelve
chairs have been in a warehouse for five weeks with no final destination.

**Chidi, client-side facilities manager** — portal login. **Reads nothing in this
phase.** The asset register is internal until a Phase 10 report snapshot publishes
a figure from it; §7 makes that an answer rather than an omission.

**Tobi, platform operator.** Has no per-tenant read — `access.md` §13.3 refused it
— and diagnoses a mass balance that does not add up from `record_revisions`,
`audit_logs` and a correlation id. That is the sentence the refusal rests on, so
this phase has to keep it true.

---

## 2. Resource responsibility

| Resource | Creator | Owner | Reader | Reviewer | Publisher | Corrector | Exporter | Retention owner |
|---|---|---|---|---|---|---|---|---|
| `asset_types` (system) | **CrewQuo, seeded** | platform | everyone | — | — | **nobody** — a system row is immutable; a company edit creates a shadowing company row | — | platform |
| `asset_types` (company) | company admin (`sustainability.settings.manage`) | the company | the company | — | — | company admin | data export | the company |
| `project_assets` | `asset.write` on the project | **the recording company** (`company_id`), not the project owner | project participants (§4) | — | **nobody in Phase 8** | `asset.write`; `asset.weight.verify` for a confidence upgrade | project-owner data export | the project owner |
| a weight + its provenance | as above | as above | as above | Rafiat, informally — there is no approval state | — | `asset.weight.verify` for `VERIFIED`/`DOCUMENTED` | as above | as above |
| `destination_types` (system) | **CrewQuo, seeded** | platform | everyone | — | — | **nobody** | — | platform |
| `destination_types` (company) | company admin | the company | the company | — | — | company admin | data export | the company |
| `destination_organisations` | `asset.destination.set` | the company | the company | — | — | same | data export | the company |
| `asset_movements` | `asset.destination.set` | the company owning the asset line | project participants | — | — | same; every correction writes `record_revisions` | as above | the project owner |
| the mass roll-up | **nobody — it is computed** | — | `sustainability.read`, plus anyone who may read the project's assets | — | Phase 10 | **nobody; you correct its inputs** | Phase 10 report | — |

Three rows are worth reading twice.

**Nobody publishes an asset in Phase 8.** Evidence carries `client_visible` and a
first-publish timestamp because a photograph is disclosed one at a time. An asset
register is disclosed as a *report* — §29.4's snapshot, Phase 10 — and a per-row
disclosure flag added now would create a second, contradictory disclosure path
that the report would then have to decide whether to respect. The register is
internal; §7 says what that means for retention and export.

**Nobody corrects the roll-up.** It has no stored form in this phase. §41.3 keeps
historical reports reproducible by snapshotting them (§29.4), not by freezing the
live figure, so the live figure is always a function of current rows — which is
what makes *"the number moved because Rafiat attached the weighbridge ticket"* a
sentence with an answer in `record_revisions`.

**The recording company owns the line; the project owner owns the retention.**
This is `project_evidence`'s split, for the same reason: a subcontractor's asset
line is also the hiring company's proof of a diverted tonne. `0030`'s comment —
*"two facts, two columns, and collapsing them is how the meter starts disagreeing
with the audit trail"* — transfers unchanged.

---

## 3. State machine

Two of the four records have no workflow at all, and saying so is the answer
rather than an omission: `asset_types` and `destination_organisations` are
reference data with `active` as their only lifecycle, and `active = false` hides a
row from pickers without invalidating the rows that already point at it.

### `project_assets.outcome_state` — derived, never typed

§25.4 rule 2 is explicit that this is computed. The plan gives four states; with
finding 1's chain, each has an exact definition over **open** movements:

| State | Definition |
|---|---|
| `PENDING` | no open movements |
| `PARTIAL` | some quantity open, and open final-outcome quantity < line quantity |
| `IN_STORAGE` | every open movement is non-final, and together they account for the whole line |
| `FINAL` | open final-outcome movements account for the whole line |

`IN_STORAGE` is stated over *all* open movements rather than the plan's *"latest
movement is a non-final destination"* for finding 2's reason: on a partial split
the latest movement is a fact about recording order, not about where the material
is. A line 30 donated and 12 stored is `PARTIAL`, and it should be — there is
still something to do.

**It is stored, and a stored derivation needs one writer.** The alternative —
computing it on read — was considered and rejected: `create index on project_assets
(project_id, outcome_state)` is in the canonical DDL because the "what still needs
a destination" screen is the daily job, and that index cannot exist over an
expression that joins another table. So it is a column, recomputed inside the same
transaction as every movement insert, update, continuation and tombstone, by one
function that takes the locked asset id — never by a caller assembling it. A
recompute path that any caller may skip is a derived column that is wrong in
production, and the way to make it unskippable is to give it exactly one caller.

### `asset_movements` — a ledger with a chain, not a workflow

A movement has no status. It exists, it may be corrected, it may be continued, and
it may be tombstoned. What replaces a status machine is the chain:

```
   [1] 12 → STORAGE ────continues──── [2] 12 → RECYCLING     (open)
   [3] 30 → DONATION                                          (open)
```

- **Continuation is one-to-one, forward-only, and refuses a final source.**
  `continues_movement_id` may point only at a movement whose destination is
  `is_final_outcome = false`; continuing a `RECYCLING` movement is not a
  correction, it is a second claim on material that has already been reported, and
  it is refused with that sentence. A movement may be continued once — a partial
  release from storage is a *split*, which is finding 1's mechanism applied twice:
  continue the storage leg with a smaller quantity and record the remainder as a
  further leg — so the invariant is a unique index on `continues_movement_id`
  where it is not null and not tombstoned.
- **A continuation may not exceed what it continues.** 12 into storage cannot
  become 15 out of it. Same lock, same count.
- **Corrections are edits that write `record_revisions`** (§25.4 rule 4, §36),
  never silent overwrites. `append-only in spirit` is the plan's phrase and it
  means the trail is append-only, not the row.
- **Tombstoning a continued movement is refused.** Deleting the storage leg out
  from under its recycling leg would orphan the chain and silently re-open 12
  chairs of pending mass; the message names the movement that depends on it.

### Concurrency

Three shapes, all the same fix, all in one transaction that opens with
`select … from project_assets where id = $1 for update`:

1. **The quantity ceiling** (finding 3) — two clerks, two movements, both within
   the ceiling separately and over it together.
2. **`sequence`** — `unique (asset_id, sequence)` makes the loser of a race an
   error rather than a corruption, which is the right failure but a bad one to
   show a user; allocating the sequence under the same lock makes it not happen.
   The unique index stays regardless, because an invariant enforced only by a lock
   is an invariant that a future direct-SQL fix can violate.
3. **`outcome_state`** — a derived column written by two transactions in an
   interleaving that leaves it disagreeing with the movements it summarises.

The asset row is the lock for all three because it is the row every one of them is
ultimately about. Movements are inserted, continued and tombstoned under their
parent's lock, which also gives the recompute a consistent read for free.
---

## 4. Permission + scope matrix

Four independent checks per operation: **feature entitlement** (does the plan
sell it?) · **capability** (may this person do it?) · **company edge** (are these
two companies in a relationship?) · **resource scope** (is this person on *this*
project?). A row filling only one column is a hole.

§37's rule holds here exactly as it did in Phase 7: **a capability never widens
company scope or the one-hop rule.** Scope is checked first and independently, and
`hasCapability` can only narrow what `policies.ts` has already allowed.

| Operation | Feature | Capability | Company edge | Resource scope |
|---|---|---|---|---|
| Read the asset-type catalog | **none** — it is a vocabulary, not content | `project.read` | own company + the system rows | n/a |
| Create / edit a company asset type | `asset_tracking` on the **acting company** | `sustainability.settings.manage` | own company only | n/a |
| Edit a **system** asset type | — | **nobody** | n/a | n/a |
| Read the destination-type catalog | none | `project.read` | own company + the system rows | n/a |
| Create / edit a company destination type, incl. `counts_as_*` | `asset_tracking` on the **acting company** | `sustainability.settings.manage` | own company only | n/a |
| CRUD a destination organisation | `asset_tracking` on the **acting company** | `asset.destination.set` | own company only | n/a |
| Read a project's asset lines | `asset_tracking` on the **project owner** | `project.read` | owner sees all; a provider sees its own rows | the project |
| Create an asset line | `asset_tracking` on the **project owner** (§13.3) | `asset.write` | owner or one-hop provider | assigned to the project |
| Bulk paste-import lines | `asset_tracking` on the **project owner** | `asset.write` | as above | as above |
| Edit an asset line's metadata / quantity | `asset_tracking` on the **owner** | `asset.write` | own company's rows; **the project owner may edit any** | the project |
| Set a weight with `ESTIMATED` / `APPROXIMATE` | `asset_tracking` on the **owner** | `asset.write` | as above | as above |
| Set a weight to `VERIFIED` / `DOCUMENTED` | `asset_tracking` on the **owner** | **`asset.weight.verify`** | as above | as above |
| Tombstone an asset line | `asset_tracking` on the **owner** | `asset.write` | own company's rows; the owner may remove any | the project |
| Record a movement | `asset_tracking` on the **owner** | `asset.destination.set` | own company's lines; the owner may move any | the project |
| Continue a storage movement | `asset_tracking` on the **owner** | `asset.destination.set` | as above | as above |
| Correct a movement | `asset_tracking` on the **owner** | `asset.destination.set` | as above | as above |
| Attach evidence or a document to a line or movement | `asset_tracking` + the referenced record's own key | `asset.write` + the record's read capability | both records must be on the same project | the project |
| Read the mass roll-up | `asset_tracking` on the **owner** | `sustainability.read`, **or** `project.read` for the mass-only view | owner sees the project; a provider sees the project | the project |
| Client reads any of it | — | **nobody in Phase 8** | n/a | n/a |

Five rows carry an argument.

**`asset_tracking` is checked against the project owner, and this is precedent
rather than a new decision.** Phase 7 settled it twice — for `project_evidence`
and again for `project_documents` — with a reason that transfers word for word:
*"a Crew-plan subcontractor may always photograph a floor on somebody else's
project and consumes that owner's entitlement doing it; its own projects need this
key on its own plan."* §43 puts asset tracking at "—" on Crew, and gating the
*recorder* would mean a free subcontractor cannot write down what it removed —
which for a clearance contractor is not a feature of the job, it **is** the job.
The Crew plan exists so a subcontractor can work for a paying customer; a
subcontractor who cannot record the 42 chairs is useless to that customer. So the
key is checked on `projects.owner_company_id` at every write, and on the acting
company only for the catalogs and organisations it keeps for itself. **Recorded as
following precedent in §13.3, not sent back to the owner** — the rule was answered
on 2026-09-01 and this is the same rule with a different noun.

**The weight-confidence split is the reason the capability layer was built.**
`asset.write` and `asset.weight.verify` are two keys because a supervisor with a
tape measure and a sustainability lead with a weighbridge ticket are making
different claims, and `capabilities.ts` already carries the sentence: *"§25.3
makes a `VERIFIED` weight a documented claim rather than an opinion, which is the
Sustainability function's job, not the person with the tape measure."* Phase 8 is
where that comment acquires an enforcement point. The refusal is specific — *"you
can record this weight; marking it verified needs the weight-verification
permission"* — because a generic 403 in front of a form somebody has just filled
in is how people learn to route their work through whoever has the bigger role.

**The project owner may edit a subcontractor's asset line, and may not edit its
diary entry.** That asymmetry is deliberate and worth stating because Phase 7 drew
the opposite conclusion three months of code ago. A diary entry is *a statement by
a person about what they saw*; editing it and leaving it attributed to them is the
one thing an evidence trail must never permit. An asset line is **a measurement of
a shared physical fact** — the chairs are the chairs, and the hiring company is
the one that reports the tonne and answers for it. The protection is not
prohibition but attribution: every edit writes a `record_revisions` row naming who
changed what, so a subcontractor can see that its estimate was corrected, by whom,
and to what. Refusing the edit outright would mean a sustainability lead cannot
attach the weighbridge ticket that arrived in *their* post to the line a
subcontractor typed, which is the normal case rather than an edge one.

**`counts_as_*` is customer-editable by design, and the control is disclosure
rather than prevention.** Locked decision #20 is explicit: *"waste-hierarchy and
destination semantics are configurable data, not code — so an org can see and
adjust its own assumptions."* The consequence, stated plainly because it is not
obvious: a company can create a destination type called Landfill with
`counts_as_diverted = true` and its diversion rate will say so. Three things
contain that, and none of them is a validator. System rows are immutable, so the
seeded semantics are always available to compare against. A company row shadows a
system row **by code**, so the shadowing is visible as a diff rather than as an
absence. And the roll-up reports which flags produced each figure, so Phase 10's
report discloses a customised hierarchy the same way §29.1 §10 discloses every
other material assumption. A product that lets a customer set its own assumptions
and does not say which ones it used is worse than one that refuses to let them.

**The mass roll-up has two read gates, and the softer one is deliberate.**
`sustainability.read` is not in the Supervisor bundle, and the Supervisor is the
person who most needs to know that twelve chairs are still unallocated. The
mass-only view — handled, allocated, pending, and what is still open — is a
restatement of the asset rows the caller can already read one at a time, so
gating it behind a capability they lack would hide an aggregate of visible data
and push them to count by hand. The rates, the hierarchy breakdown and the data
completeness score are the `sustainability.read` view. No money appears in either;
mass is not commercially sensitive in the way a rate is, which is what makes the
split safe.

---

## 5. Domain events

Every event is written in the same transaction as its state change (§36, decision
#25), through the existing outbox.

| Event | Payload | Idempotency key | Consumers | Replay |
|---|---|---|---|---|
| `asset.lines_recorded` | `projectId`, `companyId`, `lineCount`, `batchClientId`, `recordedByUserId` | `batchClientId` | notifications (owner digest); analytics | safe — projection is idempotent on the key |
| `asset.movement_recorded` | `projectId`, `assetId`, `movementId`, `destinationCode`, `isFinalOutcome`, `quantity` | `movementId` | notifications; Phase 9 carbon recalculation | safe |
| `asset.movement_continued` | `projectId`, `assetId`, `movementId`, `continuesMovementId`, `destinationCode` | `movementId` | as above; **Phase 9 must supersede any claim on the continued leg** | safe |
| `asset.weight_verified` | `projectId`, `assetId`, `weightSource`, `confidence`, `documentId` | `assetId` + `revision` | notifications; analytics quality metric | safe |
| `asset.storage_ageing` | `projectId`, `assetId`, `daysInStorage`, `inStorageKg` | `assetId` + the owner-local ISO date | the Action Centre | safe — one per asset per day |

Five kinds, and the two that are **not** here matter as much as the five that are.

**There is no `asset.line_created`.** Sixty pasted lines is one act by one person,
and Phase 7 already learned this the expensive way: `notifications.ts` carries the
comment *"`evidence.uploaded` is deliberately not one of them. Forty photographs is
one act by one person."* Sixty rows would be sixty rows in an Action Centre that a
person then has to clear one at a time, which teaches them to ignore it.
`batchClientId` is the same column `project_evidence.batch_client_id` is, doing
the same job — it keys the single event, and it is how *"show me what I just
pasted"* is asked after a filter has moved.

**There is no `asset.weight_changed`.** Every weight edit writes a
`record_revisions` row, which is the durable trail; an *event* is for something a
person elsewhere needs to know about, and an estimate being refined from 16 kg to
16.5 kg is not. `asset.weight_verified` fires only on the transition into
`VERIFIED`/`DOCUMENTED`, because that is the transition that moves a figure from
"estimated" to "documented" in a client's report — the one a hiring company has a
reason to hear about.

**`asset.storage_ageing` is the phase's only generated event, and it is here
because decision #18 has no other enforcement.** Storage being excluded from every
rate is correct and completely silent: the material is off site, the job feels
finished, and the number quietly under-reports for as long as nobody looks. The
existing nightly `work` job already carries the document-expiry ladder from 7.4;
this is a fifth pass over the same schedule, emitting one item per asset that has
been open in storage past a threshold, with the mass named. **It does not block
anything** — §33's *"never auto-blocks unless `enforce_compliance`"* is the
governing instinct here, and this is not even a compliance record. It is a
question left in an inbox: *"1.34 t has been in storage 42 days. Where did it
go?"*

**Built 2026-09-02, with one field renamed.** The table above said `pendingKg`;
what shipped is **`inStorageKg`**. Pending mass is storage *plus* everything with
no destination at all, and the sentence this event feeds — *"240.0 kg has been in
storage 42 days"* — is true only of the first. A line with 8 desks stored and 5
chairs never allocated would have reported the chairs as having been in a
warehouse they were never in.

The threshold is `30` days, hard-coded with a comment, and **not** a settings row.
§39 is a Phase 9 table; inventing a settings mechanism to hold one integer, four
weeks before the table that should hold it arrives, is the migration this packet
exists to avoid. The same reasoning `0030` applied to GPS.

---

## 6. Notification matrix

| Kind | Recipient | Channel | Urgency | Digest / quiet hours | Escalation | Action Centre |
|---|---|---|---|---|---|---|
| `asset.lines_recorded` | the project owner's members with `project.read` | EMAIL | NORMAL | digestible; quiet hours apply | none | yes — informational |
| `asset.movement_recorded` | the project owner, when the recorder is a provider | EMAIL | NORMAL | digestible | none | yes — informational |
| `asset.weight_verified` | the recording company, when the verifier is someone else | EMAIL | NORMAL | digestible | none | yes — informational |
| `asset.storage_ageing` | the project owner's `sustainability.read` holders, and the recording company | EMAIL | NORMAL | digestible; **one per asset per day at most** | none after 90 days — it stops repeating and stays in the list | **yes — `requiresAction: true`** |

Exactly one kind sets `requiresAction`, and it is the one with something to do.
`notifications.ts` already carries this discipline for Phase 7 — *"exactly one
kind sets it: `diary.amended`"* — and the reason is the same: a list where
everything requires action is a list where nothing does.

Nothing here escalates and nothing is urgent. A tonne of furniture in a warehouse
is not a page at 3 a.m., and treating it as one would train people to mute the
channel that later has to carry something that is. §41's principles are about the
number being right, not about it being right *quickly*.

**No payload names an asset.** Not the description, not the manufacturer, not the
serial number, not the destination organisation's name. `notifications.ts` §11
already excludes document titles and references as customer prose; a serial number
is stronger than that — it identifies a specific physical machine, often with a
client's asset tag on it, and it would travel to an email provider. A body reads
*"12 items — 340 kg — recorded to a final destination"*, composed from the count,
the mass and the destination **type label**, which is vocabulary the platform owns.
The only exception is the destination type's own name, which for a company row is
customer prose — so the composer uses the **system** label when the type shadows
one, and the generic *"a custom destination"* when it does not.

---

## 7. Data classification + retention

| Data | Class | Default visibility | Lifecycle | Legal hold | Deletion | Export |
|---|---|---|---|---|---|---|
| `asset_types` (system) | reference | public within the platform | permanent | n/a | never | n/a |
| `asset_types` (company) | reference | the company | with the company | follows the company | cascade on company delete | included |
| `project_assets` | **commercial + evidence** | the project's two companies | with the project | **yes — a mass claim on a client report is exactly what a hold is for** | see below | project-owner export |
| serial numbers, asset tags | commercial, **client-identifying** | as above | as above | as above | as above | included, and flagged |
| weights + provenance | **evidence** | as above | as above | yes | never hard-deleted while a report cites them | included |
| `destination_organisations` | commercial + **third-party personal** (`contact_name`, `contact_email`, `contact_phone`) | the company | until deactivated | follows the company | **anonymise, do not delete** | included |
| `asset_movements` | **evidence** | as above | with the asset | yes | as below | included |
| the roll-up | derived | — | not stored | n/a | n/a | recomputed, never exported as a stored figure |

**An asset line is evidence, and that decides its deletion behaviour.**
`observability-data-lifecycle.md` §13 settled the load-bearing version of this
question for a time log: a subcontractor's record is simultaneously the hiring
company's proof of an invoiced hour, so hard deletion is a data-integrity attack
anybody can run by asking politely. An asset line is the same shape and slightly
worse — it is the hiring company's proof of a **diverted tonne**, which may have
been reported to that company's own client under a framework with a retention
period attached. Deletion tombstones the row and anonymises the person, exactly as
closure already does for evidence. Nothing in this phase hard-deletes an asset
line or a movement.

**Deletion is refused outright once a report cites the row.** That mechanism is
Phase 10's (`generated_reports` and its `content_hash`), and it does not exist
yet, so Phase 8 ships the honest version: the tombstone stands, the roll-up stops
counting it, and `record_revisions` holds what it was. §41.3's promise —
historical reports remain reproducible — is kept by the snapshot rather than by
the live row, which is precisely why the snapshot exists. **This is the one thing
in §7 that Phase 8 leaves owed, and it is named here rather than left implied.**

**A destination organisation carries a third party's personal data, and that third
party is not a user.** A charity's contact name, email and phone belong to a
person with no CrewQuo account, no consent flow and no way to ask what is held
about them. Three consequences: the fields are optional and the UI does not push
for them; deactivation anonymises the contact and keeps the organisation, because
the *organisation* is what a two-year-old movement record needs to name; and a
data export includes them, because they are the exporting company's own contacts
book. Nothing else in the product ever sees them: `scrub.ts` is an allowlist that
**rebuilds** an error event from named fields rather than deleting from it, so a
contact address cannot reach the tracker by being forgotten, and this phase's
event payloads are built by the same allowlist discipline `evidence.ts`,
`diary.ts` and `documents.ts` already use — §6 names what they carry, and a
contact detail is not on the list.

**Serial numbers reach the export through a deliberate line, not a `select *`.**
`data-export.ts` is *"an allowlist per **column**, not per table"*, so adding
these tables means naming every column that leaves — which is exactly where a
serial number gets decided rather than defaulted. It is included: refusing to
export a customer's own asset register would be absurd, and an ITAD certificate is
the point of recording serials in the first place. But it is worth naming what
that column is, because it is unlike everything else in the file — an identifier
for a machine that usually belongs to the *client* rather than to the exporting
company, in a document with a real value to whoever receives it. It goes in the
manifest by name, which is the mechanism `observability-data-lifecycle.md` already
built for exactly this: *"manifest and authorized links, not bytes."*

---

## 8. Offline / conflict policy

Assets are the first Phase 7-contract records built *after* the phone was
scheduled to capture them. 13.5 is explicit — *"Assets Removed, Waste/Reuse,
destination assignment on site"* — so the three primitives in `sync.ts` are used
here rather than merely available.

| Primitive | Applied to | Behaviour |
|---|---|---|
| `clientId` | create line, paste-import batch, record movement, continue movement | a replayed request returns the original row and creates nothing |
| `expectedRevision` | update line, update weight, correct movement, tombstone | mismatch is `STALE_REVISION`, and the response carries the current row |
| tombstones | lines and movements | `deleted_at`, `GONE` on a write against one — never a 404 |
| `revision` | both tables | `bump_revision()` from `0029`, reused rather than reimplemented |

**Both tables get the two columns the canonical DDL omits.** `revision` and
`deleted_at` on `project_assets` and `asset_movements`, plus the `bump_revision`
trigger `0029` installed. This is finding 9's other half and it is the cheapest
line in the phase to write now and the most expensive to retrofit — `0030` and
`0031` both did it and neither cost more than four lines.

**The merge rule is refuse, not merge, and the field-level exception is refused
too.** A tempting design says two people editing different fields of one asset
line should both win. It is wrong here for a specific reason: `quantity`,
`unit_weight_kg` and `total_weight_kg` are not independent fields — §25.2 derives
one from the others, so a "merge" of somebody's new quantity with somebody else's
new total weight produces a unit weight neither of them typed. The whole line is
one claim. `STALE_REVISION`, show both, let a person choose.

**A paste-import is one `clientId` and many rows, and a partial success is a
success.** Sixty pasted lines where four have an unrecognised asset type import
fifty-six and return four errors *by row number and by the text that failed*, not
a transaction that rolls back all sixty because row 34 said "Chiar". A rejected
import is a person retyping sixty rows, and they will retype fifty-nine of them
identically. The `clientId` covers the batch, so a retry of the whole paste after
fixing row 34 re-imports nothing that already landed and adds the four.

**What Ekene sees when a change is refused.** On the phone, in the queue, three
messages and no stack traces:

- *"These 42 chairs were changed by Rafiat while you were offline. Yours: 16 kg
  each. Theirs: 16.5 kg, weighed. Keep theirs / use mine."*
- *"This asset line was removed. Your change was not applied."* (`GONE`)
- *"Only 12 of these 42 chairs are still unallocated — 30 are already recorded as
  donated. Record 12?"* — the ceiling refusal, which is the one a supervisor will
  actually hit, and it is a question with a usable answer rather than an error.
---

## 9. Failure matrix

| Failure | Retryable? | Partial success | Operator repair | What the user sees |
|---|---|---|---|---|
| Movement exceeds the open quantity | **terminal** — retrying re-fails | none; nothing is written | none needed | *"Only 12 of 42 are still unallocated. Record 12?"* with the figure |
| Two movements race the ceiling | retryable — the loser is refused, not corrupted | none | none | the same message, on one of the two |
| `sequence` unique violation | should be unreachable under the lock | none | investigate: it means a writer took a path that skipped the lock | a generic retry prompt |
| Continuation of a final-outcome movement | terminal | none | none | *"These 12 are already recorded as recycled. Correct that movement instead."* |
| Continuation quantity exceeds the leg | terminal | none | none | the figure, named |
| `VERIFIED` without a document | terminal | none | none | *"A verified weight needs the ticket attached."* |
| `VERIFIED` without `asset.weight.verify` | terminal | **the weight is still saved, at `ESTIMATED`** | none | *"Saved as an estimate. Marking it verified needs the weight-verification permission."* |
| Paste-import: 4 rows of 60 fail | **partial success is the design** | 56 imported | none | four rows, by number, with the text that failed |
| Cited document tombstoned | terminal on the delete, not on the asset | none | none | *"This is the evidence for a documented weight on 3 asset lines."* |
| `outcome_state` disagrees with movements | not user-visible | — | **a recompute route + a nightly reconciliation counter** | nothing |
| Asset-type shadow resolves to two rows | unreachable after finding 8's index | — | the index refuses it at write time | nothing |
| Storage ageing job fails | retryable — one-shot, restarted by the scheduler | the pass is idempotent per asset per day | `job_runs` | nothing; the item appears a day late |

Two rows deserve their own paragraph.

**The permission failure saves the work.** A supervisor who ticks "verified"
without the capability gets their weight recorded as an estimate and a sentence
explaining the difference — not a 403 in front of a form they have to fill in
again on a phone in a stairwell. This is the one place in the phase where a failed
authorization check produces a **successful write of a lesser claim**, and it is
deliberate: the alternative teaches people to hand the phone to whoever has the
bigger role, which is worse for the audit trail than the thing the check protects.

**`outcome_state` gets a reconciliation counter, because a derived column with one
writer is still a derived column.** §3 puts every recompute behind a single
function under the asset's lock, which makes drift very unlikely and not
impossible — a future direct-SQL correction, a restore, a migration that
back-fills. The nightly pass counts rows whose stored state disagrees with a
recomputation and logs the count with the tenant and the correlation id. It does
not silently repair them: a repair that leaves no trace is how a systematic bug
stays invisible for a year. `access.md` §13.3 refused per-tenant operator read on
the strength of *"a customer problem is diagnosed from audit rows and logs"*, and
a counter of zero every night is what keeps that sentence true here.

---

## 10. Security / threat model

**Tenant boundary.** Every read joins through `projects` and the existing
`policies.ts` scope check; no asset route takes a `company_id` from the request.
The one genuinely new surface is `destination_organisations.linked_company_id`,
which points at another `companies` row — and that is a claim about a third party.
Bounded exactly as §23's `provider_company_id` was in Phase 7: a linked company
must be one this company already has an engagement edge with, so *"we donate to
Redstone Reuse"* cannot be asserted about an arbitrary business that cannot see or
contest the record. A genuine off-platform charity is unaffected; it has no
`companies` row and is recorded by `name`, the column that exists for that case.

**Forged identifiers.** `asset_type_id`, `destination_type_id`,
`destination_org_id`, `origin_location_id`, `weight_document_id`, `document_id`
and the evidence links are all foreign keys a caller supplies. Each is validated
for reachability *by this caller*, not merely for existence:

- an asset type must be a system row or one this company owns;
- a destination type, the same;
- a destination organisation must belong to this company;
- a location must belong to **this project** — `locations.ts` already has the
  tree, so the check is a lookup rather than a new query shape;
- a document or evidence item must be on **this project** and readable by this
  caller under §4.

The last one is the one worth stating, because it is the quiet cross-tenant read:
without it, a subcontractor could attach an arbitrary document id to its own asset
line and then read the document back through the asset's expanded response. Two
records on one project, both readable, and the join is checked in the direction
the attacker would use it.

**The `counts_as` surface is an integrity risk, not a confidentiality one, and it
is the customer's own to take.** Decision #20 makes it configurable on purpose;
§4 records the three things that contain it. The one hard rule is that **system
rows are immutable** — a company that could edit the seeded `LANDFILL` row would
change what "landfill" means for every future comparison, including its own
historical ones.

**Storage is a denial-of-accuracy surface, not a denial-of-service one.** The
abuse worth naming is not volume: it is a company that records everything to
`STORAGE`, reports a clean project, and never records the second leg. This is
precisely what decision #18 prevents from *becoming* a reported number — storage
counts as nothing — and `asset.storage_ageing` is what stops it from being
invisible. There is nothing to block; the correct response to a project that is
80% pending is a report that says so, which is §28.3's whole purpose.

**No upload surface is new.** Every byte in this phase arrives through
`stored_files` and the presign flow 7.0 built, with `storage_gb` charged to the
project owner. Assets reference documents and evidence; they never take a file
directly. That is one fewer surface than the phase might have had, and it is worth
saying out loud because "attach a photo to this asset line" is exactly the feature
that invites a second upload path.

**No new secret, no new webhook, no new privileged access.** The phase adds
nothing to rotate and nothing to receive. Platform support access remains refused
(`access.md` §13.3).

---

## 11. Analytics contract

| Metric | Definition |
|---|---|
| **Activation** | a company records its first asset line with a weight *and* its first movement to a final outcome — the two halves of the record that make a mass balance possible |
| **Outcome** | a project reaches ≥ 90% allocated mass — the point at which its sustainability figures are worth reporting |
| **Funnel** | line recorded → weight entered → movement recorded → final outcome → weight documented |
| **Quality** | the §28.3 completeness score, and separately the **pending-mass ratio** — the share of handled mass still in storage or unallocated across live projects |
| **Counter-metric** | the share of weights at `SYSTEM_ESTIMATE`. It should fall as a company populates its own type defaults; a rise means the product is teaching people to accept a number it invented for them, which §41.1 exists to prevent |

Excluded from every payload, and asserted by test the way `evidence.test.ts`
asserts §11 backwards: descriptions, manufacturer, model, **serial numbers**,
asset tags, notes, destination organisation names, contact details, addresses and
licence numbers. Counts, masses, codes, confidence levels and ids only.

The pending-mass ratio is a product metric and not only an analytics one. If it
sits high across the customer base, decision #18 is working exactly as designed
and the product has a *workflow* problem — people are not coming back to record
the second leg — which is a thing to fix in the interface rather than in the
definition. The temptation, when that ratio is embarrassing, is to start counting
storage as an outcome. That is the number this counter-metric exists to make
visible before anybody proposes it.

---

## 12. Acceptance script

The phase's e2e verification implements this. Named personas, and the five paths
the template requires — empty, denied, rejected, offline/retry, correction.

**Setup.** Meridian Facilities (project owner, Pro) runs "Kings Court — Floor 2".
Ekene works for Halewood Clearance (Crew, free) and is assigned. Rafiat is
Meridian's sustainability lead. Dolapo is Meridian's PM. Halewood's plan does
**not** include `asset_tracking`.

1. **Empty.** Dolapo opens the project's Assets section. No rows. The empty state
   says what an asset line is for and offers two routes — add a line, or paste a
   schedule — and shows the mass balance as *"Nothing recorded yet"* rather than
   as `0.00 t`, which is a claim.

2. **Capture.** Ekene, on a phone, records `42 × Operator Chair`, unit weight
   `16.5 kg`, origin `Floor 2`, source `USER_ESTIMATE`. **It succeeds** — the
   entitlement is checked against Meridian, not Halewood. The line reads
   `693.0 kg`, `weight_basis = UNIT`, confidence `ESTIMATED`,
   `outcome_state = PENDING`. One photograph is attached from the evidence he
   uploaded that morning.

3. **Denied.** Ekene ticks "weighed and verified". The weight saves at
   `ESTIMATED` with the sentence from §9. Halewood then opens its *own* project
   and tries to record an asset: **refused**, naming `asset_tracking` and its own
   plan. The two refusals in one script are the point — the same key, opposite
   answers, because the question is whose project it is.

4. **Bulk.** Dolapo pastes 60 lines from the client's schedule. 56 import; 4 fail
   on an unrecognised type, returned by row number with the text that failed. He
   fixes them and re-pastes all 60: nothing duplicates.

   **Corrected 2026-09-02, when 8.6 tried to build it.** *"Re-pastes all 60"* is
   not implementable by any client: under the same batch id the idempotency ledger
   refuses it — correctly, because the body differs and a second act must not be
   answered with a first answer — and under a new id it imports 56 duplicates.
   What the screen does instead is **rewrite the box to hold only the 4 that
   failed**, and say so. Same outcome, and it is the one a person can reach.

5. **Split.** Dolapo records two movements against the chairs — `30 → DONATION`
   (Bright Futures, a `CHARITY` organisation, donation receipt attached) and
   `12 → RECYCLING`. The line goes `FINAL`. The mass balance reads
   `693.0 kg handled · 495.0 kg reuse · 198.0 kg recycling · 0 pending`, with
   reuse above recycling and **no combined "diverted" figure standing in for
   either** (§41.8).

6. **Rejected.** He tries a third movement of 5 more chairs. Refused with
   *"0 of 42 are still unallocated"*. He tries to record 20 desks against an asset
   type belonging to another company: refused as not found, not as forbidden —
   the id is not his to learn about.

7. **Storage, and the reason this script exists.** 8 desks are recorded
   `8 → STORAGE`. The line goes `PARTIAL`; the mass balance shows the desks in
   **pending**, not in any rate, and the completeness score names the gap in
   §28.3's words: *"Final destination for 240 kg of stored furniture is currently
   unknown."* Thirty days later the nightly job raises `asset.storage_ageing`;
   the Action Centre item names the mass. Dolapo then records
   `8 → RESALE, continues movement #3`. The storage leg stops counting, resale
   appears in reuse, pending goes to zero, and **the total handled mass has not
   moved by a gram at any point** — which is the assertion that proves finding 1.

8. **Offline / retry, and the one operation that is allowed to move the total.**
   Ekene, in a basement with no signal, edits the chair weight to `16.0 kg` and
   records a movement. Both queue. Meanwhile Rafiat's weighbridge ticket arrives:
   she corrects the line to `701.4 kg` total, `WEIGHBRIDGE`, attaches the ticket,
   marks it `VERIFIED`, and — because the ticket weighed the recycling load
   separately — records `205.0 kg` **on that movement**, overriding the
   derivation. Ekene surfaces. His movement replays under its `clientId` and
   creates nothing new. His weight edit is refused `STALE_REVISION` and he is
   shown both weights with their sources; he keeps hers.

   Two things then have to be true at once. **The derived leg moves with the line
   automatically** (finding 4): the donation leg is now `30 × 16.7 = 501.0 kg`,
   with nothing back-filled. **The overridden leg does not**, and never will
   again — it is a weighed figure, and a line-level estimate has no business
   correcting it. Handled mass reads `706.0 kg`, which is higher than the line's
   own `701.4` and is not an error: the parts were weighed better than the whole,
   and §41.6 says measured data is distinguished from estimated data *in every
   total*. Unallocated mass is therefore computed from **quantity** — 42 minus
   the 42 open — and never by subtracting masses, which is the arithmetic that
   would otherwise report `−4.6 kg` awaiting a destination.

9. **Correction, and its trail.** Rafiat notices the donation went to the wrong
   charity and corrects the movement's organisation. `record_revisions` holds
   before and after, `changedFields` names `destination_org_id` alone, and the
   asset's history panel says *"amended twice — view history"*. The mass balance
   does not move, because a charity is not a mass.

10. **Deletion.** Halewood closes Ekene's account. His asset line survives with a
    null `created_by_user_id`; the register still totals 693 kg; the history panel
    shows the tombstoned identity rather than a blank.

The property the whole script is built to assert, stated once so a future test can
be checked against it: **total handled mass is invariant under every movement
operation that asserts no new weight.** Recording, splitting, storing, continuing,
tombstoning, correcting a destination or a date — none of them changes what came
off the floor. Exactly two operations may move the total, and both are somebody
deliberately claiming a better figure: editing the line's weight, and overriding a
movement's. Both write a `record_revisions` row, which is what makes *"why did
this project's tonnage change?"* a question with an answer.
---

## 13. Decisions — two open, three recorded as following precedent

**Neither open question blocks the build,** and §14 is ordered so that the first
three steps depend on neither. Both are departures from a canonical DDL rather
than product choices, so both are **built as recommended** and raised here for the
same reason Phase 7 raised `READY`: a departure taken silently reads a year later
like something nobody noticed.

### 1. §25.4 rule 1 contradicts §25.4 rule 3 → **OPEN — built as recommended: a continuation chain**

Restated from §0 finding 1 because this is the one that changes the schema.
`sum(movements.quantity) <= project_assets.quantity` and *"when the material later
leaves storage a second movement records the real outcome"* cannot both hold: 12
chairs into storage and 12 out of it is 24 against a line of 42 that also donated
30.

**Recommended, and built:** one nullable `continues_movement_id` self-reference;
rule 1 restated over movements nothing continues; §28.2's masses restated over the
same set (§0 finding 2).

*Rejected — enforce rule 1 literally.* Storage becomes a one-way door. Decision
#18 says an asset in storage stays `PENDING` *until a final destination is
recorded*, which is a sentence about recording it later; a schema that refuses the
later record makes the decision unimplementable.

*Rejected — count only final-outcome movements against the ceiling.* Simpler, and
it loses the thing storage exists to track: with non-final movements unconstrained,
500 of 42 chairs can be in a warehouse and the register cannot say what is
physically where.

*Rejected — make storage a state on the asset rather than a destination.* It
contradicts decision #20 (semantics are data, not code) and deletes the `STORAGE`
row that decision #18 is built on. It also loses the date, the organisation, the
address and the transfer note — a warehouse is a place material was taken to, and
the record of taking it there is a movement whatever we call it.

**The cost of the recommendation, stated:** one nullable column, one partial
unique index, and a rule that every mass query must respect. The cost of *not*
taking it is a migration on a table holding a year of movements, and a published
diversion rate that was wrong for that year.

### 2. Is a serial number unique to a company, or to a project? → **OPEN — built as recommended: company-wide, failing loudly**

§25.2's index is `unique (company_id, serial_number) where serial_number is not
null and tracking_mode = 'ITEM'`. The same server, relocated off project A and
recycled from project B a year later, is one physical machine and two rows in one
company. Company-wide uniqueness refuses the second.

**Recommended, and built:** keep it company-wide, add the missing
`and deleted_at is null`, and refuse the second row with a message naming the
project the serial already lives on — *"Serial `SN-4471` is recorded on Kings
Court — Floor 2. Record a movement there instead of a new line here."*

*Rejected — scope to `(company_id, project_id, serial_number)`.* It permits the
same machine to be recycled on two projects and reported as two tonnes and two
ITAD certificates. §41 exists to prevent exactly that, and a double-count that
passes every constraint is the worst kind.

*Rejected — a cross-project asset registry with a passport per serial.* It is the
right long-run answer and it is not in the plan, not in Phase 8's milestone, and
not something to invent in a migration. The loud refusal is what makes the demand
for it visible if it turns out to be common.

**What could change the answer:** if ITAD customers routinely re-handle their own
serials across projects, the refusal becomes friction rather than a guard rail and
the registry becomes a real feature request. The refusal message is written so
that its frequency is measurable.

### 3. Whose plan must include `asset_tracking`? → **RECORDED AS PRECEDENT (answered 2026-09-01) — the project owner's**

Not a new question. The owner answered the packaging rule on 2026-09-01 —
*"capture is free, the record is the project owner's entitlement"* — and
`entitlements.ts` carries it twice, for `project_evidence` and `project_documents`.
The reasoning transfers with one noun changed: a subcontractor who cannot record
what it removed cannot do a clearance job, and the Crew plan exists so a
subcontractor can work for a paying customer for nothing.

Seeding follows what Phase 7's three keys did rather than re-opening it: the key
goes on Starter, Pro, Business and Enterprise exactly as §43's table proposes, and
not on Crew. Unlike `storage_gb`, there is no reserved number here — a feature
placement is a boolean, and §43's table is the plan's own proposal for it.

**The consequence, said plainly:** a Crew company running *its own* project cannot
record assets at all. That is the intended shape of the free tier and it is
consistent with what shipped for evidence, documents and the diary.

### 4. Do the §39-governed behaviours wait for §39? → **RECORDED — no, and no column either**

Two Phase 8 behaviours cite a Phase 9 settings table. §25.3: *"`< 1000 kg` shows
kg to 1dp, `≥ 1000 kg` shows tonnes to 2dp, unless the org pins a unit in §39."*
§28.3: the five completeness weights are *"configurable in §39, defaults below."*

Both are **pure functions with the default as a parameter**, in
`packages/shared/src/assets.ts`. No settings table, no column, no back-fill: when
§39 lands, the caller passes a value instead of taking the default and the
function does not change. This is `0030`'s GPS reasoning inverted — there the
*columns* landed early because a migration on a full table is expensive; here
there is nothing to migrate, so nothing lands early.

### 5. Does Phase 8 report a data-completeness percentage? → **RECORDED — the gaps yes, the score no**

§28.3's score has five weighted components and Phase 8 can compute three: lines
with a weight, mass with a known final destination, and mass whose weight is
`VERIFIED`/`DOCUMENTED`. The fourth needs the evidence/document links this phase
builds (so, yes, four) and the fifth — *"avoided-emissions mass using a
product-specific factor"* — is Phase 9 and cannot exist here.

Publishing a percentage over four fifths of a definition produces a number that
**changes meaning** when Phase 9 lands, in the direction of getting worse, on
projects nobody touched. A customer who screenshots 92% in Phase 8 and sees 74% in
Phase 9 has been told something false by both.

So Phase 8 ships **the named gaps and not the composite** — *"18% of project
weight is estimated"*, *"final destination for 240 kg of stored furniture is
currently unknown"* — which are §28.3's own examples, are the half that is
actionable, and are each true independently of the components that do not exist
yet. The score arrives in Phase 9 with its fifth component, computed once over all
five.

---

## 14. Build order

Ordered so that the two open questions in §13 are settled by construction in step
3 and nothing before them waits. Steps 0–2 need no answer from anybody.

**0. `packages/shared/src/assets.ts` — the pure policy, before any table.**
The weight algebra (basis, derivation, the quantity-edit rule, the zero-quantity
guard), the provenance table (7 sources → 4 confidence levels) and its
document-required rule, the movement algebra (open movements, allocated, in
storage, unallocated, handled), `outcome_state` derivation, the hierarchy ordering
that puts reuse above recycling, the display-unit rule, and the gap sentences. A
unit test per branch, and the invariant from §12 asserted directly: **handled mass
is invariant under every movement operation that asserts no new weight.** This is
the rate engine's precedent
— *"exhaustive tests before anything renders a number"* is §27.1's rule for Phase
9 and it applies a phase early to the masses those numbers multiply.

**1. Migration `0033_asset_catalogs.sql` + the catalogs.** `asset_types` with
the 22 seeded system rows and **`default_unit_weight_kg` null on every one of
them** (§41.1); `destination_types` with the eleven rows of §25.4's table, the two
partial unique indexes of finding 8, and `created_at`/`updated_at`;
`destination_organisations`. Plus the `asset_tracking` feature row and its four
plan placements in `infra/seed/index.ts`. Reference data first, because everything
after it is a foreign key to one of these.

**The single migration this step named became three** — `0033_asset_catalogs`,
`0034_project_assets`, `0035_asset_movements` — one per build-order step, the way
each of Phase 7's seven steps carried its own. A migration that lands three tables
at once is a migration whose failure has to be diagnosed three tables at a time.

**2. `project_assets` + `apps/api/src/modules/assets/`.**
`GET|POST /v1/projects/:projectId/assets`, `GET|PATCH|DELETE /v1/assets/:id`,
`POST /v1/projects/:projectId/assets/import`. Carries `revision`/`deleted_at` and
the `bump_revision` trigger; `created_by_user_id` nullable with
`on delete set null`; the serial index with its tombstone filter; the
weight-confidence capability split; `record_revisions` on every weight change.

**3. `asset_movements` + the ledger.**
`GET|POST /v1/assets/:id/movements`, `PATCH|DELETE /v1/movements/:id`,
`POST /v1/movements/:id/continue`. The continuation chain, the row-lock-then-count
ceiling, the single `outcome_state` recompute, and the three concurrency shapes
of §3 each proved against live Postgres with two racing transactions — which is
how Phase 7 found two races in its own new code.

**4. The back-references `0030` deferred.**
`alter table project_evidence add column asset_id`, `add column asset_movement_id`,
both `on delete set null`, both with the partial indexes §22.2 specifies — landing
with a real foreign key and a real consumer on the same day, which is the
condition `0030` set for them. Document links in both directions, and the
refusal to delete a document a `DOCUMENTED` weight cites.

**5. The mass roll-up.** `GET /v1/projects/:projectId/mass-balance`, rendering
`assets.ts` over the project's rows: handled, allocated, pending with its two
parts, the six rates of §28.2 over allocated mass, the hierarchy breakdown with
reuse above recycling, and the named gaps. **No composite score** (§13.5). **No
carbon** — the milestone is a tonnage split, and §26–§28's factors are Phase 9.

**6. Web: the asset table.** The sixth section on the project record shell the
Phase 7 panels already established. Inline edit, paste-import with per-row errors,
movement recording, destination assignment, the split view that shows 30 donated
and 12 recycled against one line, and the mass balance with pending beside the
rates rather than hidden in a denominator. Browser tests walk §12 end to end.

**This step needed a route the five before it had not.** `GET /v1/asset-types` did
not exist — every write resolves *one* type by id or by code, so nothing on the API
side had ever wanted the catalog, and a register cannot render *"42 × Operator
chair"* out of a uuid. Gated on `project.read` with **no entitlement check**:
`asset_tracking` is asked of a project's owner, and a route with no project has no
company to ask it of.

**7. The storage-ageing pass.** A fifth pass on the existing nightly `work` job,
beside the document-expiry ladder 7.4 added. One Action Centre item per ageing
asset per day, with the mass named.

**What this phase does not build, listed so it is not discovered as a gap:** no
carbon of any kind; no client-visible surface (§7); no composite completeness
score (§13.5); no `vehicles` reference (§0 finding 7); no cross-project asset
registry (§13.2); no §39 settings table (§13.4); and no mobile capture — 13.5 owns
that, and it inherits the sync contract this phase uses rather than a new one.
