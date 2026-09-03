# Operating-model packet — reporting & client sign-off

**Domain:** the Phase 10 record set — `generated_reports` with its frozen
snapshot and `content_hash`, the twelve-section Sustainability & Completion
report, the toggled evidence pack, the client-facing project export moved here
from Phase 4, the configurable disclaimer with its claim guards,
`client_signoffs` with signature capture and append-only supersession, and the
`CLIENT_PERIOD` aggregation §38.2 wants built now and shown in Phase 12.
**Phase:** 10 · **Status:** **adopted** — §14 fully built, all eleven steps shipped,
the §12 acceptance script implemented step for step, and its one open decision
(§13.6, tier placement) followed as §43 proposes with one stated departure
· **Last updated:** 2026-09-03
**Plan refs:** §29 (the reporting engine, all six subsections), §34 (client
sign-off), §38.2 (client-level aggregation), §41 (the ten non-negotiables,
published rather than displayed), §43 (`sustainability_reports`, `evidence_pack`,
`client_signoff`, `client_reporting`), §44 (the reproducibility test and the
firewall test), §23 + `project-evidence.md` §13.6 (the amended diary), decision
**#17** (avoided emissions never added to anything), decision **#27** (evidence
referenced by an issued report or sign-off remains addressable), decision **#30**
(branding inheritance is client-first).

---

## 0. Why this packet, and why now

Phase 9's packet was written to protect a **claim**. This one is about the
**artefact the claim leaves in.**

Everything CrewQuo has built so far can be corrected by correcting its inputs. A
wrong weight is re-weighed; a wrong destination is re-recorded; a wrong carbon
figure is superseded by a recalculation that says what it superseded and why. The
mass balance is derived, the roll-up is derived, and `massBalance.ts` says so in
its own header: *"nobody corrects the roll-up; you correct its inputs."*

Phase 10 breaks that, deliberately and for the first time. §29.4 stores a snapshot
and never recalculates it. The moment a report is generated, a set of numbers
stops being derived and becomes a **record of what was said**, held to a different
standard from every other figure in the product: it must still be reproducible in
2028, after two factor sets have been imported and three weights corrected, and it
must produce the same bytes. That is not a reporting feature sitting on top of the
domain. It is a second kind of truth, and the phase that introduces one is the
phase whose packet has to be written first.

Two more things make the timing load-bearing rather than ceremonial.

**This is the phase where the money boundary leaves the building.** Every
exclusion §4 has enforced for nine phases — no PAY figure, no rate snapshot, no
subcontractor identity, the one-hop rule — has so far been enforced on a *screen*
or an *API response*, both of which are re-checked on every request against a live
authorization. A file is checked once, at generation, and then it is a file:
emailed, printed, filed, forwarded to a party CrewQuo has never heard of. There is
no second chance to apply a filter to a PDF somebody already has.

**And it is the phase where three deferred debts come due at once.** The evidence
packet's §13.6 (a report snapshot versus an amended diary) said in as many words
that it *"bites in Phase 10, not here"*. Decision #27 promises that evidence
referenced by an issued report or sign-off remains addressable — a promise nothing
has ever enforced, because until now there was no report to reference it. And
PROGRESS records artifact-class lifecycle and legal hold as *owed, and named
rather than left implied*, refused in Phase 7 on the grounds that building a hold
with no report to hold would be *"a mechanism with no caller."* This is the phase
that supplies the caller.

### What writing it found

Eleven findings, and a twelfth the **build** added — recorded at the end of this
section, because the acceptance script caught it by disagreeing with the code and
that is the whole reason §12 is written before the code exists.

The first is the milestone.

---

**1. The milestone as written is not achievable by the renderer this phase is told
to build on, and the reason is two fields nobody in this repository has ever
written.**

The Phase 10 milestone is *"a client-ready PDF from real data, regenerable
byte-identical a year later."* §44 turns it into a test: *"generate a report,
import a new factor set, correct a weight, re-render the report — assert
byte-identical numbers and an unchanged `content_hash`."*

`apps/api/src/modules/exports/pdf.ts` renders through jsPDF. jsPDF stamps every
document with two values that are not derived from its content:

```
/CreationDate (D:20260903072126+08'00')
/ID [ <F3A1…> <F3A1…> ]
```

`/CreationDate` comes from `new Date()` **and carries the rendering machine's UTC
offset**, so the same document rendered on Render and on a laptop differs even
within the same second. `/ID` is 32 hex characters chosen by `Math.random()` on
every call. Rendering identical content twice in the same process produces two
different files — measured, not assumed:

```
a 43b17ae6…5ecf737   3158 bytes
b 1f52696e…1b8f53c8  3158 bytes
equal false
```

So the milestone fails on bytes nobody wrote, for a document whose every visible
character is identical. Worse, it fails *silently*: a reviewer comparing the two
PDFs on screen sees the same document and concludes the test is wrong.

The fix is two lines, and it makes the file better rather than merely passing:

- `doc.setCreationDate("D:YYYYMMDDHHmmss+00'00'")` derived from the row's own
  `generated_at`, fixed at UTC. The document's creation date becomes a fact about
  the report rather than about the machine.
- `doc.setFileId(contentHash.slice(0, 32).toUpperCase())` — the PDF's own
  identifier **is** the first half of the content hash of the snapshot it renders.
  Two files with the same `/ID` are two renders of the same frozen numbers, which
  is what a PDF `/ID` is specified to mean.

Both are `jsPDF` public API. Neither costs anything. **Found by rendering the same
model twice, which is a thing nobody does while implementing a report.**

---

**2. §29.5 tells the client-facing export to render from a `generated_reports`
snapshot, and §29.4's `kind` constraint has no value it can be.**

§29.4: `check (kind in ('SUSTAINABILITY','EVIDENCE_PACK','CLIENT_PERIOD'))`.

§29.5: *"Renders from a `generated_reports` snapshot, never from live data — same
rule as every other report here."* But a BILL-side project statement is not a
sustainability report, not an evidence pack, and not a client-period roll-up.

Built literally, one of two things happens. Either the client export is given no
snapshot and renders live — which is precisely the behaviour the owner decision of
2026-08-17 moved it out of Phase 4 to prevent, and it fails in the direction where
a client re-opening last quarter's statement sees figures produced by rate cards
that have changed since. Or somebody widens a check constraint later, in a
migration whose stated purpose is something else.

**Resolution: a fourth kind, `CLIENT_EXPORT`.** One value in a list, decided now,
rather than a constraint that gets relaxed by whoever hits it first.

---

