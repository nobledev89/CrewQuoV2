# Operating-model packet — observability & data lifecycle

**Domain:** what the platform records about its own running, who may read it, and
for how long — request/tenant/job correlation, error tracking, health and
readiness, the scheduler that runs the deferred work, and the other half of the
same question: what a customer may take out, what happens when they ask to be
gone, and what the platform promises about losing data it has already accepted.
**Phase:** 6 · **Status:** **adopted** — §13's questions were put to the owner on
2026-08-20 and every recommendation was taken; §14 steps 1 and 2 are shipped
· **Last updated:** 2026-08-20
**Plan refs:** §10 (deployment), §19.5 (this packet's shape), §41.7 / §962
(data classification + retention), §787 and §91 (the observability line —
"Sentry across all three apps; structured request logging; `/healthz`"),
§2348 (the Phase 6 bullet this answers).

---

## 0. Why this packet, and why now

The Phase 6 bullet reads like plumbing. It is not, and the reason is a decision
somebody already made: **[access.md](./access.md) §13.3 refused platform support
access.** No impersonation, no per-tenant operator read — settled, in writing,
with its alternatives recorded. That decision is defensible only if the sentence
that follows it is true: *"a customer problem is diagnosed from audit rows and
logs."*

So logs are not a convenience here. They are the entire support capability, the
whole of what an operator has when a customer says "it says something went wrong".
That reframes every question below: this is not "should we add monitoring", it is
"the product has already promised a support model, and this is the packet that
either delivers it or admits it does not exist".

Writing it found four things, all verified against the tree at `4798cc4`, and the
first is the most serious thing in this document.

**1. Nothing schedules the deferred work in production.** Three one-shot jobs
exist — `purge-audit`, `purge-auth` and `work` — and the reasoning for making them
one-shot is written down and correct: an external scheduler restarts a dead job,
whereas a `setInterval` in the API stops the moment that process falls over and
does nothing at all if the service scales to zero. But `render.yaml` declares a
web service and a database and **no cron of any kind**, and neither does CI. So in
a deployed environment today: the outbox never drains, so no notification is ever
delivered; the audit retention purge never runs, so a retention *entitlement*
customers are sold is enforced by nothing; and the auth attempt and session prunes
never run. The substrate is correct and inert — which is precisely the fault
`workers.cli.ts` was written to fix one layer down, its own comment noting that
"until this existed, nothing called `runOutboxBatch`". The caller got built. The
thing that calls the caller did not.

**2. An unhandled error is logged without the request that caused it.**
`errorHandler.ts` ends at `console.error('[api] unhandled error:', err)` — a stack
trace and nothing else. No request id, no route, no user, no company. There is no
request-logging middleware at all, and no correlation id anywhere in the API (the
only `requestId` in the codebase is company-creation's approval-request id, an
unrelated domain concept). So the operator's one permitted diagnostic tool cannot
answer *which tenant hit this*, *how often*, or *was it the person who just
emailed us* — and the customer has no reference number to quote, because nothing
generates one.

**3. There is no Sentry.** The plan names it twice (§91, §787). The string does not
appear in the repository.

**4. Today's recovery promise is "lose everything, recover never".** `render.yaml`
runs `plan: free` Postgres, and its own comment says the tier is time-limited and
**deleted** when it expires. No point-in-time recovery, no backup schedule, no
restore rehearsal. This is honest for a pre-launch blueprint and cannot survive
the first real customer, which makes it a §13 question with a price attached
rather than a to-do.

None of these is a code defect to be quietly fixed. Each is a promise the product
has already made — a support model, a retention entitlement, a durable delivery
substrate — with nothing behind it.

---

## 1. Persona / job

Named people with real jobs, not roles.

**Ola, a platform operator, at 02:40.** Holds one thing: a customer's email and
the sentence "it says something went wrong". Cannot log in as them, cannot read
their records, and by §13.3 of the access packet never will. Needs to get from
that sentence to a cause. Desktop, good connectivity, tired.

**Priya, the engineer on call.** Needs to know whether the thing that just paged
her is one tenant or all of them, whether it is still happening, and whether the
last deploy caused it. Her first question is always *how many* and her second is
always *since when* — and neither is answerable from a stack trace.

**Dana, a company owner, mid-audit.** Her client's auditor has asked for
everything CrewQuo holds on a project. She is not leaving; she needs a defensible
extract. Later — a different job, and the one that matters here — she decides to
stop using the product, and wants her company's data out and then gone.

**Sam, a subcontractor's field worker.** Logged hours through the phone for
eighteen months. Asks for his personal data, and then to be deleted. **The hours
he logged are simultaneously his employer's payroll record and the hiring
company's evidence of work it has already been invoiced for.** Sam is the reason
this domain is not a settings screen.

**Nobody in this packet is a Crew-plan field user with a new task.** The persona
that logs hours from a car park gets no new screen and no new friction, exactly as
the access packet held.

---

## 2. Resource responsibility

One row per resource. "Nobody" is the important answer in several places.

| Resource | Creator | Owner | Reader | Corrector | Exporter | Retention owner |
|---|---|---|---|---|---|---|
| A request log line | the API, per request | the platform | platform operators | **nobody** — append-only by construction | nobody | the platform (short) |
| An error event | the API or a worker | the platform | platform operators | nobody | nobody | the platform |
| A job run record | the scheduler | the platform | operators, via `/v1/admin/operations` | nobody | nobody | the platform |
| `audit_logs` | the mutation that caused it | the acting company | that company, gated on `audit_visibility`; a counterparty's client-visible slice | **nobody** | the owning company | the company's `audit_retention_days` |
| `platform_audit_logs` | a platform action | the platform | platform operators | **nobody, ever** — immutable by trigger | nobody | **nobody — no expiry** |
| A database backup | the host | the platform | **nobody routinely** — restore is an incident action | nobody | nobody | the platform |
| An export bundle | the requesting company/person | the requester | the requester alone | n/a | n/a | short, and deliberately so (§7) |
| A deletion request | the account holder or company owner | the platform | the requester, and operators | the requester, until it executes | nobody | permanent — the *record* of a deletion outlives the data |

Two rows deserve their own sentence.

**A deletion request is a resource with a permanent record.** The data goes; the
fact that somebody asked for it to go, and that the platform did it, is evidence
and stays. A deletion with no record is indistinguishable from a data loss.

**Nobody routinely reads a backup.** A backup nobody has ever restored is a
belief, not a capability, which is why §13.4 asks for a *rehearsal* rather than a
backup schedule.

---

## 3. State machine

### An export request

`REQUESTED → BUILDING → READY → (DOWNLOADED) → EXPIRED`, with
`BUILDING → FAILED` and a terminal `EXPIRED` reached from `READY` or
`DOWNLOADED`.

Asynchronous, and not because building is slow. An export is the one operation
that assembles a whole tenant's records into a single object, and doing that
inside a request means the surface that produces the most sensitive artifact in
the product is also the one that holds a connection open for a minute. It goes
through the outbox like everything else.

`DOWNLOADED` is a state rather than a counter, and `EXPIRED` is reached on a
clock regardless of whether anybody fetched it — see §7 for why a bundle's
lifetime is measured in hours.

### A deletion request

`REQUESTED → SCHEDULED → EXECUTING → COMPLETED`, with `CANCELLED` reachable from
`REQUESTED` and `SCHEDULED` only, and `EXECUTING → FAILED_PARTIAL`.

**`SCHEDULED` is a cooling-off period and it is load-bearing.** Deletion is the
one irreversible action a customer can take, and the two things that most often
precede it are a mistake and somebody else holding the account. A delay with an
unconditional email to the holder turns both into a recoverable event; without
it, the notification arrives after the only copy is gone. This is the same shape
as the access packet's operator reset — the holder is told unconditionally,
because an action taken on your account that you learn about afterwards is
indistinguishable from a compromise.

`FAILED_PARTIAL` is a real state, not a defensive one. A deletion spans many
tables and, under §13.1's likely answer, must *preserve* some rows while
anonymising others. A run that stops halfway has left the account in a state no
screen describes, and it needs to be visible as that rather than reported as
either done or untouched.

### Concurrency

Both are single-flight per subject, enforced as a partial unique index on
(subject, non-terminal state) rather than a check-then-insert — the same
correction `money-boundary.md` §3 made. Two clicks are one request. A deletion
request and an export request may coexist, and the deletion waits: **taking your
data out is the reasonable thing to do immediately before asking to be gone**, and
a policy that refused the export would push people to abandon the account instead
of closing it.

---

## 4. Permission + scope matrix

Four independent checks per operation. A row filling one column is a hole.

| Operation | Feature entitlement | Capability / role | Company edge | Resource scope |
|---|---|---|---|---|
| Read own request-log correlation id | none — it is in the error envelope | any authenticated caller | n/a | their own request only |
| Read platform logs / error events | n/a | `is_super_admin` **+ a confirmed second factor** (access.md §13.1) | n/a | **aggregate and metadata only — never tenant records (§13.3)** |
| Read `/v1/admin/operations` queues | n/a | `is_super_admin` + factor | n/a | queue depth, job state, dead letters — payloads redacted per §7 |
| Request a personal-data export | none — never sold | the person, for themselves | n/a | their own person-record only |
| Request a company-data export | gated (§13.2) | OWNER or ADMIN | own company | own company's records; **counterparty PAY/BILL excluded structurally** |
| Request personal deletion | none | the person, for themselves | n/a | their own person-record |
| Request company deletion | none | **OWNER only**, step-up re-authenticated | own company | that company |
| Cancel either | none | the original requester, or an operator with a reason | own | that request |
| Restore from backup | n/a | **nobody through the product** — host console, incident-only, platform-audited | n/a | whole database |

Three notes.

**Requesting an export is not entitlement-gated for a person, and may be for a
company.** A person's own data is not a feature; charging for it would make a
legal obligation a paid add-on. A company-wide commercial extract is a product
capability and can reasonably sit behind a plan — which is §13.2's question.

**A company export must exclude the counterparty's side structurally, not by
filter.** The provider-never-reads-client-BILL rule (§4 of the plan) is realised
today by computing BILL only for the owning side. An export is a new reader of the
same data and the single easiest place to leak it: a well-meaning `select *` over
`time_logs` on the client's side hands the provider a column it has never been
allowed to see. The export must be built from the same shared readers the API
uses — `projects/billing.ts` and the summary path — rather than from fresh
queries, for the same reason the portal and the owner's summary were made to share
theirs: two queries over one boundary are two places for it to differ.

**Restore is not in the product and should never be.** A route that restores a
database is a route that destroys the current one.

---

## 5. Domain events

Through the existing outbox (`durable-delivery.md`), which is what makes any of
this replayable.

| Event | Transactional payload | Idempotency key | Consumers | Replay |
|---|---|---|---|---|
| `export.requested` | subject kind + id, scope, requester | request id | export builder | safe — rebuilds, same content |
| `export.ready` | request id, byte size, expiry | request id | notification | safe |
| `export.failed` | request id, terminal reason | request id | notification, operator queue | safe |
| `deletion.requested` | subject, scheduled-for instant, requester | request id | notification | safe |
| `deletion.cancelled` | request id, who cancelled | request id | notification | safe |
| `deletion.completed` | subject, what was anonymised vs removed, counts | request id | notification, platform audit | **safe but inert** — a second run finds nothing to delete, which is the correct no-op |
| `job.run_failed` | job name, attempt, terminal reason | job name + scheduled instant | operator queue | safe |

`deletion.completed` carries **counts, not contents**. A payload describing what
was deleted, sitting in an outbox with a retention of its own, is a copy of the
thing somebody asked to have removed.

---

## 6. Notification matrix

| Event | Recipient | Channel | Urgency | Quiet hours | Action Centre |
|---|---|---|---|---|---|
| Export ready | requester | inbox + email | normal | respects | yes — the download lives here |
| Export failed | requester | inbox + email | normal | respects | yes |
| Deletion requested | **the account holder, unconditionally** | inbox + email | **urgent** | **overrides** | yes — carries the cancel action |
| Deletion imminent (one day out) | the account holder | inbox + email | urgent | overrides | yes |
| Deletion completed | the holder, at a **contact address captured before the deletion ran** | email | urgent | overrides | no — there is no inbox left to put it in |
| Company deletion requested | every OWNER and ADMIN of that company, plus every counterparty with a live engagement | inbox + email | urgent | overrides | yes |
| Job run failing | platform operators | operator queue | urgent | n/a | yes |

Three things this table decides.

**Deletion notices override quiet hours.** The notifications packet's rule is that
quiet hours may delay an intrusive channel but may never hide a task. A deletion
notice is the one message whose entire value is arriving before a deadline.

**"Deletion completed" needs an address captured beforehand.** Obvious once
stated, and exactly the kind of thing found by writing the table rather than the
code: the address is inside the thing being deleted.

**Counterparties with a live engagement are told when a company starts deleting
itself.** Their evidence is about to change shape, and the alternative is a client
discovering it when a project view goes empty. What they are told is that the
relationship is ending — not the reason, which is the deleting company's business,
the same line the access packet drew around an operator's internal note.

---

## 7. Data classification + retention

The heart of the packet.

| Class | Examples | Default visibility | Lifecycle |
|---|---|---|---|
| **Operational** | request logs, error events, job runs, metrics | platform operators only | **short and fixed — 30 days**, and not customer-configurable |
| **Personal** | name, email, device labels, push tokens | the person; their company's admins for membership facts | with the account, then §13.1 |
| **Commercial** | rates, invoices, margins, agreements | the owning company; the counterparty only where an edge grants it | **kept — it is the other side's record too** |
| **Evidence** | time logs, expenses, submissions, approvals, `audit_logs` | as today | the company's `audit_retention_days`; **cross-tenant rows survive one side's deletion (§13.1)** |
| **Reference** | plans, features, role catalog, IANA zones | everyone | permanent |
| **Platform evidence** | `platform_audit_logs` | operators | **no expiry, immutable by trigger** |

### What a log line may contain, and what it may never

A log line is **operational**, and the way it stops being operational is by
accumulating personal data one useful field at a time. So the rule is positive
rather than prohibitive — a log line carries exactly:

- the request id, and the job id where there is one
- `company_id` and `user_id` — **identifiers, never the email or the name**
- method, route *template* (`/v1/projects/:id`, never the populated path), status,
  duration
- the error code and class

And never: request or response bodies, headers, tokens, secrets, `kid` values
paired with anything, email addresses, or a populated path — because a populated
path is a record of which resources a person touched, which is the movement log
the access packet's §7 already refused to build in the session table. Refusing it
there and rebuilding it in the log directory would be the same mistake with a
different storage engine.

**Operational retention is 30 days and is not a customer setting.** It is not
their data; it is the record of the platform serving them, and a per-tenant
retention dial on it would mean a support capability that varies by plan — an
operator unable to diagnose a Crew customer's problem because the evidence aged
out under a cheaper policy.

### The asymmetry that makes deletion hard

An export bundle lives **hours, not days**, and expires on a clock whether or not
anybody downloaded it. It is the single most concentrated object the platform can
produce — a whole tenant's commercial history in one file, reachable by whoever
holds a link. Everything else in this table is protected by an authorization
check on every read; a bundle is protected once, at issue.

And the rule §13.1 exists to settle: **an evidence row inside an engagement
belongs to two companies at once.** Sam's time log is his employer's payroll
record and the hiring company's proof of an invoiced hour. Deleting it on Sam's
request destroys a record the other company is legally obliged to keep and never
agreed to lose. Deleting nothing makes "delete my data" a lie. This is the
question, and it is not answerable by a retention column.

---

## 8. Offline / conflict policy

**Not applicable, and the reason is worth one line rather than a blank heading.**
Nothing in this domain is authored on a device. Exports and deletions are requested
from a connected session and completed by a worker; logs are written server-side.
There is no client id, no expected version and no merge rule, because there is no
offline author to conflict with.

The one adjacent case is real and belongs to another packet: a field device that
has been offline may hold an unsynced time log belonging to a person whose
deletion has since run. `SCHEDULED`'s cooling-off window is what makes that
survivable in the common case; beyond it, a sync arriving for a deleted subject is
refused and dead-lettered rather than resurrecting the subject, and the operator
queue is where it becomes visible. Silently recreating a person who asked to be
gone is the worse failure.

---

## 9. Failure matrix

| Failure | Retryable? | Partial success | Operator repair | What the user sees |
|---|---|---|---|---|
| Export build fails mid-way | yes | discard the partial — never a half bundle | replay the outbox row | "we could not build it, we are retrying" |
| Export storage unreachable | yes | request stays `BUILDING` | existing dead-letter replay | as above |
| Deletion fails part-way | **no — never blind-retried** | `FAILED_PARTIAL`, with what completed recorded | operator queue, then a deliberate resume | "in progress, we will confirm" |
| Scheduler stops running | n/a | **everything deferred silently stops** | see below | **nothing at all** — this is the problem |
| Log sink unreachable | no | drop, and count the drop | metric | nothing |
| Error tracker unreachable | no | drop | metric | nothing |
| Restore needed | n/a | n/a | host console, incident runbook, platform-audited | a status page |

Two rows carry the weight.

**A failed deletion is never blind-retried.** Retrying a partially-completed
mutation across a dozen tables is how a preserved evidence row becomes a deleted
one on attempt three. It stops, it says where it stopped, and a person resumes it.

**"Nothing at all" is the current answer to a stopped scheduler, and that is
finding 1.** Every deferred promise in the product fails silently and identically
to everything being fine: an undrained outbox looks like a quiet week, and an
unrun retention purge looks like a company with a long retention. The fix is not
only to schedule the jobs but to make their *absence* loud — a job that has not
reported a successful run inside its expected interval must raise, because the
failure mode of scheduled work is not a crash, it is silence. A dead man's switch
is the only alarm that fires when the thing that would have alarmed is the thing
that died.

---

## 10. Security / threat model

**The export bundle is the highest-value object in the product**, and the threat
is not a clever attack — it is a link that outlives its purpose. Rules, all four
load-bearing: it is fetched through an authenticated route that re-checks the
requester rather than a bearer URL; the object store is never public; the bundle
expires on a clock, not on download; and issuing one writes an audit row on the
owning company's trail, because an owner should be able to see that somebody
extracted everything.

**Deletion is a weapon, and the target is the counterparty.** If deleting a
company removes the engagement rows, then a provider mid-dispute can destroy the
client's evidence of the hours it billed — a data-integrity attack dressed as a
privacy request, requiring no exploit. §13.1's answer is what closes it, and the
requirement is stated here regardless of which option wins: **one tenant's
deletion may never remove another tenant's record of a shared fact.**

**Log injection.** Fields that reach a log line are structured values, never
interpolated strings. A company named `\n[api] unhandled error:` should not be
able to forge a log entry, and a name is customer-supplied text.

**PII in error events is the failure mode of adopting a tracker.** Sentry's value
is the context it captures automatically, and that default is exactly wrong here:
request bodies, headers and local variables are the three richest sources of
personal and commercial data in the process. Adoption means scrubbing before send
— an allowlist of the §7 fields, not a denylist of known-bad keys, because a
denylist is a list somebody has to remember to extend every time a field is added.

**A third-party tracker is a processor.** Error payloads leaving the platform is a
data-protection fact with a subprocessor disclosure attached, not merely a
technical choice, which is why it is §13.3 rather than a library decision.

**Operators gain nothing from this packet.** Everything here is aggregate,
metadata or the platform's own record of its own running. §13.3 of the access
packet is not relaxed by a single row above, and the correlation ids exist
precisely so that diagnosis does not require reading records.

---

## 11. Analytics contract

Error rate and p95 latency per route template; unhandled-error count by release;
job success rate and oldest-unclaimed-age per queue; **time since each scheduled
job last reported success** (the dead man's switch from §9); export requests
completed and their build duration; deletion requests, cancellations and
completions per month; and the age of the oldest un-purged expired audit row —
which is the metric that would have caught finding 1.

Explicitly excluded from every payload: email addresses, names, populated paths,
request bodies, and any monetary amount. A metric that carries a rate is a
commercial leak into a system with weaker access control than the product.

**Stated plainly, because every other packet's §11 is also unbuilt:** no analytics
contract in this repository has an implementation. They are forward-looking
contracts, and this one is too — except the dead man's switch, which is not
analytics but an alarm, and belongs in the build order.

---

## 12. Acceptance script

Personas: **Ola** (operator), **Priya** (on call), **Dana** (owner), **Sam**
(field worker).

1. **Correlated.** A request that 500s returns an error envelope carrying a
   reference. The same reference appears in the log line, along
   `company_id`, `user_id`, route template, status and duration — and no email,
   no name, no populated path, no body.
2. **Quotable.** Dana reads that reference to Ola. Ola finds the one request,
   and reaches the cause **without reading a single one of Dana's records**.
3. **Aggregate.** Priya answers "how many tenants, since when" from a count, not
   by opening rows.
4. **Job-correlated.** A notification that failed to send is traceable from the
   request that caused it, through the outbox row, to the delivery attempt and its
   provider error.
5. **Alarming.** With the scheduler stopped, something raises **within one
   expected interval** — asserted by stopping it, which is the only way to test a
   dead man's switch.
6. **Empty.** A brand-new account requests an export and gets a valid, near-empty
   bundle rather than an error. The empty case is the one most likely to have been
   built as a crash.
7. **Bounded.** A company export contains that company's side and nothing of the
   counterparty's — asserted by *searching the bundle* for the counterparty's PAY
   figures and the provider's BILL figures and finding neither.
8. **Expiring.** A ready bundle stops being fetchable after its window, whether
   or not it was downloaded, and a second person holding the same link never gets
   it at all.
9. **Cooling off.** Dana requests company deletion, is emailed immediately, every
   other owner and admin is told, every counterparty with a live engagement is
   told, and she cancels it. Nothing was deleted.
10. **Denied.** An ADMIN cannot request company deletion; an OWNER cannot without
    step-up; a MEMBER cannot export the company; and none of them can read a log.
11. **Erased, and not.** Sam requests personal deletion. His personal fields are
    gone and he cannot sign in. **The hours he logged still price and total
    exactly as before on the hiring company's approved project** — attributed to a
    withdrawn person rather than to nobody, and the invoice does not move by a
    cent. This is the assertion that either proves §13.1's answer or exposes it.
12. **Recorded.** The deletion is in `platform_audit_logs`, immutable, with what
    was removed and what was preserved as counts — and the record outlives the
    data.
13. **Recoverable.** A restore rehearsal brings the database back into a scratch
    environment from a backup nobody has touched, and the elapsed time is written
    down next to the promise it is meant to keep. **Asserted by doing it, once,
    before launch** — a backup nobody has restored is a belief.

---

## 13. Decisions — answered 2026-08-20

Four, each put to the owner with options costed and a recommendation, in the
pattern the access packet used. **All four recommendations were taken.** Recorded
with their rejected alternatives, because a decision whose options are lost reads
a year later like something nobody considered.

Two of them changed what gets built rather than how, and one — the scheduler host
— was not in this list when the packet was drafted. It was added because §14 step 1
turned out to need a *deployment* answer even though it needed no *design* one, and
a build order whose first item is blocked on an unasked question is a build order
that stalls at step 1.

### 1. What does deletion actually do to a cross-tenant evidence row? → **(a)**

**Answered: anonymise the person, preserve the record.** Sam's time log is his
employer's payroll record and the hiring company's proof of an invoiced hour. The
options as put:

- **(a) Anonymise the person, preserve the record. → Taken.** Personal fields are
  overwritten, the account cannot sign in, and every evidence row survives
  attributed to a withdrawn person. Money never moves. **Recommended.** It is the
  only option that keeps both promises: the person stops being identifiable, and
  the other company's records stay intact. Its cost is honest and must be stated
  to the requester rather than buried — *the hours you logged remain, without your
  name on them*, because a promise of total erasure that the product then cannot
  keep is worse than a narrower promise kept exactly.
- **(b) Hard-delete everything touching the person.** Clean to describe, and it
  destroys a counterparty's evidence of work it has already paid for, retroactively
  changes closed invoices, and hands anybody a way to damage a company they are in
  dispute with. Rejected unless the owner takes it deliberately.
- **(c) Refuse deletion while any evidence exists.** Defensible for a company,
  indefensible for a person: it makes "you may not leave" the answer to somebody
  who logged one hour eighteen months ago.

The same question for a *company* has a different shape and got its own half of
the answer: **(a) for a person, (a) plus a live-engagement precondition for a
company** — a company with live engagements must settle or hand over before it may
go. Both taken.

**What this commits the product to saying, and it must be said before the button
rather than after it:** *the hours you logged remain, without your name on them.*
A promise of total erasure the product then cannot keep is worse than a narrower
promise kept exactly, and the place that distinction gets lost is a confirmation
dialog that says "this cannot be undone" and nothing else.

### 2. Is a company-wide data export a paid capability, and what format?

**Still open** — the only one of the five not put to the owner, because it changes
nothing until §14 step 5 and the recommendation has no dependency on the other
four. Recorded here so it is asked rather than assumed when that step arrives.

- **Recommended: personal export always free and unconditional; company export
  available on every paid plan, and a machine-readable bundle (JSON plus CSV per
  table) rather than a document.** A person's own data is a legal obligation and
  charging for it makes an obligation an upsell. A whole-company commercial
  extract is a product capability, and gating it on *any* paid plan rather than a
  high tier keeps it from being a retention lever — an export somebody must
  upgrade to get is a hostage.
- Rejected: PDF. It is the format that looks like the answer and cannot be
  re-imported, re-checked or diffed by the auditor who asked for it. The existing
  per-project PDF/XLSX exports already serve the "give my client a document" job
  and are not this.
- Rejected *for now*: a scheduled recurring export. No one has asked.

### 3. Sentry, or structured logs only? → **Sentry, scrubber first**

**Answered: adopt it.**

- **Taken: Sentry for the API and web, with a strict allowlist scrubber and no
  request bodies, and treated as a disclosed subprocessor.** The
  plan already named it twice; the reason to confirm rather than assume is that
  §10 makes it a data-protection decision. What it buys that logs do not is
  grouping and release attribution — Priya's "how many, since when" is one screen
  in a tracker and a log-aggregation project otherwise.
- The alternative — structured logs to the host's aggregator only — is genuinely
  cheaper and loses exactly that. Choose it if third-party processing is
  unwelcome; it is a defensible answer, not a wrong one.
- Mobile deferred to Phase 13 either way.

**The ordering is part of the decision, not an implementation note.** The scrubber
ships before the library, because the failure mode of adopting an error tracker is
not "we did not adopt it" — it is one release sending request bodies to a third
party before anybody notices, and that is unsendable back.

### 4. What RPO/RTO does CrewQuo promise, and at what cost? → **paid tier + PITR**

**Answered: a paid Postgres tier with point-in-time recovery, an RPO measured in
minutes and an RTO stated in hours, plus one rehearsed restore before launch and
one per quarter after.**

Today: no promise, and a free database the host deletes when it expires. The
options were tiers, not designs, and the number had to be chosen before it could
be published:

- **Taken: paid tier with PITR, RPO in minutes, RTO in hours, rehearsed.** The
  rehearsal is the part that cannot be bought.
- Cheaper: daily snapshots, RPO 24 hours. Honest only if published — "you may
  lose a day's timesheets" is a thing a construction customer must be told before
  they enter a month of them.
- The number is the owner's to set because it is a cost, and the only wrong answer
  is publishing one nobody has tested.

**The free tier is a separate problem from the promise, and it is the more urgent
half.** "We have not decided our RPO yet" is a gap; a database the host deletes on
a timer is data loss with a date on it. Raising the tier is not waiting for the
rehearsal.

---

### 5. What runs the scheduled jobs? → **GitHub Actions cron**

**Answered: GitHub Actions `schedule`.** Not in the original four — added because
step 1 needed a deployment answer even without a design one.

- **Taken: a scheduled workflow in the repository that already runs CI.** Free, no
  new host, no new account, and the credential story is one repository secret. Its
  costs are real and are recorded in §9 rather than discovered later: GitHub's
  scheduled events are **best-effort and skew under load**, so a five-minute cron
  is "usually five minutes"; a `schedule` trigger is **disabled automatically
  after 60 days without repository activity**, which is a silent stop, and the
  dead man's switch is what makes that survivable rather than terminal; and the
  runner reaches the production database from outside its network, so it needs an
  external connection string and TLS.
- Rejected: **Render cron jobs.** Better timing, native retry, same network as the
  database, and a per-job cost. The right answer once there is revenue; not worth
  paying for before there is.
- Rejected on the packet's own reasoning: **a long-running worker with an interval
  loop.** It fails silently the moment the process dies and does nothing at all if
  the service scales to zero, which is the whole argument for the jobs being
  one-shot in the first place.

**This decision is why step 1 ships the switch and the scheduler together.** Every
option above can stop quietly — the chosen one has a documented way of doing so on
day 61 — so a scheduler without an alarm for its own absence would move the
failure rather than fix it.

## 14. Build order

Ordered by severity from §0 and §9, not by convenience. **Step 1 is not a feature
and should ship before the decisions are answered** — everything else in Phase 6
is already relying on it.

1. ~~**The scheduler, and the alarm that fires when it stops.** Whatever the host
   offers, running `work`, `purge-audit` and `purge-auth` on an interval, plus a
   `job_runs` record and the dead man's switch from §9 — a job that has not
   reported success inside its window raises, visibly, in the operator queue.
   Without this the outbox does not drain, notifications do not send and a sold
   retention entitlement is enforced by nothing.~~ **Shipped 2026-08-20** — `0020`
   plus `.github/workflows/scheduled-jobs.yml` and a **Scheduled jobs** row on the
   operator console. Three things this document did not say, all worth having said:
   a `RUNNING` row that never closed is a *third* state and means "the process
   stopped existing", which is not the same fact as a failure; **a job that has
   never succeeded must read as overdue rather than unknown**, because the day the
   schedule is wired up wrong is the day there is no evidence at all and "no
   evidence" read as "no problem" is silence exactly when it matters; and the
   `--loop` arm deliberately writes no row, since a developer's laptop claiming
   the schedule is alive would be a heartbeat for a scheduler that does not exist
   in production.
2. ~~**Request correlation.** A request id per request, echoed in the error
   envelope so a customer can quote it, attached to every log line and carried
   into every outbox row the request writes. Then `errorHandler` logs the request
   rather than the stack alone, and the §7 allowlist is the shape of the log line.
   Also needs no decision — it is the support model §13.3 of the access packet
   already assumed.~~ **Shipped 2026-08-20**, taken first precisely because it
   needed no decision. The §7 allowlist is enforced by the type of `LogFields`
   rather than by this document, so adding a field is an edit to that file. Two
   things worth recording here: the reference is minted server-side and an inbound
   `X-Request-Id` is **ignored**, because a caller who chooses their own can file
   their traffic under somebody else's investigation; and carrying the id into the
   outbox row is **not** done yet — the request-to-job half of §12.4 arrives with
   step 1, which is where a job id exists to correlate to.
3. **Error tracking** (§13.3), scrubber first and library second, so no
   unscrubbed event is ever sent.
4. **The recovery promise** (§13.4): tier, backup schedule, and the rehearsal —
   which is the step, not the paperwork.
5. **Export**, then **deletion** (§13.1, §13.2), in that order and never the
   reverse. Deletion before export means the first person to use the product's
   erasure path had no way to take their records with them, and it is the one
   mistake here that cannot be repaired afterwards.
