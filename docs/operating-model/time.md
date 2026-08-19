# Operating-model packet — time & time zones

**Domain:** which zone decides "what day is it" — company and project IANA zones,
the boundary between a stored instant and a human's date, DST gaps and overlaps,
overnight shifts, and the date-bound readings (retroactivity, reporting periods,
quiet hours) that depend on getting it right.
**Phase:** 6 · **Status:** adopted · **Last updated:** 2026-08-19
**Plan refs:** §3.4 (`work_date`), §6 (rate labels resolve from a date), §3.3.1
(retroactive approval), §29 (report periods), §42 (the IANA/WCAG bullet), §44
(the time-zone test list this packet answers to).

---

**The distinction this whole domain rests on:** an **instant** is a point in time
and a **date** is a human's answer to "which day was that". CrewQuo stores both —
`timestamptz` for instants, `date` for days — and the bug is never in either
column. **The bug is always in converting one to the other without naming a
zone.**

The product already got the storage right by accident of good instincts:
`work_date` is a `date`, asserted by the person who did the work rather than
derived from when they pressed the button, and `formatDate` renders it in UTC so
it cannot shift by a day in the browser. What it never had was an answer to *whose
day it is* when the server has to decide for itself.

> **The bug this packet was written for.** `todayIso()` in the commercial service
> returned `new Date().toISOString().slice(0, 10)` — **the server's UTC date** —
> and `isRetroactive(effectiveFrom, todayIso())` decided whether an agreed rate
> needed an OWNER plus a written reason. For a company in Manila (UTC+8) between
> midnight and 08:00 local, the server is still on yesterday, so a genuinely
> back-dated schedule passes as current — the §3.3.1 safeguard silently off for a
> third of every day. For a company in Los Angeles (UTC−8) after 16:00 local, the
> server is already on tomorrow, so a rate starting **today** is judged
> retroactive: a manager gets a 403 and an owner is made to justify a schedule
> that starts this morning. One line, both failure directions, and neither
> visible without a customer in a non-UTC zone.

## 1. Persona / job

| Persona | Job | Device / connectivity |
|---|---|---|
| **Crew member logging work** | "I worked Tuesday night. Record it against Tuesday." | Phone, on site, often after midnight. The overnight shift is their normal case, not an edge case. |
| **Contractor admin** | "Our week runs Monday to Sunday *here*, not in UTC." | Desktop. Approves and invoices against period boundaries. |
| **Multi-region contractor** | "My office is in Manila and this project is in Dubai. Whose day is the timesheet in?" | Desktop. The reason a *project* zone exists at all. |
| **Anyone reading a timestamp** | "When did that approval actually happen, in my terms?" | Any. Instants render in the reader's own zone; days do not. |

## 2. Resource responsibility

| Resource | Creator | Owner | Reader | Corrector | Retention owner |
|---|---|---|---|---|---|
| `companies.time_zone` | company creation (defaults `UTC`) | the company | its members | OWNER/ADMIN | company |
| `projects.time_zone` | project creation, **null = inherit the company** | the project | owner-company members | OWNER/ADMIN | company |
| `notification_preferences.time_zone` | the user | that user | that user | that user | user |
| A stored instant (`timestamptz`) | whatever wrote it | the record | per that record's rules | **nobody — an instant never moves** | that record |
| A stored date (`work_date`, `effective_from`, period bounds) | the human who asserted it | the record | per that record's rules | the record's own correction path | that record |

**Three zones, and they answer three different questions.** The company zone is
"what day is it for this business". The project zone overrides it for work that
happens somewhere else. The user zone is *only* for when to disturb a person, and
must never decide what day a figure belongs to — otherwise the same timesheet
would land on different days for two people looking at it.

## 3. State machine

Zones have no workflow. What matters is when a zone may still change:

| Stage | Rule |
|---|---|
| Company zone | changeable by OWNER/ADMIN at any time, and **changing it never moves a stored value**. It changes what "today" means from now on, and nothing about the past. |
| Project zone | set at creation from the company, overridable while the project holds no approved work — the same pin the reporting currency uses, for the same reason: re-bucketing committed days would restate history. |
| A stored instant | immutable by definition. Rendering it in a different zone shows a different wall clock for the same moment, which is correct and is not a change. |
| A stored date | only its own domain's correction path may alter it. A zone change must never rewrite one. |

**The invariant, stated once:** *changing any zone changes presentation and future
bucketing, never a stored instant and never a stored date.* Every test in §12 is a
restatement of that sentence.

## 4. Permission + scope matrix

| Operation | Feature entitlement | Capability / role | Company edge | Resource scope |
|---|---|---|---|---|
| Read a company/project zone | none | any member | active membership | own company's projects |
| `PATCH /v1/companies/:id` (`timeZone`) | none | **OWNER or ADMIN** | active membership | acting company |
| `PATCH /v1/projects/:id` (`timeZone`) | none | **OWNER or ADMIN** | active membership | must own the project; pinned once it holds approved work |
| Client / portal reads | — | — | — | dates already render as dates; a client never learns the provider's operating zone beyond what a date implies |