**3. §29.1's report names the subcontractors, §29.5 forbids naming them, and
`client_visible` is one boolean away from doing it anyway.**

§29.1 section 3: *"Project overview — dates · scope · project manager ·
supervisor · workforce · **subcontractors** · site"*.

§29.5, one subsection later: *"**BILL side only.** No PAY figure, no rate
snapshot, no subcontractor identity — the §4 boundary, in a file that leaves the
building."*

`portal.ts` states the same rule as the reason its types exist at all: *"**who**
actually performed the work — the owner's subcontractors are its own business, and
naming them would defeat the one-hop rule (§3.2)."*

The Sustainability & Completion report is the client's document — §29.1 says it
carries the client's logo and the reporting period, and section 12 ends it with
the client's own signature. So section 3 as written hands the client the supply
chain, and §29.4 gives that document a `client_visible` flag that anybody with
`report.generate` can set.

This is the finding the whole packet exists for, because of *where* the failure
sits. §29.5 says the exclusion must be **structural** — *"so the exclusion cannot
be forgotten by a later edit the way a `select` list can"* — and a single snapshot
serving both audiences makes it exactly the filter §29.5 refuses. The flag is
applied at *disclosure* time to a document assembled for a different reader.

**Resolution, in three parts:**

- `audience text not null check (audience in ('INTERNAL','CLIENT'))`, set at
  generation and **never updatable**.
- `constraint generated_reports_disclosure check (not client_visible or audience =
  'CLIENT')` — a snapshot built for the owner cannot be disclosed at all, by
  anybody, ever, including by a future route that forgets.
- **Two builders, not one builder and a filter.** The CLIENT builder consumes
  `PortalProjectView` / `PortalLineItem` and a new `ClientWorkforceSummary` that
  carries *counts* where the internal one carries names. A provider name is not
  omitted from the client snapshot; it is **unreachable from the types the client
  snapshot is assembled out of**, which is the property §29.5 asked for in words.

The workforce line survives for the client as *"14 people · 4 subcontracted
organisations · 1,284 hours"*. That is the fact §29.1 wanted in a completion
report — the size of the operation — with the identities the one-hop rule protects
removed rather than the section deleted.

---

**4. `content_hash` is specified as "sha256 of the canonicalized snapshot", and
nothing in this repository canonicalizes anything.**

Three separate ways the naive implementation produces a hash that never verifies:

- **`jsonb` reorders keys.** Postgres stores `jsonb` in its own order (by key
  length, then bytewise) and drops duplicates. Hash `JSON.stringify(snapshot)` at
  write time, read the row back, hash it again to check for tampering, and the two
  differ on every row that has more than one key. A tamper detector that fires
  always is a tamper detector that gets switched off.
- **Numbers do not survive the round trip identically.** A `numeric` rendered into
  JSON as `1.50` comes back from `JSON.parse` as `1.5`. Same value, different
  bytes.
- **Key insertion order is a property of the code that built the object**, so a
  refactor that moves one assignment three lines up changes every future hash while
  changing no figure.

**Resolution: one canonical serializer in `packages/shared`** — recursively sorted
keys, numbers normalised through the shortest round-trip form, `undefined` rejected
rather than silently dropped — used by the report writer, the sign-off writer and
the verifier, with a test that asserts a Postgres `jsonb` round trip does not move
the hash.

**The hash itself is not in `packages/shared`.** That package is pure and has no
`node:crypto` — `totp.ts` already established the seam by taking its HMAC as an
injected function. The canonical *string* is shared; the sha256 over it is the
API's.

---

**5. A project can be hard-deleted, and `on delete cascade` takes the client's
signed sign-off and the report they were given with it.**

`DELETE /v1/projects/:id` exists today, is guarded by `assertManager` and nothing
else, and runs `delete from projects where owner_company_id = $1 and id = $2`.

Today it is mostly harmless by accident: `time_logs.project_id` and
`expenses.project_id` have no `on delete` clause, so a project with any recorded
work refuses to delete with a foreign-key violation. Every table added since Phase
7 chose `on delete cascade` — evidence, documents, diary, assets, activities,
calculations — so a project with photographs and no timesheets deletes cleanly and
takes them all.

§29.4 and §34 as written would join that list. §34 is explicit that sign-off rows
are *"**append-only**: a later amendment is a new row pointing at the one it
supersedes, and both are retained with their signatures. This is the
immutable-evidence-plus-audit-history requirement."* Decision #27 promises the
evidence behind them survives too. A cascade contradicts both, and it contradicts
them through a route with no confirmation step and no precondition.

**Resolution: `on delete restrict` on `generated_reports.project_id` and
`client_signoffs.project_id`, with the route refusing first, in a sentence, naming
what stands in the way.** That is the pattern §3.3 already uses for locked rate
cards — *"the route refuses first with an explanation, because a trigger violation
would otherwise reach the caller as a 500."*

Company closure is unaffected, and this was checked rather than assumed:
`COMPANY_STATEMENTS` sets `closed_at` and deletes no company row, so no project is
ever cascade-deleted by the erasure path. The only thing `restrict` blocks is
somebody tidying away a project a client has signed off — which is the thing it
should block.

---

**6. The bytes a signature attests to are reachable only from inside a `jsonb`
blob, which no foreign key can see.**

§34's `evidence_snapshot` freezes *"the completion statement, the work summary, the
asset outcomes and the evidence set as they stood at that moment"*. §29.4's
`snapshot` does the same for a report's selected photographs. Both are `jsonb`. A
`stored_files` row referenced only from inside one is invisible to Postgres:
`stored_files.project_id … on delete cascade` removes it, and the artifact-class
retention sweep that Phase 7 designed and did not build would remove it on a
schedule.

Decision #27 says it must not: *"evidence referenced by an issued report or
sign-off remains addressable with that immutable snapshot."* Nothing enforces
that, and nothing could, because the reference is not a reference — it is a string
inside a document.

**Resolution: `report_file_references`, a real link table written in the same
transaction as the snapshot.** One row per (report or sign-off) × file.

**This is the artifact-lifecycle hold Phase 7 deferred, and it lands with a live
caller rather than as a mechanism waiting for one.** The table is not only a
retention hold for a sweep that does not exist yet. It is the **disclosure grant**
that makes the client's copy work *today*: `FILE_CLIENT_DISCLOSURES` currently
knows about published evidence and published documents, so a photograph inside a
signed completion report that was never individually published to the client
returns 403 to the very client holding the signed document. The registry gains one
entry, and the file becomes readable *because a document the client was given
cites it* — which is a more precise grant than publishing the photograph
generally, and it expires with nothing, because the document does not expire.

