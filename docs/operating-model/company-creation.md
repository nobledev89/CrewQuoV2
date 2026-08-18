# Operating-model packet — company ownership & creation

**Domain:** who may bring a new tenant company into existence — the permanently
ledgered automatic first company, the additional-company request/approval state
machine, duplicate and recovery routing, and the trial-eligibility ledger that
stops a new tenant from being a new free trial.
**Phase:** 6 · **Status:** adopted · **Last updated:** 2026-08-18
**Plan refs:** §3.1.1 (the policy), §3.1 (`companies`, `memberships`), §5B
(plans/entitlements), §7 (API surface), §36 (revisions), §41 decision 31, §44
(the test list this packet is answerable to).

---

**The distinction this whole domain rests on:** *membership* is unlimited and
*creation* is not. A user may be invited into any number of companies and the
switcher keeps showing every active membership — nothing in this packet touches
that path. What is rationed is bringing a **new tenant** into existence, because a
tenant is a subscription boundary, a data boundary and a trial.

## 1. Persona / job

| Persona | Job | Device / connectivity |
|---|---|---|
| **New customer** | "I signed up. Give me my company so I can start." | Desktop web or mobile, online. One-time, and must not be friction. |
| **Genuine multi-entity owner** | "I really do run two companies — a labour supplier and a plant-hire business. I want the second one, and I expect to pay for it." | Desktop web. Deliberate, seated, form-filling work. |
| **Trial farmer** (adversarial) | "My 14 days ran out. I'll make another company." | Any. This persona is who the ledger exists for. |
| **Confused re-registrant** | "My colleague already set us up but I can't see it, so I'm creating it again." | Any. Must be routed to an invitation, not given a second empty tenant. |
| **Platform support / super admin** | "This customer is a legitimate second business on a comped plan. Approve it, in writing." | Desktop web, Platform console. |

Nobody does this offline, and nobody does it in the field. Section 8 refuses
offline capture outright rather than deferring it.

## 2. Resource responsibility

| Resource | Creator | Owner | Reader | Reviewer | Publisher | Corrector | Exporter | Retention owner |
|---|---|---|---|---|---|---|---|---|
| `company_creation_allowances` | the system, on the first company | the platform | the user (as a state, not a row); super admin | — | — | **nobody** — see the never-restored rule below | platform | platform, forever |
| `company_creation_requests` | the requesting user | the requesting user | requester + super admin | super admin | — | nobody once filed; the row is deleted and re-made | platform | platform |
| `companies` (real) | the consumption transaction | the created company | its members | — | — | OWNER/ADMIN via `PATCH /v1/companies/:id` | company | company |
| `companies.country` / `.registration_id` | the consumption transaction | the company | its members; the duplicate check reads across tenants | — | — | OWNER/ADMIN | company | company |
| `trial_grants` | super admin (comp) or, later, checkout | the platform | super admin | — | — | nobody — a grant that happened, happened | platform | platform, forever |
| `platform_audit_logs` rows for this domain | every mutation here | the platform | super admin | — | — | **nobody** — insert-only | platform | platform, forever |

**The allowance is never restored, and that is the point.** Per §3.1.1(1),
transferring ownership, leaving, archiving or deleting the company does not give
it back. So there is no corrector for that row and no support endpoint that
deletes one — a customer who genuinely needs another company goes through the
same request flow as everyone else, where the decision is recorded. A restore
path would be indistinguishable from the reset it exists to prevent.

**The registration identity lives on `companies`, not on the request.** The
request is transient; the duplicate signal has to be answerable years later
against companies that exist. `registration_id_normalized` is a generated column
so the comparison can never drift from the value shown to a human.

## 3. State machine

The six states are §3.1.1's, verbatim. No seventh was invented.

```
                        +----------------------------------------------+
  register / first  ----|  no request needed: the allowance row and the |
  POST /v1/me/companies |  company are committed in one transaction     |
                        +----------------------------------------------+

  additional company:

                   +- checkout on + paid plan -> PENDING_CHECKOUT -+
  (none) --create--|                                               |--> APPROVED --consume--> CONSUMED  (terminal)
                   +- otherwise --------------> PENDING_REVIEW ----+     single use            holds company_id
                                     |                  |
                                     |                  +-- reject (super admin, reason required) --> REJECTED (terminal)
                                     |
                                     +-- requester deletes the row (the platform audit survives)

  any unconsumed state, once expires_at passes ---> EXPIRED (terminal)
```