**No entitlement key, and §43 adds none** — the same argument as the money
boundary. A plan decides what a company may do, not whether its dates are
allowed to be right.

## 5. Domain events

None of its own. A zone change is audited (`company.updated` / `project.updated`
already carry it) and emits no outbox event, because nothing downstream needs to
react: no stored value moves, so there is nothing to recompute. Stated explicitly
rather than left as an omission — an event here would imply a migration of past
data that must never happen.

## 6. Notification matrix

Not applicable at this level. Quiet hours already consume
`notification_preferences.time_zone` (notifications packet §6), and this packet
deliberately does **not** move them onto the company zone: when to disturb a
person is a property of the person, not of their employer.

## 7. Data classification + retention

A zone is low-sensitivity configuration, though it does leak coarse location, so
it is company-internal and not in any client-facing payload. It has no lifecycle
of its own and is retained with its company or project.

**Audit retention stays instant-based.** The purge compares `timestamptz` against
`now()`, which is zone-independent and must remain so: a retention window that
moved when somebody changed their office zone would be a compliance defect.

## 8. Offline / conflict policy

The field client captures a **date the user asserts**, not a derived one, and
sends it as `YYYY-MM-DD`. This is the single most important offline rule here: a
device with a wrong clock, or one that crosses a zone between capture and sync,
must not silently re-bucket work that has already been written down. The device's
own zone is captured alongside as metadata for diagnosis, never as an input to
which day the work counts against.

Zones themselves are not offline-editable.

## 9. Failure matrix

| Failure | Retryable? | What the user sees | Repair |
|---|---|---|---|
| An unrecognised IANA zone is submitted | no | refused at validation, naming the field | pick from the offered list |
| A stored zone is no longer valid (tzdata dropped it) | n/a | reads fall back to UTC and say so rather than throwing | OWNER/ADMIN picks a current zone |
| A local time that does not exist (spring-forward gap) | n/a | the instant resolves forward to the first real moment after the gap, deterministically | none — documented, not an error |
| A local time that happens twice (autumn overlap) | n/a | the **earlier** of the two is used, consistently | none — documented |
| Device clock wrong offline | no | the asserted date is kept as asserted | the normal correction path for that record |

**A zone lookup must never fail a business operation.** Every conversion falls
back to UTC and logs, because refusing an approval over a zone string is a worse
outcome than reporting it against a slightly wrong day boundary — and the wrong
day is visible, whereas the refusal looks like a bug in something else.

## 10. Security / threat model

Zones are validated against the runtime's own IANA database rather than a regex,
so an arbitrary string cannot reach a `AT TIME ZONE` clause. That is the only
injection-shaped surface here, and it is closed by validation at the edge plus
parameterisation in every query.

The abuse worth naming: **a zone is an input to a safeguard.** Retroactive rate
approval keys off "today", so an owner who moves their company zone west buys
themselves extra hours in which a back-dated schedule reads as current. Bounded
rather than eliminated — the shift is at most a day, the change is audited, and
the approval itself still records who did it and why. Worth knowing about, not
worth a second safeguard.

## 11. Analytics contract

Zone distribution across companies, and the count of conversions that fell back to
UTC (a rising number means a stale tzdata or a bad value in the wild). **Excluded
as sensitive:** anything correlating a zone with a named company, which is coarse
location data about a customer's operations.

## 12. Acceptance script

**Persona: Dana, whose company operates in `Asia/Manila` (UTC+8).**

1. **Empty.** An existing company reads as `UTC` and nothing about its behaviour
   changes. *The single-zone majority never meets this domain.*
2. **Set.** Dana sets the company zone to `Asia/Manila`; the change is audited.
3. **Denied.** A MEMBER cannot change it. An invalid zone is refused by name.
4. **The bug, asserted.** At an instant where Manila and UTC disagree about the
   date, a rate schedule effective *today in Manila* is **not** retroactive — and
   one effective *yesterday in Manila* **is**, requiring an owner and a reason.
   Both directions, because the old code got each one wrong at a different hour.
5. **Nothing moved.** Setting the zone changes no `work_date`, no `effective_from`
   and no stored instant. Asserted by comparing before and after.
6. **Project override.** A project in another zone reports its own day boundaries;
   an empty project may change zone, one holding approved work may not.
7. **Overnight shift.** Work asserted against Tuesday stays on Tuesday whatever
   time it was submitted and whatever zone the submitter is in.
8. **DST.** A gap time and an overlap time both resolve deterministically and
   neither throws.
9. **Correction.** Changing the zone back leaves every figure exactly as it was.