---

**7. §29.3 forbids a claim the product lets a customer type into a text box.**

§29.3: *"**Never** describe a report as independently verified unless it is, and
never claim ISO or GHG Protocol certification because the methodology references
those standards."*

`sustainability_settings.report_disclaimer` shipped in 0037 as editable free text
with §29.3's default. Nothing reads it for claims. A company can replace it with
*"independently verified and certified to ISO 14064-1"*, and the product will
freeze that sentence into a snapshot, render it under a client's logo, and hand it
over.

§41's own last line — *"when a product decision and one of these principles
conflict, the principle wins"* — is what makes the guard non-optional rather than a
nice validation.

**Resolution: a pure `findProhibitedClaims` in shared, applied twice.** On save, so
the customer is told immediately and can fix it; and again **at generation**,
because a disclaimer edited before the guard shipped, restored from a backup, or
set by an operator would otherwise be published anyway. The guard is deliberately
narrow — it matches assurance claims about *this report* (`independently
verified`, `third-party assured`, `certified to ISO`, `GHG Protocol certified`,
`accredited`), not the word "verified", which is a legitimate weight confidence
(§25.3) and appears in the product's own vocabulary.

---

**8. §38.2's aggregation must follow `claimed_by_company_id`, and the column points
the other way.**

§38.2: *"Aggregation runs over `client_company_id` (following
`claimed_by_company_id` tombstones so a placeholder that later signed up still
aggregates with its own history)."*

`companies.claimed_by_company_id` lives on the **placeholder** and names the real
company. So the naive `where client_company_id = $1` returns only the projects
booked after the client signed up, and silently omits everything booked against the
placeholder — which is most of the history, and always the older half.

The failure mode is the one §38.1 calls a vanity metric in reverse: *"Projects 32 ·
Total material managed 184.6 t"* quietly becomes 11 and 62.4, on a document the
client reads as their own annual total. It is wrong in the direction that
understates, and nobody notices, because there is no line saying what was left out.

**Resolution: one resolution of the client identity — the company plus every
placeholder claimed by it — computed once and used by every branch of the
aggregation, with the resolved set recorded in the snapshot** so a reader can see
which legal identities the total covers.

---

**9. §29.4 has no unique key, and a report is generated by pressing a button.**

Double-click, or a client retrying a request that actually succeeded, and there are
two `GENERATED` rows for the same project and period, with different `generated_at`
and — once finding 1 is fixed — **identical `content_hash`**. Which is the
document? Both. Neither supersedes the other.

**Resolution: `unique (project_id, kind, content_hash) where status =
'GENERATED'`, and a generate that collides returns the existing row.** This is
better than idempotency: it makes *"regenerate with current data"* honest.
Regeneration after nothing changed produces the same hash, returns the same
document, and creates no `SUPERSEDED` noise — so a `SUPERSEDED` row in the trail
always means a figure actually moved, which is the only reason anyone reads that
trail.

---

**10. A report is the first thing in this product that must survive its own inputs
being corrected, and §23 promises the opposite.**

`project-evidence.md` §13.6, deferred to this phase in as many words. §29.4 says a
re-render never recalculates. §23 says *"amended N times"* appears wherever the
entry appears, *"including in reports"*. A report generated before an amendment can
satisfy exactly one.

**Built as its own packet recommended:** the snapshot records each cited diary
entry's `revision`; the re-render reads the snapshot unchanged; and a live
comparison of one integer adds a banner — *"the site diary for 3 March has been
amended since this report was generated."* The document stays the document it was;
the reader learns there is a newer truth. The alternative that re-renders from live
data breaks §29.4 outright, and the alternative that refuses to amend a diary cited
by a report makes a generated PDF a lock on the record of what happened.

**The same mechanism generalises**, and that is what makes it worth building rather
than special-casing the diary: the snapshot records a `sourceRevisions` map over
every record class it cites — diary entries, asset lines, movements, and the
`carbon_calculations` fingerprint — so *"has anything behind this document
changed?"* is one query against integers rather than a re-derivation that would
itself violate §29.4.

---

**11. The evidence pack's section list names two things Phase 10 does not have, and
one it must not have.**

§29.2 lists *"variations · incidents (only where client-visible)"*. Variations are
§30.1, Phase 11. Incidents have no table anywhere in the plan's DDL.

The wrong answer is a section that renders "None" — a completion pack that asserts
*no variations* on a project whose variations have not been built yet is §41.1's
invented number wearing a different hat, and it is the single most quotable
sentence in a commercial dispute.

**Resolution: sections are a catalog with an `availableFrom` phase**, and a section
whose feature does not exist yet is **absent from the toggle list and absent from
the document** — not offered, not defaulted, not rendered empty. When Phase 11
lands, one entry changes and every report generated after it can carry the section;
every report generated before it keeps its own stored `sections` array, which is
why §29.2 stores the chosen set in the first place.

---

**12. THE FINDING THE BUILD ADDED: §13.6's banner cannot be in the file.**

Not a hole in the plan — a hole in *this packet's own resolution*, and step 7 of
§12 is what found it.

Finding 10 settled that a re-render reads the snapshot and a live comparison adds
a banner. The first implementation put the banner where a reader would want it, on
the cover of the PDF. Then step 7 ran — *"import a new factor set, correct a
weight, recalculate — then re-render. Same bytes"* — and failed, because
correcting the weight bumped `project_assets.revision`, the banner appeared, and
the same report rendered as two different files.

The test was right and the design was wrong. **A live comparison inside a frozen
document makes the document a function of the present**, which is the one thing
§29.4 exists to forbid: two people opening "the same report" a month apart get
different files, and the seal printed in the footer stops describing what is on the
page. The banner is not an annotation on a snapshot; it is a second document.

So the divergence is reported **beside** the document rather than inside it —
`staleSources` and `staleNotes` on the detail response, rendered by the screen that
offers the download, with the sentence that makes it useful rather than alarming:
*the document is unchanged and still shows the figures it was generated with*.
§23's *"amended N times appears wherever the entry appears"* is satisfied where a
person can act on it, and the artefact keeps the promise that makes it worth
having. `RenderInput` now has no field a live fact could occupy, which is the same
kind of answer finding 3 gave one layer up.

Two smaller corrections came from the same run and are worth recording because
neither would have been found by reading:

- **`brandingGrantsFileAccess` had a `LIMIT` on each arm of a `UNION ALL`**, which
  is a Postgres syntax error. Because that function is one entry in a registry
  every signed-URL request walks, the throw took the **whole** download
  authorization down with it — including seven Phase 7 grants that have nothing to
  do with branding. A registry of independent checks is only independent if every
  entry can fail alone.
