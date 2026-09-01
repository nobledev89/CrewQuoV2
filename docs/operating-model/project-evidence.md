# Operating-model packet — project evidence

**Domain:** the Phase 7 record set — project locations, the storage layer,
evidence, project documents and the site diary — together with the two layers
every one of them sits on: the §37 capability model, and the offline/sync
contract decision #22 requires settled *before* these APIs harden.
**Phase:** 7 · **Status:** **adopted** — §13's four load-bearing questions were
answered by the owner on 2026-09-01, every one as recommended; three remain open
and none of them blocks the build. Steps 0, 1 and 3 of §14 — the capability
layer, project locations and the storage service — are shipped, leaving step 2
(the offline contract) before the records themselves
· **Last updated:** 2026-09-01
**Plan refs:** §21 (locations), §22 (evidence + the storage layer), §23 (site
diary), §24 (documents), §37 (capabilities), §39 (`capture_gps_on_evidence`),
§41.1 (no invented numbers), §43 (the new entitlement keys), §44 (the tests this
phase owes), §2377–§2384 (the Phase 7 items themselves).

---

## 0. Why this packet, and why now

Phase 6's remaining bullets are owner actions — a verified mail domain, seller
KYC, the contracting legal entity, a hosted restore. None of them is code. So
Phase 7 is the next thing that gets built, and it is the first phase since
Phase 0 to open a genuinely new *class* of storage: **bytes**. Everything
CrewQuo holds today is rows in one Postgres it controls end to end.

Three things make this a packet that has to exist before the migration rather
than after it.

**The plan says build storage first, and storage is where the newest owner
decision lands hardest.** §22.1 opens Phase 7 with the R2 presign flow. The
decision of 2026-08-31 says *all data is local until CrewQuo is production
ready*, and names the consequence explicitly for Postgres. R2 is hosted. So the
first endpoint of the first item of the phase either contradicts a decision made
a day ago, or it needs somewhere else for the bytes to go — which is a question
with an answer, not an obstacle, but not one to discover halfway through a
migration.

**Decision #22 puts the offline contract here on purpose.** Client ids,
idempotent mutations, expected versions, conflict semantics and tombstones are
cheap to design into an endpoint and expensive to retrofit into a shipped one.
That reasoning survived the mobile deferral of 2026-08-20 unchanged: the field
half moved to 13.0, the contract stayed. It is the one part of Phase 7 whose
cost is entirely a function of when it is written.

**And the phase's first entitlement gate is behind an unanswered question.**
`PROGRESS.md` already lists feature packaging as blocking *"the first production
entitlement gate"* Phase 7 writes. That gate is `storage_gb`, and it is checked
in `POST /v1/files/presign` — the first route of the first item. §14's build
order therefore leads with the work that needs no answer, the way the
observability packet's did.

### What writing it found

Seven things, of which four are §13 questions and three are holes in the
canonical shapes that a careful reader should raise rather than quietly patch.
§0 rule 3 says the DDL in the plan is canonical; it does not say it is
infallible, and the honest response to a contradiction is to name it.

1. **The API cannot sniff a content type it never receives.** §22.1 says bytes
   never pass through the API *and* that content type is sniffed server-side on
   complete. Both cannot be true of the same request. §3 resolves it.
2. **`storage_gb` cannot use the existing meter without changing what
   `projected` means.** `withinLimit(companyId, key, projected = 1)` reads "one
   more of the thing" at every existing call site. A caller who takes the
   default while charging storage charges exactly one gigabyte per upload. §7.
3. **`evidence_uploads_per_month` is the first *windowed* meter.** Every meter
   in `usage.ts` today is a current-state count. A month has a start, the start
   depends on a time zone, and [time.md](./time.md) already settled which one.
   §7.
4. **A free subcontractor who cannot upload evidence cannot do the job.** §43
   proposes "upload only" for Crew, which is nearly right for a reason the table
   does not state — and it is the same shape as the already-settled rule that
   proposing a rate is free while approving it is gated. §13.2.
5. **Whose gigabyte is it?** §22.1 scopes `stored_files` by `company_id` = the
   uploader's active company. On a hiring company's project that bills a free
   subcontractor's plan for the hiring company's evidence. §13.3.
6. **A report snapshot and an amended diary contradict each other by design.**
   §29.4 says a re-render reads the snapshot and never recalculates. §23 says
   *"amended N times"* appears wherever the entry appears, **including in
   reports**. A report rendered before an amendment can satisfy exactly one of
   those. §13.6.
7. **The setting that governs GPS lives in a Phase 9 table.**
   `capture_gps_on_evidence` is a column of `sustainability_settings` (§39),
   built two phases after the capture it governs. §13.7.

---

## 1. Persona / job

Named people, on the devices they actually hold. Every one of them is working in
a **browser** this phase — the 2026-08-20 sequencing decision makes a tablet on
site the interim answer, and the phone is owed by Phase 13.

**Ade — site supervisor, subcontractor company, tablet in a stairwell.** Runs
the day. Photographs a floor before the crew touches it, writes what happened,
confirms who was there, closes the day before leaving. Connectivity is a
building's worth of concrete between him and a mast: not offline in the clean
sense but *intermittent*, which is worse, because a request that is going to
fail takes thirty seconds to admit it. He is on his employer's Crew plan and has
never seen a bill.