- **Actors.** Create / delete: the requesting user, on their own request, and
  nobody else — not even a super admin, who rejects instead of deleting. Approve /
  reject / record-checkout: `is_super_admin` only. Consume: the requesting user,
  through `POST /v1/me/companies`.
- **The entry state is the server's decision, not the caller's.** A client cannot
  ask for `PENDING_REVIEW` to dodge paying.
  `platform.company_creation.checkoutEnabled` plus whether the intended plan is a
  paid one decides it. Checkout is off today — Gumroad is a later Phase 6 bullet —
  so every request currently lands `PENDING_REVIEW`, which is §3.1.1(3)'s
  *"audited super-admin approval"* arm rather than a gap.
- **Rejection requires a reason** (422 without one) and is terminal. A corrected
  application is a new request, never an edit: the reviewer must decide on a
  frozen payload, which is the rule the rate-proposal reviewer already works under.
- **A requester withdraws by deleting the row, not by moving it to a state.**
  §3.1.1 enumerates six states and none of them is "withdrawn"; adding one would be
  inventing a shape (§0 rule 3). The live row *is* the claim, and the history lives
  in `platform_audit_logs`, which is insert-only — so a deleted request leaves
  `company_creation_request.created` and `.deleted` behind it and cannot be used.
- **Expiry is lazy, and deliberately so.** `EXPIRED` is materialised when the row
  is next read or consumed (`status <> 'CONSUMED' and expires_at <= now()`), never
  by a timer. Durable jobs are their own Phase 6 bullet, and *"move audit purge and
  derivatives off process-local timers"* is already on that list — adding a new
  timer here would be work to undo. A pending request expires **14 days** after it
  was made; approval resets the clock to **30 days** from the decision, because at
  that point the thing you must use is the approval.
- **Consumption is single-use, and the row is the mutex.**
  `update ... set status='CONSUMED' where id=$1 and status='APPROVED' and expires_at>now()`
  runs inside the same transaction that inserts the company. Zero rows updated
  means the whole transaction aborts. Two tabs racing the same approval therefore
  produce exactly one company and one `CONFLICT`.
- **The automatic path needs no lock at all.**
  `insert into company_creation_allowances (user_id, ...) on conflict (user_id) do nothing returning ...`
  returns zero rows for the loser of a race. The primary key *is* the concurrency
  control, so "works exactly once under concurrency" (§44) is a database guarantee
  rather than a checked-then-acted one.

**Concurrency rule, stated once:** every decision in this domain is expressed as a
conditional write whose `where` clause names the state it is leaving. Nothing
reads, then writes.

## 4. Permission + scope matrix

| Operation | Feature entitlement | Role / capability | Company edge | Resource scope |
|---|---|---|---|---|
| `POST /v1/me/companies` — **first** company | **none** | any authenticated non-staff user with no allowance row | n/a — no company exists yet | the caller's own identity |
| `POST /v1/me/companies` — **additional** | none | the requester, holding their own `APPROVED` request | n/a | that one request |
| `POST /v1/company-creation-requests` | none | verified non-staff user whose allowance is consumed, **with step-up re-authentication** | n/a | own identity |
| `GET /v1/company-creation-requests` | none | any authenticated user | n/a | own requests only |
| `DELETE /v1/company-creation-requests/:id` | none | the requester | n/a | own request, while pending |
| `GET /v1/admin/company-creation-requests` | none | `is_super_admin` | n/a | all |
| approve / reject / record-checkout | none | `is_super_admin` | n/a | one request |
| `POST /v1/admin/companies/:id/comp-trial` | none | `is_super_admin` | n/a | one company, checked against its owners' trial ledger |

**No new entitlement key, and §43 adds none.** A plan describes what a company may
*do*; this is a rule about whether a company may *exist*. Expressing it as a
feature would put the gate inside the thing it gates: a company on no plan
resolves to Crew, and Crew is exactly the tier a trial farmer wants more of. The
gate is therefore platform policy read from the user's ledger, above the
entitlement engine entirely.

**Platform staff do not use the customer endpoint** (§3.1.1(7)). `is_super_admin`
gets `FORBIDDEN` from `POST /v1/me/companies` and from the request endpoint,
naming the console instead. Staff creating tenants through the customer path would
put unattributable companies in the ledger.