- **A disclosure notice addressed to a claimed placeholder reaches nobody.** The
  identity is followed *backward* for the read (a client sees documents issued to
  the placeholder they claimed) and *forward* for the notification (the notice goes
  to the tenant that now holds the relationship). Same tombstone, both directions,
  and the second one fails silently: a dispatch with an empty recipient list writes
  no rows and raises nothing.

---

## 1. Persona / job

| Persona | Job | Device |
|---|---|---|
| **Priya**, sustainability lead at a fit-out contractor | The Marina Bay job finished. Produce the Sustainability & Completion report the client's ESG team asked for, check the two headline figures against what the section shows, and send it. | Desktop |
| **Marcus**, project manager | Assemble the completion pack — diary, crew, photographs, waste transfer notes, destination records — with the sections the client's QS actually asked for and none of the ones they did not. | Desktop |
| **Ade**, site supervisor | Stand next to the client's facilities manager on the last day, show them the completion statement on a tablet, and take their signature on glass. | Tablet, on site, poor connectivity |
| **Dana**, the client's facilities manager | Sign for a job. Later, open the document again from her own portal login and get the same numbers she signed for. | Tablet, then desktop |
| **Ruth**, the client's ESG analyst, twelve months later | Take last year's four reports, check the annual total she published, and be able to say where each figure came from. | Desktop |

The load-bearing persona is **Ruth**, and she is why §29.4 exists. Everybody else
is served by a live query. She is not: her question is *"is the number I published
last March the number this system says today, and if not, why not."* A product that
answers her with a recalculation has not answered her.

---

## 2. Resource responsibility

| Resource | Creator | Owner | Reader | Reviewer | Publisher | Corrector | Exporter | Retention owner |
|---|---|---|---|---|---|---|---|---|
| `generated_reports` (INTERNAL) | `report.generate` holder | project-owning company | `report.generate` + `project.read` | **nobody** | n/a — cannot be disclosed | **nobody** | the owner | the company, for the life of the company |
| `generated_reports` (CLIENT) | `report.generate` holder | project-owning company | the owner; the client once `client_visible` | **nobody** | the generator, by setting `client_visible` | **nobody** — a correction is a new row | owner and client | as above |
| the rendered PDF (`file_id`) | the generator | project-owning company | whoever may read the report | — | — | **nobody** | both | held by `report_file_references` |
| files *cited* by a snapshot | their original uploader | unchanged | unchanged, **plus** anyone who may read the citing document | — | — | unchanged | unchanged | **held**: the sweep may not reclaim a cited file |
| `client_signoffs` | `signoff.capture` holder | project-owning company | owner, and the client on the engagement | the **signer**, at the moment of signing | n/a — a sign-off is disclosed by existing | **nobody** — a change is a superseding row | both | life of the company |
| `signature_file_id` | captured on glass | the contractor | as the sign-off | — | — | nobody | both | held |
| the disclaimer text | `sustainability.settings.manage` | the company | everyone who reads a report | the claim guard, on save **and** on generate | — | the company, for **future** reports only | — | frozen per report |

**Three "nobody" rows, and they are the point of the table.**

Nobody reviews a report before it is generated, and adding a review state would be
a lie about what the button does: the figures were reviewed when the work was
recorded, and a report is a rendering of records that have already been through
their own state machines. Nobody corrects a report, for the same reason nobody
corrects a calculation — you correct the inputs and generate a new one, which
supersedes. And nobody corrects a sign-off, because a signature is the one object
in the product that means *a specific person saw specific words at a specific
moment*; editing it in place would make every other signature worth less.

The **reviewer of a sign-off is the signer**, which is not a role in the system at
all. Dana is not a CrewQuo user in the general case — she is a person standing next
to Ade holding a tablet. That is recorded here because it is what makes §34's
`signer_name` / `signer_email` / `signed_ip` / `signed_user_agent` a different kind
of column from every other actor reference in the schema: they describe somebody
outside the tenancy model, captured as evidence rather than as identity.

---

## 3. State machine

### `generated_reports` — three states, two of them terminal

```
              (generate)
                   │
                   ▼
              ┌──────────┐   regenerate-with-current-data   ┌──────────┐
              │GENERATED │ ───────────────────────────────► │SUPERSEDED│
              └──────────┘   (creates a NEW row; this one   └──────────┘
                   │          becomes the old one)
                   │ void (wrong project, wrong period, disclosed by mistake)
                   ▼
              ┌──────────┐
              │   VOID   │
              └──────────┘
```

| Transition | Actor | Rule |
|---|---|---|
| → `GENERATED` | `report.generate` | The only creation path. A colliding `content_hash` returns the existing row rather than creating a second. |
| `GENERATED` → `SUPERSEDED` | `report.generate` | **Never issued on its own.** It is the side effect of generating a successor, in the same transaction, and the successor carries `supersedes_id`. A route that could supersede without producing a replacement would let somebody retract a document without providing the corrected one. |
| `GENERATED` → `VOID` | `report.generate` + a required reason | For a document that should never have existed. **`client_visible` is forced false in the same statement**, because the reason to void is frequently that it was disclosed. |
| `SUPERSEDED` → anything | **nobody** | Terminal. Both rows remain retrievable — §29.4 is explicit. |
| `VOID` → anything | **nobody** | Terminal. The row and its snapshot stay; only the ability to render it as current goes. |

**`client_visible` is not a state**, it is a flag, and it may be flipped both ways
on a `GENERATED` row with the audience constraint from finding 3 standing over it.
Un-disclosing is audited as its own action, exactly as `evidence.unpublished` is,
and for the same reason: *"who stopped sharing it"* is a question somebody asks.

**Concurrency.** Generation takes an advisory lock on the project — the same lock
`recalculateProject` takes, and deliberately the same one, so a report cannot be
assembled from a ledger that is halfway through being superseded. Two generators
racing the same project serialise; the second finds the first's row through the
`content_hash` unique index and returns it.

### `client_signoffs` — no states at all, and that is the design

A sign-off has no lifecycle. It is created, and from that instant it is a fact.
§34's supersession is not a state transition: it is a **new row** whose
`supersedes_id` points at the old one, and the old row is not modified — not its
status, not a flag, nothing. `UPDATE` and `DELETE` are refused by a trigger, not
merely unimplemented in the API, because "append-only" that is enforced by the
absence of a route is enforced by nothing.