**Priya — project manager, hiring company, laptop at a desk.** Owns the project
record. Sets up the location tree once, reviews what came in, decides what the
client is allowed to see, and assembles the set a report is built from. She is
the person the phrase "the evidence pack" means, and the one who discovers on a
Thursday that Friday's photos were tagged to the wrong floor.

**Tunde — client contact, portal only, laptop.** Sees what has been deliberately
published to him and nothing else. He is not a user role (locked decision #7);
he is an engagement position. His entire experience of this domain is a
consequence of somebody else's `client_visible` flag.

**Marta — compliance and document owner, hiring company.** Uploads RAMS,
insurance and waste transfer notes, and cares about one thing this phase builds
and one thing it only prepares: versions that supersede without deleting, and
expiry dates that Phase 12's alert ladder will read.

**Sam — CrewQuo operator.** Has no impersonation and no per-tenant read
([access.md](./access.md) §13.3). Diagnoses a failed upload from `requestId`,
job rows and audit rows, and from nothing else. Everything in §9 is written for
Sam.

---

## 2. Resource responsibility

"Nobody" is a real answer and appears four times below, deliberately.

| Resource | Creator | Owner | Reader | Reviewer | Publisher | Corrector | Exporter | Retention owner |
|---|---|---|---|---|---|---|---|---|
| `project_locations` | Priya (`project.manage`) | project-owning company | anyone on the project, both hops | nobody | n/a | Priya | project-owning company | project-owning company |
| `stored_files` | whoever presigns | see §13.3 | nobody directly — only through the record that references it | nobody | n/a | nobody; bytes are immutable | follows its referencing record | the referencing record's owner |
| `project_evidence` | Ade / Priya (`evidence.upload`) | uploader's company | uploader's company + project-owning company | nobody | Priya (`evidence.publish`) | uploader's company, then Priya | both companies; Tunde only what is published | project-owning company |
| `project_documents` | Marta (`document.upload`) | uploading company | both hops | nobody | Marta (`client_visible`) | a new version, never an edit | uploading company | uploading company |
| `site_diary_entries` | Ade (`diary.write`) | authoring company | authoring company + project-owning company | nobody | via the evidence pack only | Ade while `OPEN`; `diary.close` after, with a reason | authoring company | authoring company |
| `site_diary_attendance` | Ade | authoring company | as the entry | nobody | n/a | as the entry | as the entry | as the entry |

Three notes the table cannot carry:

- **`stored_files` has no reader of its own.** There is no "files" screen and
  there should never be one. A file is reachable only through the evidence,
  document, signature or export row that points at it, and download
  authorization runs against *that* record. A file browser would be a second
  authorization surface over the same bytes, and the weaker of the two would
  decide.
- **Nobody reviews evidence.** This is not an approval workflow and must not
  grow into one. The Phase 3 `DRAFT → SUBMITTED → APPROVED` machine exists for
  money, and a photograph is not a claim on anybody's budget. What Priya does is
  *publish*, which is a disclosure decision rather than a judgement of
  correctness.
- **A subcontractor's diary is its own record, not a draft of the hiring
  company's.** §23's unique key is `(project_id, company_id, entry_date)`. Two
  companies on one site keep two diaries for one day, both attributed, and both
  true.

---

## 3. State machine

### `stored_files` — and the sniff that cannot happen where the plan puts it

§22.1's flow is `presign` → client PUTs → `complete` (*"verifies size/checksum,
flips to `READY`, enqueues derivatives"*), and the same section says **bytes
never pass through the API**. Those two sentences are in tension. Content-type
sniffing is a claim about the first few hundred bytes of an object the API has
not seen, and trusting the client's declared type is the exact hole sniffing
exists to close — so "sniff on complete" without a read sniffs nothing.

The resolution costs one state and no new machinery, because the derivative
worker **already has to download the original**:

```
PENDING ──complete: size + checksum only──▶ SCANNING ──worker: sniff, scan, derive──▶ READY
   │                                            │
   │                                            └── type / size / scan refused ──▶ FAILED
   │
   └── never completed, presign older than 24h ──▶ EXPIRED   (swept — §7)
```

`READY` is therefore set by the worker rather than by the request. That is a
departure from a canonical contract, so it is §13.5 rather than a decision taken
here. The consequence a UI has to absorb is that an upload is not instantly
displayable — which is true regardless, since the `WEB` and `THUMB` variants do
not exist until the same worker makes them.

`EXPIRED` is a fifth status the plan's `check` constraint does not list. Without
it, a presign that is never completed is a row claiming bytes that do not exist,
and §7's meter counts them forever.

### `project_evidence` — no workflow, one disclosure flag

There are no states. `client_visible` is a boolean, and flipping it is the only
transition that carries weight: **publishing is a disclosure, and unpublishing
does not undo it.** Tunde may already have downloaded the file. The screen says
so at the point of publish instead of implying a retraction is available, and
the audit row is written on both edges.

### `project_documents` — a chain, not an edit

A new version inserts a row with `supersedes_id` pointing at the old one, which
stays and is hidden by default. There is no update path for `file_id`. A
document whose bytes can be replaced in place is a document whose history is a
claim rather than a record, and waste transfer notes are precisely the documents
somebody is later asked to prove.

### `site_diary_entries`

```
(absent) ──first write──▶ OPEN ──close (diary.close)──▶ CLOSED
                                                           │
                             amend (diary.close + a required reason)
                                                           │
                                                           ▼
                                      CLOSED, revision n+1, "amended N times"
```

**There is no reopen.** An amendment is a recorded change to a closed entry,
which is a different and more honest object than a day that was closed becoming
open again. Every post-close write is a `record_revisions` row with before,
after, changed fields and a **required** reason — `0009`'s table, already built
and already carrying commercial agreements — and the amendment count is derived
from `max(revision)` rather than stored. A counter column beside a revision
table would be two answers to one question, and they would disagree.

### Concurrency

| Race | Rule |
|---|---|
| Two devices close the same day | `update … where status = 'OPEN'` returning; the loser is told the day is already closed and by whom, and its pending edits become an amendment it must supply a reason for |
| Two writers editing one `OPEN` entry | Last write wins **per field**, from the expected-version contract in §8. A diary has fourteen independent free-text fields, and whole-row last-write-wins would silently delete a colleague's paragraph |
| Two uploads of identical bytes | Different `bucket_key`, so both exist. Deduplication by `checksum_sha256` is deliberately **not** done: two identical photographs of one wall taken an hour apart are two pieces of evidence |
| A replayed `presign` | Returns the *same* `PENDING` row and the same key — §8. This is the one idempotency rule whose absence orphans bytes rather than merely duplicating rows |
| A location deleted while evidence is being tagged to it | Delete is refused whenever any reference exists; retirement (`active = false`) is the path, and a retired location keeps rendering on the records that already point at it |

---

## 4. Permission + scope matrix

Four independent checks per operation: **feature entitlement** (does the plan
sell it?) · **capability** (may this person do it?) · **company edge** (are these
two companies in a relationship?) · **resource assignment** (is this person on
*this* project?). A row filling only one column is a hole.

§37's rule is load-bearing and repeated here because it is the one a later
route will get wrong: **a capability never widens company scope or the one-hop
rule.** Scope is checked first and independently, and `hasCapability` can only
ever narrow what `policies.ts` has already allowed.

| Operation | Feature | Capability | Company edge | Resource scope |
|---|---|---|---|---|
| Create / edit a location | **none** — corrected 2026-09-01; see below | `project.manage` | project-owning company only | the project |
| Read the location tree | none — it is structure, not content | `project.read` | owner or one-hop provider | the project |
| `POST /v1/files/presign` | `storage_gb` limit + the feature of the record it is for | the record's own upload capability | the company the file will be charged to (§13.3) | the project, when `project_id` is set |
| `POST /v1/files/:id/complete` | none — re-checking here would strand paid-for bytes | must be the presigning membership | same | same |
| `GET /v1/files/:id/download` | none | the referencing record's read capability | whichever hop the referencing record allows | the referencing record |
| Upload evidence | see §13.2 | `evidence.upload` | owner or one-hop provider | assigned to the project |
| Edit another person's evidence metadata | `project_evidence` | `evidence.manage` | own company's rows; the project owner may re-tag any | the project |
| Publish evidence to the client | `client_portal` (existing key) | `evidence.publish` | project-owning company **only** | the project |
| Upload / supersede a document | `project_documents` | `document.upload` / `document.manage` | owner or one-hop provider | the project |
| Write a diary entry | `site_diary` | `diary.write` | owner or one-hop provider | assigned to the project |
| Close a day | `site_diary` | `diary.close` | the authoring company only | the entry |
| Amend a closed day | `site_diary` | `diary.close` + a reason | the authoring company only | the entry |
| Read a counterparty's diary | `site_diary` on the reader | `project.read` | one hop, engagement `ACTIVE` | the project |

**Locations carry no feature entitlement, and this row is a correction rather
than a design.** It first read `project_evidence`, written before step 1 was
built. A location is *structure*, not content: it is consumed by evidence,
documents, the diary, assets and the schedule, each of which carries its own
gate. Gating the structure as well would mean a company whose plan includes
scheduling but not evidence cannot lay out the floors its schedule refers to —
one feature key silently deciding another feature's usability. The packet was
changed to match what shipped, rather than the code bent to match the packet.

**Publishing is the project owner's alone, and that is not an oversight.**
`client_visible` decides what a third company sees. A subcontractor able to set
it could disclose to the hiring company's client, on the hiring company's
project, over the hiring company's commercial relationship. The provider's lever
is uploading; the disclosure lever belongs to whoever owns the client
relationship — the same asymmetry §4 of the plan already draws around BILL rates.

**The default bundle mapping is what makes this shippable in one migration.** A
null `bundle_key` derives from the membership role (`OWNER`/`ADMIN` → Admin,
`MANAGER` → Project Manager, `MEMBER` → Worker), so every existing membership —
seeded, invited, demo-fixture, prototype — keeps exactly the permissions it has
today and nothing regresses on the day the table lands. The capability layer is
therefore additive twice over: no existing route changes behaviour, and no
existing company sees a difference until somebody deliberately assigns a bundle.

---

## 5. Domain events

Every event is written in the same transaction as its state change (§36,
decision #25), through the existing outbox.

| Event | Payload | Idempotency key | Consumers | Replay |
|---|---|---|---|---|
| `evidence.batch_uploaded` | project, company, count, category set, evidence date range | `(batch_client_id)` | notifications (digest), analytics | Safe — the projection is a count, not an increment |
| `evidence.published` | project, evidence ids, engagement, actor | `(project_id, batch_client_id, 'publish')` | client notification, audit | Safe — `client_visible = true` is idempotent |
| `file.scan_failed` | file id, reason class, referencing record | `(file_id)` | uploader notification, operator queue | Safe |
| `diary.closed` | project, company, entry date, supervisor, attendance totals | `(diary_entry_id, 'closed')` | hiring-company notification, Phase 10 report inputs | Safe |
| `diary.amended` | entry, revision number, changed fields, reason | `(diary_entry_id, revision)` | hiring-company notification, report staleness marker (§13.6) | Safe — the revision number is in the key |
| `document.superseded` | new + old document ids, category | `(document_id)` | notification where `client_visible` | Safe |
| `document.expiring` | document, days remaining | `(document_id, threshold_days)` | **Phase 12** ladder — the event ships now, the consumer later | Safe |

**`evidence.uploaded` is deliberately not an event.** Forty photographs is one
act by one person, and forty events is forty notifications, forty audit rows and
a projection nobody can read. The batch is the unit, keyed by the client-supplied
batch id from §8, and the individual rows are reachable from it.

**`document.expiring` ships without its consumer, on purpose.** Phase 12 owns the
90/60/30/14/7 ladder, but the event's *shape* is decided by the record built
here, and a shape decided later would be decided by whoever is writing the alert
rather than by whoever knows what a document is.

---

## 6. Notification matrix

The rule from [notifications.md](./notifications.md) holds without exception:
email and push are never the only copy of a task, and the durable Action Centre
item is the record.

| Recipient | Trigger | Channel | Urgency | Quiet hours / digest | Action Centre item |
|---|---|---|---|---|---|
| Priya (project owner) | `evidence.batch_uploaded` by a provider | in-app + email | low | **digest** — batched to one line per project per day | "12 photos added to Floor 3" |
| Priya | `diary.closed` by a provider | in-app + email | normal | respects quiet hours | "Ade closed Tuesday 3 March" |
| Priya + the authoring company's owners | `diary.amended` | in-app + email | **normal, never digested** | respects quiet hours | "Tuesday 3 March amended — reason: …" |
| Tunde (client) | `evidence.published` | in-app + email | normal | respects quiet hours | "8 photos shared on Riverside Fit-Out" |
| The uploader | `file.scan_failed` | in-app + email | normal | respects quiet hours | "3 of 40 files could not be stored" |
| Marta | `document.superseded` on a document she owns | in-app | low | digest | "RAMS v3 replaced v2" |
| Sam (operator) | scan-failure rate above threshold | operations screen only | — | — | queue row beside the existing depths |

**An amendment is never digested and that is the whole point of the row.**
Changing a closed day is the one act in this domain that alters a record
somebody may already have relied on. A digest is a promise that nothing is
urgent, and this is precisely the thing that is.

**Nobody is notified about their own action**, which sounds obvious and is the
bug that reaches production: Ade closing a day must not be told that a day was
closed, and Priya re-tagging her own photographs must not generate a batch
notification to herself.

---

## 7. Data classification + retention

| Class | What | Default visibility | Lifecycle |
|---|---|---|---|
| **Evidence** | photographs, videos, scans and their metadata | private to the uploading company and the project owner | retained with the project; never purged by `audit_retention_days` |
| **Commercial** | document references (PO numbers, WTNs), diary commercial fields | both hops | as the project |
| **Personal** | `uploaded_by_user_id`, `supervisor_user_id`, attendance names, GPS | company-internal; GPS off (§13.7) | anonymised by closure, never deleted — see below |
| **Reference** | location trees, categories, capability definitions | company | indefinite |

**Deletion anonymises the person and preserves the record** — the decision of
2026-08-20, and this domain is the one that tests it hardest. The three parts,
in order of increasing difficulty:

1. `uploaded_by_user_id` and `supervisor_user_id` are foreign keys and become a
   tombstoned identity. Easy, and already the pattern.
2. Free-text attendance `name` is a colleague's name typed by hand into somebody
   else's record. It is not the closing user's to remove, and the closing user's
   name may appear in it. Attendance rows naming the departing person are
   anonymised; the rest are untouched, because a subcontractor cannot edit the
   hiring company's diary by leaving.
3. **A photograph cannot be anonymised**, and this is the honest limit. If Ade
   is in the frame, closing his account does not remove him from the hiring
   company's evidence of a floor it has already invoiced for. The account-closure
   copy on `/profile` already refuses to overclaim — *"the hours you logged
   remain, without your name on them"* — and this domain needs the same sentence
   written for files before the first photograph is stored, not after somebody
   asks.

**The meters, which are the finding.**

`storage_gb` cannot reuse the existing guard unchanged. `withinLimit(companyId,
key, projected = 1)` means "one more of the thing" at every call site in the
repository. Storage's unit is a gigabyte, and a caller taking the default would
charge one gigabyte per upload. Two rules follow, and both belong in code rather
than in a comment:

- The meter **sums bytes** (`stored_files.byte_size` where `status in ('PENDING',
  'SCANNING','READY')`) and converts once, at the boundary. `PENDING` counts —
  otherwise a client can presign a thousand files and upload them all before any
  completes, which is the check being asked the wrong question. `EXPIRED` is why
  that does not leak permanently.
- The call site passes a **fractional** projection derived from the declared
  size. The guard already returns `number` from `getUsage` rather than an
  integer, so no signature changes; what changes is that one key's `projected`
  is not a count, and the test that pins it should say so by name.

`evidence_uploads_per_month` is the first **windowed** meter in the product.
Everything in `usage.ts` today — `internal_seats`, `active_subcontractors`,
`clients` — is a current-state count with no clock in it. A month needs a start,
a start needs a zone, and [time.md](./time.md) already answered which zone:
the company's IANA zone, not the server's and not the browser's. The window is
`[first instant of the company's current month, now)`, and the acceptance script
in §12 crosses a month boundary in a non-UTC zone on purpose.

---

## 8. Offline / conflict policy

This is 7.7, and decision #22 requires it settled here even though the phone
that needs it most is Phase 13. It is exercised from the browser: two tabs
racing one record, a replayed mutation, a stale expected version, and a
tombstone against a row somebody else has edited.

**Client ids.** Every mutating request carries a client-generated `clientId`
(uuid v4, minted on the device before the network is consulted) and, for
uploads, a `batchClientId` shared by the selection. The server stores it and
treats a repeat as the same act. Ade's tablet losing signal mid-PUT and retrying
must not produce two photographs, and — the case that actually bites — must not
produce two `PENDING` rows and two bucket keys, of which one is a byte-charge
for an object nothing references.

**Expected version.** Mutations against an existing record carry the `revision`
they were composed against. The server refuses a stale one with `409` and the
current record in the body, so the client can show a real diff rather than "try
again". Diary entries merge **per field** on the `OPEN` path (see §3); every
other record refuses outright, because a photograph's caption has no meaningful
merge.

**Tombstones.** A delete is a tombstone with a `deleted_at` and a revision, not
a missing row, so a device holding a stale copy can be told the record is gone
rather than inferring it from a 404 — which is indistinguishable from a
permission failure and, on an intermittent connection, from a timeout.

**Timestamps: exactly one of the three is evidence.** `created_at` is server
truth. `captured_at` is what the device's clock and EXIF assert, and a device
clock is settable by the person holding it. `evidence_date` is a human's claim
about which project day the file belongs to. In a dispute these are not
interchangeable, so the UI must not render them as one field with three names,
and the export manifest labels which is attested and which is claimed. This is
the detail an offline queue makes matter: a queued upload delivered on Monday
for a Friday photograph has all three genuinely different, and the naive
implementation is the one that stamps `created_at` and calls the other two
decoration.

**What the user sees when a change is refused.** Never a silent discard. The
queued item stays visible with its reason, and the two reasons are distinguished
because the recoveries differ: *"the day was closed while you were offline —
your notes are here, add a reason to amend"* is a different sentence from
*"Priya changed this caption — keep yours or hers"*.

---

## 9. Failure matrix

| Failure | Class | Partial success | Operator repair | What the user sees |
|---|---|---|---|---|
| Storage unreachable at presign | retryable | none — nothing was created | queue depth + `file.scan_failed` rate on the operations screen | "Can't start the upload. Your photos are saved on this device." |
| PUT fails for 3 of 40 files | terminal for those 3 | **the other 37 stand** | none needed | the batch shows 37 stored, 3 retryable, and the retry is one button |
| `complete` never called | expires after 24h | the row is `EXPIRED` and stops metering | sweep job row | the file reappears as retryable in the queue |
| Sniff finds a mismatch | terminal | the rest of the batch stands | none — this is the guard working | "This file isn't the type it claims to be and wasn't stored." |
| Derivative generation fails | retryable, then terminal | `ORIGINAL` is kept and displayable | dead-letter row names the file | the photo shows without a thumbnail rather than not at all |
| Diary close races another device | terminal | the loser's text is preserved | none | "Ade closed this day at 17:04. Amend it with a reason?" |
| Location delete refused | terminal | none | none | names *what* references it, with a link, and offers retirement |

**A partial batch must never lose the files that worked**, and that is the row
worth building the whole failure surface around. Ade is standing in a stairwell.
An "upload failed" that discards thirty-seven successful photographs is a
product that trains him to stop using it, and he is the persona the phase exists
for.

**`ORIGINAL` outliving its derivatives is deliberate.** A missing thumbnail is
cosmetic; a missing original is the evidence gone. So the failure path degrades
toward keeping bytes, never toward tidiness.

---

## 10. Security / threat model

**The tenant boundary is on the referencing record, not on the file.** A
presigned GET is a bearer capability with a URL for a body: anyone holding it
has the bytes, and it cannot be recalled inside its lifetime. So they are minted
short (minutes, not hours), only after the same authorization check that governs
the record pointing at the file, and never listed in bulk — a gallery returns
one signed URL per visible tile on demand, not a signed URL per row of the
table.

**Forged identifiers fail closed and reveal nothing.** A file id from another
tenant answers exactly as a file id that never existed. §44 already requires
this test class; this domain adds file, location, diary-entry and document ids
to it.

**Upload is the first surface a customer's bytes enter the platform**, which
makes it the first surface worth abusing. Four controls, all cheap, and each
placed where it can actually run:

1. Content type is sniffed from the object's own leading bytes by the worker
   that downloads it anyway (§3), never trusted from the client.
2. Size is capped per kind, checked at presign against the declared size and
   again at complete against the stored object.
3. The bucket key is derived server-side from the file id — it is never accepted
   from the client, or a caller chooses a key under another tenant's prefix.
4. Rendering is by `content_type` from the sniff, with a `Content-Disposition`
   that refuses to let an uploaded HTML or SVG file execute against the app's
   own origin. Evidence is served from a storage origin, never from the app's.

**Malware scanning is not in this phase and should be stated rather than
implied.** The sniff catches a mislabelled file, not a malicious one, and a
customer downloading another customer's uploaded document is the transmission
path that matters. §13 does not raise it as a question because there is nothing
to decide yet — it is a cost with a provider attached, and it belongs with the
launch gate's attestations rather than with a migration.

**GPS is a worker-surveillance surface before it is a data field**, which is why
§39 makes it a governed setting rather than a checkbox, and why §13.7 refuses to
capture it at all until that setting has somewhere to live.

---

## 11. Analytics contract

| Metric | Event | Definition |
|---|---|---|
| Activation | `evidence.batch_uploaded` | first batch on a project |
| Outcome | `diary.closed` | days closed ÷ days with any activity |
| Funnel | presign → complete → `READY` | where uploads die, by stage |
| Quality | scan-failure and expiry rate per company | the number that says the upload path is broken before support does |
| Quality | amendment rate on closed days | a high rate means Close Day is being reached too early in the workflow |

**Excluded from every payload, without exception:** captions, notes, all
fourteen diary free-text fields, attendance names, filenames, document titles
and references, GPS coordinates, and any bucket key. Filenames look harmless and
are not — `Ridley_Redundancy_Consultation_Floor3.pdf` is a fact about somebody's
job, typed by a customer, and it would travel as an ordinary string field.

The `scrubEvent` allowlist (`packages/shared/src/scrub.ts`) already rebuilds
error events from named fields rather than filtering known-bad keys, so a field
invented by this domain cannot reach Sentry by default. That protection covers
error events only. **Analytics and log lines are a separate surface with the same
rule**, and the same rule means the same shape: an allowlist that is a named
list of fields, not a denylist somebody has to remember to extend.

---

## 12. Acceptance script

Ade and Priya, end to end, including every path §19.5 requires. This is what the
phase's `verify:e2e` and browser suites implement.

1. **Empty.** Priya opens a new project's Evidence section. It says there is
   nothing yet and names the one action that helps, without a card, an
   illustration or an invented count.
2. **Structure.** She builds a location tree — Building → Floor 3 → Room 3.12 —
   and is refused at depth 5 with the cap named, refused when she tries to make
   Floor 3 a child of Room 3.12 with the cycle named, and refused when she
   deletes a floor that has evidence on it, with a link to what references it
   and an offer to retire it instead.
3. **Denied.** Ade, a Worker bundle, sees the tree read-only and gets a 403 with
   a reason on the create route — proving the capability check and not merely a
   hidden button.
4. **Capture.** Ade selects 40 photographs, applies category `BEFORE`, Friday's
   `evidence_date` and Floor 3 to the whole selection at once, then overrides
   three of them to Room 3.12. Uploaded on Monday: all three timestamps differ
   and the record shows all three, distinctly labelled.
5. **Rejected.** One file is a `.exe` renamed `.jpg`. It lands `FAILED` after
   the sniff, the other 39 are `READY`, and the batch says exactly that.
6. **Offline / retry.** The connection drops mid-batch. Three PUTs fail and are
   replayed with their original client ids: no duplicate rows, no orphaned
   bucket keys, and the storage meter afterwards equals the sum of the 39 files
   that exist.
7. **Limit.** A company at its `storage_gb` ceiling is refused at presign, with
   the figure and its unit, before it uploads anything. A company at its
   `evidence_uploads_per_month` ceiling is refused too — and the window is
   asserted across a month boundary in a company whose IANA zone is not UTC.
8. **The diary.** Ade writes Friday's entry, confirms attendance prefilled from
   the schedule and the approved time logs rather than retyping it, and closes
   the day. Priya is notified. A second device tries to close the same day and
   is told who closed it and when.
9. **Correction.** Ade amends the closed entry. The reason is required — a
   422 without one — a `record_revisions` row carries before, after and changed
   fields, the entry reads "amended 1 time" everywhere it appears, and the
   hiring company is notified outside the digest.
10. **Publish.** Priya publishes 8 of the 39 to Tunde. Tunde sees 8. The
    unpublished 31 are absent from his response body, not hidden in it — asserted
    on the serialised payload, not on the rendered page.
11. **The money boundary holds.** Nothing in Tunde's evidence response, and
    nothing in the provider's, carries a PAY rate, a margin or a
    `resolved_rate`. Same assertion class the data export earned on 2026-08-21,
    and it is proved by breaking it: adding the field to the query must fail the
    check.
12. **Export.** Ade requests his personal export and Priya requests the
    company's. Both bundles' manifests explain what is included, what is
    referenced rather than embedded, and why — §13.4.
13. **Closure.** Ade closes his account. His name leaves the attendance rows
    naming him and leaves `uploaded_by_user_id`; the 39 photographs and Friday's
    diary remain on the hiring company's project, intact and attributed to a
    tombstoned identity.

---

## 13. Decisions — four answered 2026-09-01, three still open

Seven were raised. **The four that decide what gets built were answered by the
owner on 2026-09-01, every one as recommended.** Each still carries the
alternatives that were rejected, because a decision whose options are lost reads
a year later like something nobody considered. The three that remain are marked
open below; none of them blocks step 3, and §14 says how each is being treated
in the meantime.

### 1. Where do evidence bytes live before production? → **ANSWERED (owner, 2026-09-01): a local S3-compatible store, R2 unchanged as the production target**

The 2026-08-31 decision says all data is local until CrewQuo is production
ready, and R2 is hosted. But R2 is already the decided store (§2) and nothing
about that needs revisiting — the question is only what runs *now*.

**Recommended:** MinIO as a service in `infra/docker-compose.yml`, exactly as
local Postgres stands in for the hosted database. The application code targets
the S3 API, which both speak, so the driver is configuration rather than an
abstraction layer; there is one endpoint variable and one credential pair. The
gotcha to write down before it costs an afternoon: **the API signs URLs against
the endpoint the browser must reach**, so a container-internal hostname produces
signatures that verify perfectly and resolve nowhere.

**Rejected — provision R2 now:** it is the same act as standing up the hosted
database the decision defers, and it would put customer-shaped evidence in a
third-party bucket before the subprocessor disclosure on `/privacy` is anything
but a preview.

**Rejected — a filesystem driver behind an interface:** cheaper today and
strictly worse, because presigned upload and download *are* the design. A local
driver that streams bytes through the API exercises none of the flow that ships,
and the first real R2 request would be the first test of it.

### 2. Feature packaging for the Phase 7 keys (§43) → **ANSWERED (owner, 2026-09-01): capture is free, the record is the project owner's entitlement**

The already-open owner decision, now with a concrete shape. §43 proposes "upload
only" for Crew, which is nearly right without saying why.

**Recommended:** a Crew-plan company may always upload evidence and write a
diary **on a project owned by somebody else**, and consumes the *owner's*
entitlement when it does. Its own projects need `project_evidence` /
`site_diary` / `project_documents` on its own plan. This is not a new principle;
it is the settled one with the sides swapped. `commercial-agreements.md`
established that **proposing is free and approving is gated**, because the Crew
plan exists so a subcontractor can work for nothing (§5B) — and a subcontractor
who cannot photograph the floor cannot do the work the hiring company is paying
for.

**Rejected — gate on the uploader's plan:** it makes a free subcontractor
useless to a paying customer, which is the failure the Crew plan was invented to
prevent.

**Rejected — free for everybody:** storage has a bill attached, and the one axis
with a real marginal cost is the one place a free tier must have a ceiling.

The tier numbers themselves (`storage_gb` 1/25/200/1000/unlimited,
`evidence_uploads_per_month`) are a proposal in §43 and need confirming or
replacing; they are the only part of this that is a pricing judgement rather
than a product rule.

### 3. Whose storage does an upload consume? → **ANSWERED (owner, 2026-09-01): the project-owning company**

Follows directly from (2), and needs stating separately because it decides a
column's meaning. §22.1 scopes `stored_files` by the uploader's active company.

**Recommended:** the meter runs over the **project owner** — `project_id →
projects.company_id` — with company-level files (null `project_id`) charged to
`company_id`. The evidence is for the project, the project owner is who sells
the record and who publishes it to their client, and the alternative bills Ade's
free plan for Priya's evidence pack.

`stored_files.company_id` then means *who uploaded it*, which is still worth
recording and is no longer the billing key. Left as a distinct column rather
than repurposed: two facts, two columns, and collapsing them is how the meter
starts disagreeing with the audit trail.

### 4. Does a data export include the files themselves? → **ANSWERED (owner, 2026-09-01): manifest and authorized links, not bytes**

The export built on 2026-08-21 generates per request with no stored bundle and
no expiry clock, deliberately — so it stays protected by an authorization check
on every read instead of once, at issue.

**Recommended:** the bundle carries a row per file — id, filename, type, size,
checksum, the record it belongs to — and a link that mints a short presigned GET
**at the moment it is followed**, under the same authorization as any other
download. Consistent with the existing design, and it keeps a 4 GB evidence
library from being a 4 GB response.

**Rejected — bytes in the zip:** it streams gigabytes through an API whose
storage design says bytes never pass through it, and it turns one bundle into a
permanent unauthenticated copy of an entire project's evidence the moment
somebody emails it on.

The manifest must say this in prose, the way it already explains withheld
columns. An unexplained absence reads as a bug or as evasion, and *"where are my
photos"* is the first question a careful reader will have.

### 5. Is `READY` set by the request or by the worker? → **OPEN — built as recommended: the worker**

A departure from §22.1's canonical contract, raised rather than taken (§0 rule
3). The reasoning is §3's: the API cannot sniff bytes it never receives, and the
derivative worker downloads the original regardless. `complete` verifies size
and checksum and moves the row to `SCANNING`; the worker sniffs, scans, derives
and sets `READY` or `FAILED`.

**Rejected — trust the declared content type:** it is the hole sniffing exists
to close.

**Rejected — have the API range-read the first bytes at complete:** technically
sufficient for magic numbers and it splits validation across two places, one of
which cannot do the scan. Two validators disagreeing about one file is worse
than one validator running slightly later.

### 6. A report snapshot versus an amended diary → **OPEN — bites in Phase 10, not here**

§29.4 (Phase 10) says a re-render reads the snapshot and never recalculates —
so a client reopening a document a year later sees the numbers they were shown.
§23 says *"amended N times"* appears wherever the entry appears, **including in
reports**. A report rendered before an amendment can satisfy exactly one.

**Recommended:** the snapshot records the diary revision it captured. Re-render
reads the snapshot unchanged — no recalculation, no rewriting of history — and a
live comparison of one integer adds a banner: *"the site diary for 3 March has
been amended since this report was generated."* The document stays the document
it was; the reader learns there is a newer truth, which is the thing §23 is
actually protecting.

**Rejected — re-render from live data:** breaks the guarantee §29.4 exists for.

**Rejected — refuse to amend a diary cited by a report:** makes a generated PDF
a lock on the record of what happened, and the amendment path exists precisely
because what happened is sometimes recorded wrong.

Flagged now rather than in Phase 10 because the column that makes it possible is
`site_diary_entries`' revision, and it is free to include here.

### 7. GPS in Phase 7, when its governing setting is a Phase 9 table → **OPEN — capturing nothing, which needs no decision to proceed**

§22.2 gives evidence `gps_lat` / `gps_lng` / `gps_accuracy_m`. §39 governs
capture with `capture_gps_on_evidence`, in `sustainability_settings` — a table
Phase 9 creates.

**Recommended:** the columns exist and stay null. No capture, no EXIF location
extraction, no UI. Phase 9 brings the setting and the notice, purpose, access
rule and retention period §39 requires before the flag may be turned on. §41.1's
principle applied to a different kind of number: a coordinate captured without
the governance is a worker-location record nobody decided to keep.

**Rejected — a Phase 7 company setting, migrated to §39 later:** two homes for
one flag, and the migration lands after the coordinates already exist.

**Rejected — strip EXIF location silently:** it is the right *default* and the
wrong *silence*. If a photograph carries location the platform discards, the
person who uploaded it should be able to find that out.

---

## 14. Build order

§14's convention: the items needing **no** §13 answer go first, so the phase
does not stall at step 1 waiting on the owner. **Step 0 shipped on 2026-09-01
doing exactly that, and the four answers landed the same day — so steps 1, 2 and
3 are all buildable now and the ordering below is a dependency graph rather than
a queue.**

| Step | What | Blocked on |
|---|---|---|
| **0** ✅ | **Capability layer (§37, item 7.1) — shipped 2026-09-01.** `capabilities`, bundles, items, `memberships.bundle_key`, overrides, `resolveCapabilities`, `hasCapability` in `policies.ts`. Null bundle derives from role, so no existing membership changes behaviour. Every later route in this phase needs it, and retrofitting authorization is the expensive kind. | **nothing** |
| **1** ✅ | **Project locations (§21, item 7.2) — shipped 2026-09-01.** Tree, depth cap 4, cycle rejection, retire-not-delete, and the reference check written as one function later phases extend rather than a hand-written list per phase — assets (Phase 8) and schedule assignments (Phase 11) both point here. | **shipped** |
| **2** | **The offline/sync contract (7.7).** Client ids, idempotency, expected versions, per-field diary merge, tombstones, the three timestamps. Settled before the evidence APIs harden, which is decision #22's whole reason for putting it in this phase. Exercised from the browser. | **nothing** |
| **3** ✅ | **Storage service (§22.1, item 7.0) — shipped 2026-09-01.** `stored_files`, presign → PUT → complete → scan → READY, `sharp` derivatives, authorized presigned downloads, the byte meter. | **shipped 2026-09-01** |
| **4** | **Evidence (§22).** Records, batch upload and batch metadata, gallery / timeline / table, filters, sticky selection. | step 3 |
| **5** | **Documents (§24).** Categories, `supersedes_id` versioning, expiry dates, and `document.expiring` emitted for Phase 12's ladder. | step 3 |
| **6** | **Site diary (§23).** Entry, structured attendance, prefill from schedule and time logs, Close Day, post-close amendment with a required reason and the amendment count everywhere. | steps 0, 1, 2 |
| **7** ✅ | **Retro-fit the Phase 3 expense receipt upload — shipped 2026-09-01 with step 3.** `expenses.receipt_url` has been null since `0004` with the comment *"upload deferred"*. It is the smallest real consumer of the storage service and therefore its best first proof. | **shipped** |

**Steps 0–2 are also the answer to "what does Phase 7 do while the owner is
deciding".** They are three of the eight items, they need no bucket and no
entitlement key, and every one of them is a dependency of something later —
which is the same property that made the observability packet's step 1 and step
2 shippable before its §13 was answered.