**Step-up re-authentication, concretely.** The request endpoint takes `password`
(bcrypt-verified against `users.password_hash`) or `googleIdToken` (verified by
the existing `verifyGoogleIdToken`). This is the honest reading of §3.1.1(7)'s
*"recent authentication"*: access tokens are re-minted by refresh without anyone
re-proving anything, so their `iat` is not evidence of a recent human. Re-entry
is. The **first** company deliberately does not ask — that user authenticated
minutes ago at registration, and a password prompt on the empty state is friction
against the one persona who must meet none.

## 5. Domain events

No transactional outbox exists yet (its own Phase 6 bullet). Until it does, an
"event" is a row in `platform_audit_logs` written **inside** the business
transaction — which is also the immutable decision record §3.1.1(7) requires.

| Event | Payload | Idempotency key | Consumers | Replay |
|---|---|---|---|---|
| `company_creation_request.created` | request id, legal name, country, normalised registration id, intended plan, entry state, duplicate warnings | request id + `created` | platform review queue; the 24-hour rate-limit counter reads these rows | insert-only; a replay would double-count the rate limit, so the writer sits inside the creating transaction |
| `company_creation_request.approved` | request id, route (`CHECKOUT`/`ADMIN`), reason, new `expires_at` | request id + `APPROVED` | requester notification; Action Centre | guarded by the status transition |
| `company_creation_request.rejected` | request id, reason | request id + `REJECTED` | requester notification | idempotent |
| `company_creation_request.checkout_recorded` | request id, provider reference | request id + reference | approval | the reference is stored once; a second call with a different one is a conflict |
| `company_creation_request.deleted` | request id, prior status | request id + `deleted` | — | the row is gone; the log is the history |
| `company_creation_request.consumed` | request id, company id | request id + `CONSUMED` | billing — attach the purchased subscription, when Gumroad lands | the transition guarantees one |
| `company.created` | company id, name, country, path (`REGISTRATION`/`ALLOWANCE`/`APPROVAL`), whether the allowance was consumed | company id | onboarding; analytics | one row per company, ever |
| `trial.granted` / `trial.repeat_granted` | company id, owner user ids, plan, days, repeat acknowledgement + reason | company id + granted_at | billing; abuse review | insert-only ledger |

**Why the company-scoped trail is not the record here.** `recordAudit` is subject
to the company's `audit_retention_days`, and a brand-new company resolves to Crew,
whose retention is `0` — so the row is *not written at all*. That is the same hole
already documented for free-plan providers in the commercial-agreements packet. A
creation decision must survive regardless of the created company's plan, so the
durable record is `platform_audit_logs`, which no plan can suppress. A
company-scoped `company.created` row is written **as well**, so a paying company's
own trail starts with its own creation; it is a convenience, not the evidence.

**§36 revisions do not apply, and the reason is structural.** `record_revisions`
is company-scoped (`company_id uuid not null references companies(id)`). A
creation request *predates its company*, and for a rejected one no company ever
exists. Before/after for these rows lives in `platform_audit_logs.changes`
instead. This is the one §36-shaped record that legitimately cannot be a revision.

## 6. Notification matrix

Nothing here is delivered by email or push yet — Resend is a later Phase 6 bullet,
and this packet does not pretend otherwise. The **durable copy is the request row
itself**, read by `GET /v1/company-creation-requests` and rendered on the profile
screen. That is deliberate, and is the rule this section exists to enforce.

| Recipient | Event | Channel (when delivery lands) | Urgency | Digest / quiet hours | Escalation | Durable Action Centre item |
|---|---|---|---|---|---|---|
| Requesting user | approved | email + in-app | high — a clock starts | never digested; it expires | none | the request row, showing "approved, create by <date>" |
| Requesting user | rejected | email + in-app | high | never digested | support address in the reason | the terminal row with its reason |
| Requesting user | expiring in 3 days | email | medium | digestable | — | the row's countdown |
| Super admin | new `PENDING_REVIEW` | in-app queue; email digest | medium | a daily digest is correct — this is not an outage | none | Platform ▸ Operations ▸ Company creation requests |
| Super admin | registration-identifier collision on a request | in-app | medium | — | — | the warning carried on the queue row |

## 7. Data classification + retention