The **current** sign-off for a project (or a phase) is derived: the row nothing
supersedes. That is a query, not a column, for the reason `site_diary_entries`
refused an amendment counter — an "is current" boolean beside a supersession chain
is two answers to one question.

**Concurrency:** two supervisors capturing a signature for the same phase at the
same time both succeed, and both rows stand. This is deliberate and it is not a
bug: two people really did sign, and a system that discarded one would be
discarding evidence. The chain shows both as superseding the same parent, and the
UI reports it as a fork that a human resolves by capturing a third.

---

## 4. Permission + scope matrix

Four independent checks per operation. A row that fills one column is a hole.

| Operation | Feature entitlement | Capability | Company edge | Resource scope |
|---|---|---|---|---|
| Generate SUSTAINABILITY | `sustainability_reports` on the **project owner** | `report.generate` **and** `sustainability.read` | active company owns the project | that project |
| Generate EVIDENCE_PACK | `evidence_pack` on the **project owner** | `report.generate` | owner | that project |
| Generate CLIENT_EXPORT | `exports` on the **project owner** | `report.generate` **and** `commercial.read` | owner | that project |
| Generate CLIENT_PERIOD | `client_reporting` on the **generating company** | `report.generate` **and** `sustainability.read` | — | projects the company owns, for that client identity |
| List / read a report | as its kind | `report.generate` | owner | that project |
| Render a report to PDF | as its kind | `report.generate` | owner | that report |
| Set `client_visible` | as its kind | `report.generate` | owner | `audience = 'CLIENT'` only (DB constraint) |
| Void a report | as its kind | `report.generate` | owner | that report |
| **Client reads a disclosed report** | `client_portal` on the **owner** | none — the client is a company, not a role | client on the project's engagement | `client_visible` **and** `GENERATED` |
| **Client downloads its PDF** | as above | none | as above | as above, plus the file reference |
| Capture a sign-off | `client_signoff` on the **project owner** | `signoff.capture` | owner | that project |
| Read sign-offs | `client_signoff` on the owner | `project.read` | owner **or** client on the engagement | that project |
| Edit the disclaimer | `sustainability` on the company | `sustainability.settings.manage` | own company | own settings row |

**The generating-company exception, stated because it is the second time.**
`client_reporting` is checked against the **generating** company rather than a
project owner, exactly as `custom_factors` is (`sustainability.md` §0 finding 9). A
client-period report spans many projects; asking "which project owner's plan?" has
no answer. The company assembling and publishing the roll-up is the one whose plan
pays for it.

**Why `commercial.read` gates the client export and not the sustainability
report.** The client export is money — BILL totals and line items. A supervisor who
may not see what the job is worth on screen must not be able to produce a PDF of
it; the whole reason `commercial.read` was carved out of the Supervisor bundle
would otherwise be undone by a button on the Reports tab. The sustainability report
contains no money at all, which is why Ade can generate one and Priya, who has
`sustainability.read` and no commercial access, is its natural author.

**Why the client's capabilities are never consulted.** A disclosure is made *to a
company*, not to a permission held inside it — the same rule `portal/routes.ts`
already applies and states.

**The scope check that is easy to miss:** `CLIENT_PERIOD` aggregates over projects,
and every one of them must be re-checked against the owning company. A client
identity resolved through `claimed_by_company_id` is *not* a licence to read
projects belonging to a different owner that happen to name the same client.

---

## 5. Domain events

| Event | Transactional payload | Idempotency key | Consumers | Replay |
|---|---|---|---|---|
| `report.generated` | reportId, projectId, kind, audience, contentHash, companyId, actorUserId | reportId | audit; nothing else yet | safe |
| `report.disclosed` | reportId, projectId, engagementId, clientCompanyId, title | reportId | notifications → the client's Action Centre | safe |
| `report.superseded` | reportId, supersededById, projectId, changedFigures[] | supersededById | notifications → the client, **only if the superseded row was disclosed** | safe |
| `signoff.captured` | signoffId, projectId, phase, signerName, engagementId | signoffId | notifications → the owner's managers, and the client | safe |
| `signoff.superseded` | signoffId, supersedesId, projectId, reason | signoffId | notifications → both sides | safe |

**`report.generated` deliberately has no notification consumer.** Generating a
report is a thing the person did on purpose two seconds ago. `report.disclosed` has
one, because that is the moment somebody else acquires a document.

**`report.superseded` notifies only when the superseded row was disclosed**, and
this is the event that earns its payload. If a client was sent a document in March
and the figures behind it moved in June, the client needs to be told — and told
*what moved*, which is why `changedFigures[]` is computed inside the transaction by
diffing the two snapshots rather than left to a consumer that would have to open
both. If nothing was ever disclosed, the whole thing is internal bookkeeping, and
notifying would train people to ignore the channel — the same judgement that left
`sustainability.calculations_superseded` unconsumed.

---

## 6. Notification matrix

| Event | Recipient | Channel | Urgency | Digest / quiet hours | Escalation | Action Centre |
|---|---|---|---|---|---|---|
| `report.disclosed` | the client company's managers | EMAIL | normal | digest-eligible | none | **yes** — "A completion report is available for Marina Bay", `requiresAction: false` |
| `report.superseded` (was disclosed) | the client company's managers | EMAIL | normal | digest-eligible | none | **yes**, `requiresAction: false`, body names the figures that moved |
| `signoff.captured` | the owner's `report.generate` holders, and the client's managers | EMAIL | normal | digest-eligible | none | **yes** — the client's copy is the durable record that they signed |
| `signoff.superseded` | both sides | EMAIL | normal | digest-eligible | none | **yes**, `requiresAction: false`, carries the stated reason |
| a report whose sources changed since generation | **nobody** | — | — | — | — | **no** — it is a banner beside the document (finding 12) |

**The last row is a decision, not an omission.** A banner on the document is the
right place for *"the diary for 3 March has been amended since this was
generated"*; a notification for it would fire on every weight correction on every
project that has ever produced a report, which is a channel nobody reads within a
month. The banner is seen by the person looking at the document, which is exactly
the population that needs it.

**No push, on any row.** Push has no client until 13.9, and none of these is a
thing somebody needs within the minute.

---

## 7. Data classification + retention

| Data | Class | Default visibility | Lifecycle | Legal hold | Export | Deletion |
|---|---|---|---|---|---|---|
| `generated_reports.snapshot` (INTERNAL) | commercial | owner only; `client_visible` structurally forbidden | life of the company | n/a | see below | survives project deletion by `restrict` |
| `generated_reports.snapshot` (CLIENT) | commercial + evidence | owner; client when disclosed | life of the company | n/a | both parties | as above |
| the rendered PDF | evidence | as its report | **held** while its report stands | yes — this is the hold | both parties | not reclaimable by a retention sweep |
| files cited by a snapshot | evidence | unchanged by citation | **held** — decision #27 | yes | unchanged | not reclaimable |
| `client_signoffs.evidence_snapshot` | evidence | owner + client | life of the company | yes | both | append-only; never deleted |
| `signature_file_id` | **personal** — a person's signature | owner + client | held with its sign-off | yes | both | see below |
| `signed_ip`, `signed_user_agent` | **personal** | owner + client | held with its sign-off | yes | both | **never enters a report snapshot** |
| the frozen `disclaimer` | reference | as its report | frozen per row | n/a | both | — |

**A signature is personal data that cannot be erased, and saying so is better than
discovering it.** It identifies a natural person and it is the evidence a
commercial position rests on; the closure decision of 2026-08-20 already resolved
the general form of this conflict — *anonymise the person, preserve the record* —
and a signature is the case where the record **is** the person's mark. A signer who
asks for erasure is told what the product actually does: the sign-off row stands,
because it is the counterparty's evidence of a fact they relied on, and the contact
details captured beside it (`signer_email`) are cleared. That is the same answer §10
of the lifecycle packet gives about a subcontractor's hours, applied to a harder
object rather than exempted from it.

**`signed_ip` and `signed_user_agent` are captured and are never rendered.** They
are anti-repudiation evidence for a dispute, not content; putting them in a document
that gets emailed publishes a person's network location for no benefit. The snapshot
builder cannot reach them — they are not on the type it consumes.

**The company data export is not extended by this phase, and that is deliberate.**
`COMPANY_EXPORT` has not grown since Phase 6: it carries no evidence, no documents,
no diary, no assets and no calculations. Adding `generated_reports` alone would
produce a bundle that exports the report and not the diary it summarises — a
narrower lie than omitting both. The right shape is one follow-on that covers
Phases 7–10 together, and it is recorded here rather than smuggled in.

---

## 8. Offline / conflict policy

**Reports are online-only, and there is no draft.** Generation reads eleven tables,
takes a project lock, and produces a document that must be reproducible; there is
no coherent partial version of that to hold on a device. A generate attempted with
no connection fails and says so.

**Sign-off is the exception, and it is the one place in this phase the Phase 7 sync
contract binds.** Ade is standing on a site with no signal, next to a client who is
leaving. The signature must be capturable now and reconciled later:

| Concern | Rule |
|---|---|
| Client id | The device mints `client_id`; the server dedupes on `(project_id, client_id)`. A replayed capture returns the original row rather than a second signature. |
| Expected version | **Not applicable, and that is a real answer.** A sign-off never updates anything, so there is no version to have expected. What replaces it is the `evidence_snapshot`: the device captures *what was signed for*, and the server stores that, not a re-derivation at sync time. |
| Merge or refuse | Neither. Two captures for the same phase both stand (see §3), because both really happened. |
| Tombstones | None. A sign-off cannot be deleted, so there is nothing to resurrect. |
| What the user sees on refusal | The only refusals are structural — the project is gone, the capability was revoked, the plan lapsed. Each names itself; the drawn signature is kept locally so the capture is not lost with the error. |

**The snapshot is captured on the device, not on the server.** This is the
substantive offline decision, and it inverts the usual instinct. If the server built
the `evidence_snapshot` at sync time, Dana would have signed for the state at 14:02
and the document would freeze the state at 18:40 — after that afternoon's
photographs were uploaded. The signature would attest to a set of evidence the
signer never saw. So the device sends the snapshot it displayed, the server stores
it verbatim, and the server's only additions are the ones the device cannot be
trusted to assert: `signed_at` is clamped to server time, and the content hash is
computed server-side over the canonical form.

---

## 9. Failure matrix

| Failure | Retryable | Partial success | Operator repair | What the user sees |
|---|---|---|---|---|
| Object storage unreachable while storing the rendered PDF | yes | **The report row commits; `file_id` stays null.** | none needed — the next render re-stores it | The document, rendered from the snapshot. No error: the snapshot is the record and the file is a cache. |
| Storage not configured at all (local dev, no MinIO) | n/a | as above, permanently | none | Identical behaviour. The renderer is deterministic, so a snapshot-rendered document is byte-identical to the one that would have been stored. |
| A cited file is missing at render | no | The document renders with the image slot replaced by a named absence | investigate the file id in the response | *"1 photograph referenced by this report could not be retrieved"* — stated on the page, never a blank box. |
| The disclaimer fails the claim guard at generation | no | nothing is written | fix the settings text | Refusal naming the phrase and the sentence it appeared in. |
| Two generators race the same project | yes | one row | none | The second caller receives the first caller's report. |
| A snapshot's `content_hash` does not verify on read | **no** | nothing is served | the row is flagged and the operator is alerted | *"This report's stored contents do not match its seal."* **It is never rendered anyway.** |
| Project deleted while a report or sign-off stands | no | the delete is refused entirely | none — this is correct | *"This project has 2 generated reports and 1 client sign-off, which cannot be deleted."* |
| PDF rendering throws mid-document | yes | nothing is written | — | Refusal. A half-document is never persisted or served. |

**The row that decides the phase's character is the sixth.** A snapshot whose hash
does not verify is a document whose stored contents have changed since they were
sealed. There is exactly one honest response, and it is to refuse — a system that
renders it anyway with a warning has a tamper seal that does nothing, and the
warning is on the screen of the person least able to act on it.

---

## 10. Security / threat model

**Tenant boundary.** Every read resolves the report through its project and the
project through the active company, the way every other project-scoped route does.
The client's read is a separate route with a separate scope, and it filters on
`client_visible and status = 'GENERATED' and audience = 'CLIENT'` **in the `where`
clause** — the boundary is applied where the rows are chosen, so nothing the client
may not see is ever serialised.

**Forged identifiers.** A report id, a sign-off id and a file id are all uuids and
all resolve through their owning record. A client presenting the id of an INTERNAL
report gets a 404, and the 404 is indistinguishable from one for an id that does not
exist.

**The disclosure surface is the whole threat model of this phase**, and it has three
layers on purpose, because a file cannot be un-sent:

1. The `audience` column, immutable after insert.
2. The check constraint that binds `client_visible` to it, so the database refuses
   the combination even if the API is wrong.
3. Two builders over two type families, so the CLIENT snapshot has no field that
   can hold a PAY figure or a provider name.

Any one of the three would probably be enough. All three are cheap, and the thing
being defended is the single event this product cannot recover from.