| Data | Class | Default visibility | Lifecycle | Legal hold | Deletion / export |
|---|---|---|---|---|---|
| `company_creation_allowances` | commercial, account-level | the owning user as a yes/no state; super admin | permanent — the whole point | n/a | survives company deletion; removed only with the user account |
| `company_creation_requests` (open) | personal + commercial — a declared legal identity | requester + super admin | 14 days pending, 30 days approved | n/a | deletable by the requester while pending |
| `company_creation_requests` (terminal) | commercial | requester + super admin | retained 24 months, then reducible to the platform-audit rows | yes | included in the user's data export |
| `companies.registration_id` | commercial; **cross-tenant readable by the duplicate check only** | company members; never returned to another tenant | company lifetime | yes | exported with the company |
| `trial_grants` | commercial / anti-abuse | super admin only | permanent | n/a | survives company deletion, keyed to the user |
| this domain's `platform_audit_logs` rows | commercial evidence | super admin only | permanent, insert-only | yes | never removed by a customer action |

**What is deliberately not stored** (§3.1.1(5)): no device fingerprints, no IP
history, no raw payment data. The anti-reset signal is the *user identity* and the
*MoR customer id the provider gives us* — `trial_grants.provider_customer_id`,
reserved now, null until Gumroad. A fingerprint would be a materially more
invasive way to answer the same question.

**The duplicate check reads across tenants, and that is a considered exception.**
It returns *no* company data — no id, no name, no owner — only "a company with this
registration identifier already exists, and here is how to get access". Anything
richer would turn a registry lookup into a tenant-enumeration oracle (section 10).

## 8. Offline / conflict policy

Refused, not deferred. Creating a tenant offline would mean a client-generated
company id, a queued allowance consumption and an approval consumed against a
server state the device could not see — and the failure mode is a duplicate
company, which is exactly what this domain exists to prevent. Both endpoints
require connectivity and return their decision synchronously.

There is no client id and no expected-version field, because there is no editable
record: a request is created once, decided once and consumed once. The only
conflict a user can meet is *"this approval has already been used"* (409), and the
screen resolves it by showing the company that was created from it.

## 9. Failure matrix

| Failure | Retryable? | Partial-success behaviour | Operator repair | What the user sees |
|---|---|---|---|---|
| Company insert fails mid-transaction | yes | none — the allowance/approval consumption is in the same transaction and rolls back with it | none needed | "Could not create the company. Try again." |
| Retry after a successful create (the network dropped the response) | yes, with the same `Idempotency-Key` | none — the ledger row carries the key and the company id | none | the same company, `200` rather than `201` |
| Retry with **no** idempotency key, allowance already consumed | no | none | none | 409 explaining the additional-company flow — *not* a silent second company |
| Approval expired between page load and submit | no | none | requester files a new request | "This approval expired on <date>", with the new-request action |
| Two admins decide the same request | n/a | one decision stands | the loser sees the outcome | 409 naming the decision that won |
| Registration identifier collides | no | none | support routes to invitation or ownership recovery | "A company with this registration number is already on CrewQuo", with the three recovery routes |
| Rate limit hit (more than 5 requests in 24h) | after the window | none | a super admin can still approve an existing request | 429 with the retry time |
| Step-up re-auth fails | yes | none | — | "That password was not correct" — and nothing changed |
| Trial repeat refused | no | none | super admin re-issues with `acknowledgeRepeatTrial` and a reason, which is logged | admin-side only; the customer sees nothing |

**Never leave an active half-created tenant** (§3.1.1(7)). Every path above either
commits a company *with* its owner membership *and* its ledger consumption, or
commits nothing. There is no state in which a company exists with no owner.

## 10. Security / threat model

- **Tenant boundary.** Company creation makes a *new* boundary; nothing is copied
  across an existing one. The created company gets its own id, its own subscription
  row (none — it resolves to the free plan), its own settings, currency, limits and
  retention. §44's "separate subscription/data boundaries" is asserted directly
  rather than assumed.
- **Trial farming** — the primary abuse. Countered by the permanent allowance
  ledger *and* the trial ledger, which are independent: even an approved second
  company cannot carry a second automatic trial, because eligibility is keyed to
  the owning identity rather than the tenant.
- **Tenant enumeration through the duplicate check.** Answered above: the response
  is a boolean and a route, never a company. Name-only matches return a *warning*
  and never block, both because names are not globally unique (§3.1.1(6)) and
  because a blocking name check is a free "does X use CrewQuo?" oracle.