**Abuse of the generation surface.** A report is the most expensive authenticated
operation in the product after a factor import: it reads eleven tables, renders a
PDF and writes an object. The `content_hash` unique index means a caller who repeats
an identical request does no work at all after the first, which is the cheapest
possible defence and falls out of finding 9 rather than being added for this.

**Signature capture is an unauthenticated person's input.** `signer_name`,
`signer_company`, `signer_role` and `comments` are typed by somebody standing on a
site, and they are rendered into a PDF. They are length-capped, and the renderer
treats every string as text — jsPDF composes a content stream rather than
interpolating markup, so there is no injection surface in the document itself. The
name is **not** used to build the filename; the filename comes from the project,
through `exportFilename`, which is already ASCII-folded and length-capped because it
crosses into a `Content-Disposition` header.

**Privileged access.** Unchanged and still refused: `access.md` §13.3 declined
platform support access, and a report is diagnosed from its own audit row and its
content hash, which is a stronger position than most records are in.

**Secret rotation.** Nothing new. Reports are stored objects behind the same presign
path as every other file.

---

## 11. Analytics contract

| Metric | Definition |
|---|---|
| **Activation** | `report.generated` for a company's first project — the first time the work becomes a document. |
| **Outcome** | `report.disclosed` — a document actually reaching a client, which is the thing the customer is buying. |
| **Funnel** | project has assets → has a carbon calculation → report generated → report disclosed → **sign-off captured**. The last step is the completion of the loop the whole product describes. |
| **Quality** | share of generated reports whose `completeness.pct` is at or above the company's `data_quality_warn_below`. A rising generation count with a falling completeness share is the product being used to publish worse figures faster, which is the failure §41 exists to prevent and the one nobody would otherwise measure. |
| **Second quality metric** | supersession rate within 30 days of disclosure. A client-facing document that gets corrected shortly after being sent is a workflow problem upstream, not a reporting problem. |

**Explicitly excluded from every payload:** any figure from the snapshot, the
disclaimer text, `signer_name`, `signer_email`, `signed_ip`, `signed_user_agent`,
project and client names, and the `content_hash` — a hash is an identifier for
content we have just said we do not send.

---

## 12. Acceptance script

Marina Bay, the Phase 8/9 demo fixture. The script the e2e implements step for step.

1. **Empty.** Priya opens Reports on a project with no assets. The section lists no
   reports and offers `SUSTAINABILITY`; generating produces a document whose
   headline figures are **null, rendered as "not calculated", never 0.00** — the
   §41.1 rule that has held since 9.0, now on a page that leaves the building.
2. **Denied — plan.** A Starter-plan company presses Generate. Refused, naming
   `sustainability_reports`, before anything is read.
3. **Denied — capability.** Ade (Supervisor: `report.generate`, no
   `commercial.read`) generates a SUSTAINABILITY report successfully and is refused
   the CLIENT_EXPORT, naming `commercial.read`.
4. **Generate.** Priya generates the SUSTAINABILITY report. Twelve sections; the two
   headlines side by side and never netted; every figure traceable to a factor and a
   version; the disclaimer frozen verbatim; the Scope 2 basis stated in words.
5. **The seal.** `content_hash` equals the sha256 of the canonical form of the stored
   snapshot **read back out of Postgres**, which is the assertion finding 4 exists
   for.
6. **Byte-identity, immediately.** Render the same report twice. The two buffers are
   equal. *(This step fails on the Phase 4 renderer, which is why finding 1 is
   finding 1.)*
7. **Byte-identity, after the world moves.** Import a new factor set, correct an
   asset weight, recalculate the project — then re-render. Same bytes, same hash,
   same numbers. Assert that the live section now disagrees with the document,
   because that is the whole point. *(This step is what found finding 12.)*
8. **The banner.** Amend a diary entry the report cites. Re-render: **still byte
   identical**, because the banner is reported beside the document and never in it.
   The response carries `staleSources: [{ kind: 'DIARY', label: '2026-03-03',
   revision: 2, currentRevision: 3 }]`, and the screen renders the sentence. §13.6,
   closed.
9. **Regenerate with no change.** Press Regenerate. **No new row** — the hash
   collides and the existing report is returned. Nothing is superseded.
10. **Regenerate after a real change.** Correct a weight, regenerate. A new
    `GENERATED` row; the old one `SUPERSEDED` and still retrievable; the event
    carries the figures that moved.
11. **The boundary.** Generate a CLIENT_EXPORT. Assert on the **stored snapshot**,
    not the rendering: no key anywhere in it matches `pay|cost|margin|provider`, and
    no value equals any assigned subcontractor's name.
12. **Disclosure.** Set `client_visible`. Dana's portal lists it; she downloads the
    PDF; a photograph inside it that was never individually published to her
    **downloads successfully**, through the file reference and not through a
    broadened evidence rule.
13. **Denied — the other client.** A second client company requests the same report
    id. 404, identical to a nonexistent id.
14. **The forbidden claim.** Priya edits the disclaimer to say *"independently
    verified and certified to ISO 14064-1"*. Refused on save, naming the phrase.
    Force the row into the database directly and generate: **refused again**, at
    generation.
15. **Sign-off, offline.** Ade captures Dana's signature with a `client_id` and a
    device-built `evidence_snapshot`. Replay the identical request: one row, not two.
    `signed_at` is the server's clamp.
16. **Correction path.** A second sign-off supersedes the first with a reason. Both
    rows stand; both signatures are retrievable; the current one is derived, not
    flagged.
17. **Append-only, at the database.** `update client_signoffs …` and `delete from
    client_signoffs …` are both refused by the trigger.
18. **The delete that must not succeed.** Delete the project. Refused, naming the
    reports and the sign-off. The report row and its signature still exist.
19. **The period roll-up.** Generate a `CLIENT_PERIOD` report over a client whose
    early projects are booked against a **placeholder** that was later claimed. The
    project count includes both identities, and the snapshot names the identities it
    aggregated.
20. **Mixed factor years.** The same period spans two factor sets. The document says
    so, in a sentence, on the page with the figure.

---

## 13. Decisions

### 1. Does the client-facing Sustainability report name the subcontractors? → **RECORDED — no; counts, and the type cannot hold names**

Finding 3. Recorded rather than asked, because it is not a new judgement: §29.5
already says *"no subcontractor identity"* in a file that leaves the building, and
§3.2's one-hop rule has been the product's most consistently defended boundary since
Phase 1. §29.1's section list predates the client-export decision of 2026-08-17 that
put the two paragraphs next to each other.

**Rejected — name them for a client audience with a per-project toggle:** a toggle
whose default is wrong once is a leak, and the party it leaks about (the
subcontractor) is not the party operating the toggle.

**Rejected — delete the section for client audiences:** the size of the operation is
a legitimate and useful fact in a completion report, and removing it invites somebody
to re-add it later without the reasoning.

### 2. Is the report snapshot single, with disclosure as a filter? → **RECORDED — no; audience is a column, and the two snapshots are built from different types**

Findings 2 and 3. §29.5 asks for the exclusion to be structural in exactly these
words, and names the mechanism: *"Build the renderer's input from the existing
`PortalProjectView` / `PortalLineItem` types … those types structurally exclude the
owner's PAY columns and every provider identity (that is why they exist as a separate
type rather than a filtered `ProjectView`)."*

### 3. A report snapshot versus an amended diary → **CLOSED — the snapshot records the revision; the re-render is unchanged; a banner reports the divergence**

`project-evidence.md` §13.6, deferred to this phase and now built as that packet
recommended, generalised from diary entries to every cited record class (finding 10).
The two rejected alternatives are recorded there and are unchanged.

### 4. Is the artifact-lifecycle hold built now? → **RECORDED — yes, as a link table, because this is the phase that supplies its caller**

Finding 6. Phase 7 refused to build a hold with nothing to hold; PROGRESS records the
refusal and its reason. The link table now has two callers on the day it lands — the
disclosure grant that makes a client's copy readable, and the precondition that makes
the retention sweep buildable in Phase 12 — so the objection no longer applies.

### 5. Do reports and sign-offs enter the company data export? → **RECORDED — not in this phase, and the reason is stated in §7**

Not asked, because the answer is about the export's shape rather than about this
domain: the bundle has not grown since Phase 6, and exporting a report without the
diary it summarises is a narrower lie than omitting both.

### 6. Which plans get `sustainability_reports`, `evidence_pack`, `client_signoff` and `client_reporting`? → **OPEN — seeded per §43's proposal, and the packaging is the owner's**

§43 places reports and the evidence pack from Pro upward and client reporting from
Business upward. Those are proposals in the plan text, and the seed follows them —
unlike `storage_gb` and `factor_sets`, where §43 offers figures for one and none for
the other and the owner explicitly reserved the *numbers*. A feature key is a boolean
with a documented proposal, so following it is implementing the plan rather than
making a pricing judgement.

**`client_signoff` is placed on Starter and up rather than Pro**, which is a
departure worth naming: a sign-off is how a small contractor proves a job is
finished, it costs nothing to serve, and putting the proof of completion two tiers up
would make the free-to-Starter path stop one step short of the thing the customer is
actually selling. Flagged for the owner rather than assumed silently.

### 7. Does the rendered PDF have to exist? → **RECORDED — no; the snapshot is the record and the file is a cache**

§29.4's `file_id` is nullable in the plan's own DDL, and finding 1's determinism makes
the distinction safe: a document rendered from the snapshot a year later is
byte-identical to the one that was stored, so nothing depends on the object having
survived. This is what lets the whole phase work in a local environment with no object
store, and it is why §9's first row is not an error path.

---

## 14. Build order

Eleven steps. The pure core first, for the reason §27.1 gave for Phase 9 and §44
repeats: the seal has to be right before anything is sealed.

- **10.0 — the canonical form and the claim guard.** `packages/shared/src/reporting.ts`
  — canonical JSON (finding 4), the section catalog with its `availableFrom` gate
  (finding 11), the report and sign-off view types, the two audience type families,
  and `findProhibitedClaims` (finding 7). Exhaustive tests **before anything is
  hashed**: key ordering, nested arrays, number normalisation, a simulated `jsonb`
  round trip, and every prohibited claim phrase with its near-miss that must be
  allowed. *Needs no answer from anybody.*
- **10.1 — the deterministic renderer.** Finding 1, in `exports/pdf.ts`, with a test
  that renders twice and compares buffers. **Before the migration**, because it is the
  milestone and because it changes a Phase 4 file that already has callers.
- **10.2 — migration `0043`: `generated_reports`.** The fourth kind (finding 2),
  `audience` with its disclosure constraint (finding 3), `on delete restrict`
  (finding 5), the `content_hash` partial unique index (finding 9), and the four §43
  feature keys.
- **10.3 — migration `0044`: `client_signoffs` + `report_file_references`.** The
  append-only trigger (§3), `restrict` on the project, and the link table that is the
  hold and the disclosure grant (finding 6).
- **10.4 — the snapshot builders.** Two of them, over two type families. The INTERNAL
  builder reads the project, the mass balance, the carbon section, the diary, the
  evidence and the documents; the CLIENT builder reads the portal types and
  `ClientWorkforceSummary`. Both record `sourceRevisions` (finding 10) and both write
  `report_file_references` in the same transaction.
- **10.5 — the twelve sections (§29.1).** Rendered from a snapshot and nothing else.
  The two headline figures never netted; the methodology section auto-generated from
  the citations the ledger already carries; the Scope 2 basis labelled where Phase 9
  labelled it.
- **10.6 — the evidence pack (§29.2)** with its section toggles, the chosen set stored
  on the row, and sections whose phase has not arrived absent rather than empty
  (finding 11).
- **10.7 — the client-facing export (§29.5).** BILL-side only, from the portal types,
  through Phase 4's `model.ts` formatting seam so a figure reads identically in the
  owner's export, the client's export and the portal screen.
- **10.8 — client sign-off (§34).** Signature capture, the device-built snapshot (§8),
  append-only supersession, and the idempotent replay.
- **10.9 — `CLIENT_PERIOD` (§38.2).** The aggregation query with the claimed-identity
  resolution (finding 8) and the mixed-factor-year disclosure. **The query and the
  report kind, not the UI** — §38.2 says the data architecture exists from Phase 10 so
  nothing has to be reshaped in Phase 12.
- **10.10 — the screens.** The project Reports section (generate, list, supersession
  chain, disclose, the staleness banner), the sign-off panel with signature capture,
  and the client portal's Reports list with its download.
- **Milestone:** a client-ready PDF from real data, regenerable byte-identical a year
  later — asserted twice, once immediately and once after a factor set, a weight and a
  diary entry have all moved underneath it.

**Shipped 2026-09-03.** `verify:e2e` is 1,770 checks (from 1,679), the browser suite
147 (from 140), and unit tests 1,475. All eleven steps built; the milestone is
asserted at three levels — `determinism.test.ts` on the renderer, `render.test.ts`
on a frozen snapshot, and §12 steps 6 to 8 against live Postgres.