- **Forged identifiers.** `requestId` is validated as a uuid and scoped
  `where user_id = $ctx.userId`, so a valid uuid belonging to another user is a
  404 rather than a 403 and existence is not disclosed.
- **Session theft.** Step-up re-authentication means a stolen access token alone
  cannot start the additional-company flow, and cannot finish it either, since
  finishing needs a super admin or a payment.
- **Privileged access.** Every super-admin decision writes `platform_audit_logs`
  with the actor, the reason and both sides of the change, in the same transaction
  as the decision. Approval without a reason is a 422 — the rule the rate reviewer
  works under, for the same purpose: an unexplained approval is indistinguishable
  from a mistake later.
- **Rate limiting.** Counted from the immutable log rather than from live rows, so
  deleting a request does not buy another attempt. No general HTTP rate-limit
  middleware exists yet; that remains its own Phase 6 security bullet, and this
  limit is domain-specific and DB-backed on purpose — it holds across processes,
  which an in-memory limiter would not.
- **Secret rotation:** nothing new. No new secret, key or webhook surface is
  introduced here; `checkout_reference` is written by an authenticated super admin
  today, and by the signed Gumroad webhook when that lands.

## 11. Analytics contract

- **Activation:** `company.created` with its `path` — the share of signups that
  reach a company at all is the funnel this domain can most easily break.
- **Outcome:** `company_creation_request.consumed` — a request that produced a real
  second company.
- **Funnel:** request created → decided → consumed, with time-to-decision as the
  operator's service level.
- **Quality metric:** *refusals that were legitimate*. Rejected requests, plus
  registration collisions, plus repeat-trial refusals, against approvals. A rising
  approval rate against a flat request rate means the policy is theatre; a rising
  rejection rate means the form asks the wrong questions.
- **Explicitly excluded from any payload:** the registration identifier itself, the
  attestation text, decision reasons, and anything from the step-up credential.
  These are commercial and personal; counting them is enough.

## 12. Acceptance script

`Dana` signs up, `Priya` runs a second real business, `Mo` is platform staff.

1. **Empty.** Dana registers with no company name, lands on the empty workspace and
   creates *Northlight Rigging*. It exists, she is `OWNER`, and her allowance ledger
   row now names it.
2. **Exactly once.** Dana creates a second company the same way — `409`, naming the
   additional-company flow. Her allowance row is unchanged and no company was made.
3. **Invitations are free.** Priya invites Dana into *Meridian Events* as a
   `MANAGER`; Dana accepts. She now has two memberships and her allowance ledger is
   *still* the single Northlight row — the invited membership consumed nothing.
4. **Denied.** Dana asks for an additional company with the wrong password — `401`,
   nothing recorded. With the right password but no attestation — `422`.
5. **Duplicate.** Priya requests a company using a registration number an existing
   company already holds — `409`, routing her to invitation / ownership recovery /
   support and disclosing no company. A *name-only* match returns a warning and
   lets her continue.
6. **Rejected.** Priya's clean request lands `PENDING_REVIEW`. Mo rejects it with no
   reason — `422`. With a reason — `REJECTED`, terminal, and Priya reads the reason
   on her profile.
7. **Approved and consumed.** Priya requests again, Mo approves with a reason, and
   Priya creates *Meridian Plant Hire*. The request is `CONSUMED` and holds the
   company id; the company has its own currency, no subscription, and no rate cards,
   roles or engagements from Meridian Events.
8. **Single use.** Priya replays the same create — `409`. With the original
   `Idempotency-Key` — `200` and the *same* company, not a second one.
9. **Correction / retry.** Priya's next request is deleted by her while pending; the
   platform log keeps `created` and `deleted`, the row is gone, and the
   one-open-request rule lets her file a fresh one immediately.
10. **Trials do not reset.** Mo comps Priya a 14-day trial on Meridian Events, then
    tries the same on Meridian Plant Hire — `409`, naming the earlier grant. Mo
    repeats it with `acknowledgeRepeatTrial` and a reason — allowed, and the ledger
    and the platform log both record it as a repeat.
11. **Staff stay out of the customer path.** Mo calls `POST /v1/me/companies` —
    `403`, naming the console.
12. **Legacy owners are safe.** Every real company that existed before this
    migration has an allowance row for each of its owners, so no existing customer
    gains a free second tenant and none loses a company they already had.
