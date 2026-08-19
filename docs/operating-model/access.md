# Operating-model packet — access, sessions & platform security

**Domain:** who can prove they are who they say they are, for how long, from which
device, and what a platform operator may do to somebody else's tenant. Covers
authentication factors and recovery, session and device lifecycle, step-up
re-authentication, request rate limiting, signing-secret rotation, support access,
and the tenant-boundary threat model the rest of the packets assume.
**Phase:** 6 · **Status:** adopted · **Last updated:** 2026-08-19
**Plan refs:** §4 (auth context), §5 (tokens), §5B (platform staff), §3.1.1(7)
(recent authentication, rate limiting, immutable decision record), §19.5 (this
packet's shape), §42 (the security-hardening bullet this answers), §44 (the test
discipline).

> **Drafted with three questions open, adopted once they were answered** — both on
> 2026-08-19. The owner took all three recommendations; §13 records them as
> decisions with the reasoning that produced them, because a decision whose
> alternatives are lost is indistinguishable a year later from something nobody
> thought about.

---

**The distinction this domain rests on:** *authentication* is evidence about a
human; *authorization* is a decision about a request. CrewQuo's authorization is
already good — four independent checks (entitlement, role, company edge, resource
assignment), the role read from the database on every request rather than from the
token, and 45 unit tests pinning it. **Everything in this packet is about the other
half**, which has had far less attention: how strong the evidence is, how long it
stays valid, and who can bypass it.

> **The gap that motivates the whole packet.** A CrewQuo account is a password and
> nothing else. There is no second factor available to anybody, including the super
> admins who can read every company on the platform, comp trials, revoke sessions
> and approve new tenants. And there is **no rate limit on `POST /v1/auth/login`** —
> the one endpoint in the product where unlimited free guesses are worth something.
> `RATE_LIMITED` exists as an error code and exactly one route in the entire API
> throws it (company-creation requests, §3.1.1). An attacker with a
> credential-stuffing list has as many attempts as their bandwidth allows, against
> accounts with no second factor, and nothing anywhere records that it happened.

## 1. Persona / job

| Persona | Job | Device / connectivity |
|---|---|---|
| **Any signed-in user** | "Stay signed in on my own devices, and let me end a session on one I lost." | Desktop and phone, long-lived. The phone is the one that gets lost. |
| **Company owner/admin** | "My account can move money and change rates. Make it hard to take." | Desktop mostly. Willing to accept friction on *their* account, not on their crew's. |
| **Crew member** | "I am on site with cold hands. Do not make me type a code to log four hours." | Phone, poor connectivity, often gloved. **The persona that makes blanket MFA wrong.** |
| **Platform operator (super admin)** | "I need to investigate a customer problem without becoming a liability." | Desktop. Their account is the most valuable target on the platform. |
| **Attacker** | "Reuse a leaked password, or guess a weak one, at machine speed." | Not a user, but the persona every rule below is actually written for. |

**The crew member is why MFA is not simply switched on for everyone.** A
subcontractor on the Crew plan works for free (§5B) and logs hours from a phone in
a car park. Mandatory TOTP for that persona buys little — their account can submit
a timesheet somebody else has to approve — and costs enough friction that the work
stops being recorded, which is a data-integrity failure dressed as a security win.

## 2. Resource responsibility

| Resource | Creator | Owner | Reader | Corrector | Retention owner |
|---|---|---|---|---|---|
| `users.password_hash` | the user | the user | **nobody** — bcrypt, never read back | reset flow only | the user |
| A refresh session | sign-in | the user | that user; a super admin sees metadata only | the user (sign out) or a super admin (revoke, reason required) | the user |
| An enrolled second factor | the user | the user | **nobody** — the secret is never displayed again after enrolment | re-enrol, or spend a recovery code | the user |
| A recovery code | enrolment | the user | shown **once**, hashed thereafter | regenerate, which invalidates the whole set | the user |
| A signing secret | deployment | the platform | **nobody** — environment only, never logged, never in a payload | rotation, overlapping | the platform |
| A rate-limit counter | the request | nobody | operators, in aggregate | expires on its own | discarded, not retained |
| A second-factor reset by an operator | a super admin | the account holder | the holder and platform audit | the holder re-enrols | the platform |

**"Nobody" appears four times and each one is load-bearing.** A password hash, a
TOTP secret, a recovery code after first display and a signing secret are all
things the product must be *unable* to show, not merely careful about showing. A
future screen that wants to display one is a bug in the request, not a feature.

## 3. State machine

### A session

| State | Meaning | Transition |
|---|---|---|
| `ACTIVE` | a live refresh token, unexpired and unrevoked | sign-in creates it |
| `ROTATED` | its token was exchanged for a successor | refresh rotates; the old hash is retired, not reusable |
| `REVOKED` | ended deliberately | user signs out · user ends it from the device list · password reset revokes all · a super admin revokes with a reason |
| `EXPIRED` | past `expires_at` | lazy, like every other expiry in this product — derived on read, never by a timer |

**Rotation already happens; detection is what is missing.** `refresh()` revokes the
presented token and issues a successor, so a refresh token does *not* survive use —
that half is done. What is missing is what happens **next**: replaying a retired
token returns a plain `UNAUTHENTICATED`, identical to the one an expired token
produces, and the legitimate session carries on untouched. So the single strongest
signal of theft the product could have — the same token presented twice, which has
only two explanations, a thief or a client bug — is currently thrown away as a 401.

**Reuse of a retired token must revoke the entire family**, and that needs a lineage
the schema does not have: `refresh_tokens` has no session or predecessor column, so
"the family" is not currently expressible. That, not rotation, is the work.

### A second factor

`NONE → PENDING (secret issued, not yet proven) → ACTIVE → NONE (removed)`.

`PENDING` matters: enrolment is not complete until the user has produced one correct
code. Without that state, a proportion of enrolments strand somebody outside their
own account holding a QR code they never scanned properly.

### Concurrency

Two devices refreshing the same token at once is the ordinary race, not an attack — a
phone waking up while a laptop polls. The rotation is a single conditional
`update … where token_hash = $1 and revoked_at is null returning`, so the database
picks a winner; the loser retries with the successor it is handed, and a **short
grace window** on the just-retired token keeps a legitimate double-submit from
looking like theft. Without the grace window, ordinary flakiness logs people out and
they learn to distrust the alarm.

## 4. Permission + scope matrix

| Operation | Feature entitlement | Capability / role | Company edge | Resource scope |
|---|---|---|---|---|
| List my own sessions | none | any authenticated user | — | **own sessions only**; another user's id is a 404, never a 403 |
| End one of my sessions | none | any authenticated user | — | own sessions only |
| Enrol a second factor | none | any authenticated user | — | own account |
| Remove a second factor | none | any authenticated user | — | own account, **and step-up re-auth required** |
| Spend a recovery code | none | unauthenticated — that is the point | — | own account |
| Revoke another user's sessions | none | **super admin** | — | any user; reason required; platform-audited |
| Reset another user's second factor | none | **super admin** | — | any user; reason required; unconditional email to the holder; platform-audited (§13.2) |
| Impersonate a customer, or read one tenant's data as an operator | — | **nobody, by decision** (§13.3) | — | there is no such route, and adding one is a decision to reopen, not a feature to add |
| Rotate a signing secret | none | **deployment** — not an API surface at all | — | platform |

**No entitlement key, and §43 adds none.** Selling a security floor as a plan feature
would make the cheapest tenant the softest target on a platform where every tenant
shares one database — so the weakest customer's compromise becomes everybody's
incident. A plan says what a company may *do*, not how well its front door locks.
This is the fourth packet to reach that conclusion by the same route, which makes it
a pattern rather than a coincidence.

**Removing a factor is step-up-gated; adding one is not.** Adding protection to your
own account is never the dangerous direction, and friction there is how you get
people who never turn it on.

## 5. Domain events

| Event | Payload | Idempotency key | Consumers |
|---|---|---|---|
| `session.revoked` | userId, sessionId, actor, reason | `session.revoked:<sessionId>` | notifications — the user is told a session ended and by whom |
| `mfa.enrolled` / `mfa.removed` | userId, factor kind | `mfa.<verb>:<userId>:<occurrence>` | notifications — **always email**, because if it was not you, this is the only warning you get |
| `auth.suspicious_activity` | userId, kind (`token_reuse` \| `lockout`), counts | per occurrence | notifications to the user; an Action Centre item for operators |
| `mfa.reset_by_operator` | userId, operator, reason | `mfa.reset:<userId>:<occurrence>` | notifications — **unconditional email to the holder**, because this is the one path that removes their protection without them |

There is deliberately **no `support_access.*` event**, because §13.3 decided the
capability does not exist. Recorded as an absence rather than left as an omission:
the difference between "we never built it" and "we decided not to" is invisible in
a codebase and decisive during an incident.

**Each of these is a notification a user cannot turn off.** The notifications packet's
rule is that preferences govern *email and push*, never the in-product row; this
domain goes one step further and makes the email itself unconditional for the four
events above. A security alert somebody silenced by accident six months ago is not a
preference being respected, it is the alarm being disconnected.

## 6. Notification matrix

| Event | Recipient | Channel | Urgency | Digest / quiet hours |
|---|---|---|---|---|
| Second factor enrolled or removed | the account holder | in-product + **email, unconditional** | `URGENT` | **bypasses both** |
| Password changed or reset | the account holder | in-product + **email, unconditional** | `URGENT` | bypasses both |
| Refresh-token reuse detected | the account holder | in-product + email | `URGENT` | bypasses both |
| Sessions revoked by an operator | the account holder | in-product + email | `NORMAL` | normal rules — a human did this deliberately and can explain it |
| An operator reset your second factor | the account holder | in-product + **email, unconditional** | `URGENT` | bypasses both |
| Repeated failed sign-ins | the account holder | in-product + email, **once per window** | `NORMAL` | rate-limited itself, or the alarm becomes the attack |

**That last row is a trap worth naming.** An email per failed attempt turns the
sign-in form into a mail bomb aimed at any address an attacker chooses. One
notification per lockout window, never one per attempt.

**This adds a second `URGENT` category.** The notifications packet observed that
exactly one kind was `URGENT` and that it was deliberately an operator alert rather
than a customer one — "their work will still be there at 8am". Account security is
the stated exception: somebody else changing your credentials will not still be fine
at 8am.

## 7. Data classification + retention

Everything here is **personal and security-sensitive**, and none of it is ever
client-visible, exportable, or present in a portal payload.

| Data | Classification | Retention |
|---|---|---|
| Password hash, TOTP secret, recovery-code hashes | secret — unreadable by design | life of the account |
| Session rows | personal | pruned after expiry plus a short forensic tail, so "when did that device last sign in" survives the token |
| Session **metadata** (approximate location, device label) | personal, coarse | with the session |
| Failed-attempt counters | operational | expire with their window; **not** a retained history of somebody's typing |
| Security audit rows (enrol, revoke, grant) | evidence | **insert-only, and outside the customer audit-retention purge** |

**The retention exception is deliberate.** Customer audit retention is a plan feature
(Crew gets 0) and an external purge honours it. Security events must not be purgeable
by the tenant they concern, or the cheapest way to erase evidence of a compromise is
to downgrade the plan. They live in `platform_audit_logs`, which is already
insert-only and already outside that purge.

**A device label is user-supplied and coarse by choice.** Storing a precise IP history
against every session builds a log of a person's movements to solve a problem a
city-level hint solves — and that log is then a thing that can leak.

## 8. Offline / conflict policy

Authentication is **online-only, and that is the design**. The field client already
holds a refresh token and captures work offline against a previously established
session; it does not authenticate offline and must never be able to. Sessions are not
offline-editable, and a revocation applies the moment the device is next online —
which is the honest bound and should be stated to operators as such, because
"revoked" reads as instant and is not.

**The offline consequence worth naming:** a revoked session does not stop a stolen
phone in airplane mode from *reading* what the app already cached. The answer is
device-level encryption and a short cached-data window, not a promise the server
cannot keep.

## 9. Failure matrix

| Failure | Retryable? | What the user sees | Repair |
|---|---|---|---|
| Wrong password | yes, within the window | the same generic failure an unknown address produces | try again |
| Too many attempts | after the window | how long until they can retry, and nothing about whether the address exists | wait, or reset |
| Wrong TOTP code | yes, within a small budget | "that code did not match" | retry, or spend a recovery code |
| Lost device, has recovery codes | n/a | spend one; it is consumed and cannot be reused | re-enrol, regenerate the set |
| **Lost device, no recovery codes** | n/a | told to contact support, and *not* told the account is unrecoverable | a super admin resets the factor with a reason; the holder is emailed unconditionally and the reset is platform-audited (§13.2) |
| Refresh-token reuse detected | no | signed out everywhere, told why | sign in again; change the password if it was not them |
| Signing secret rotated | n/a | nothing — overlapping validation means no forced logout | none |

**Sign-in failures are deliberately indistinguishable.** "No account with that
address" is a free account-existence oracle, and this product already refused to build
one for company names in §3.1.1 for exactly that reason. Wrong password, unknown
address and locked account must produce one message **and one timing profile**.

> **The bodies already match; the timings do not.** `login()` carries the comment
> *"Constant-ish: still run verify to avoid trivial user-enumeration timing"* and then
> does the opposite — it throws immediately when no user is found, and only reaches
> bcrypt when one exists. bcrypt is deliberately slow (~800ms in this project's own
> test output), so an unknown address answers in milliseconds and a known one takes
> most of a second. **That is not a subtle side channel, it is a account-existence
> oracle with a 100× signal**, readable from a browser, on an endpoint with no rate
> limit. The comment describes the correct design; the code never implemented it.

## 10. Security / threat model

**Tenant boundary.** Already strong, and stated here so it stays that way: the active
company arrives as `X-Company-Id`, is validated against an `ACTIVE` membership on
every request, and the role comes from that row rather than from the token — so a
forged or stale claim cannot elevate anybody. Every read is scoped by
`owner_company_id` or by an engagement edge. The residual risk is not the check but a
*future route that forgets it*, which is why `policies.ts` is the only place the four
checks are expressed.

**The open holes, named.**

1. **No login rate limit.** Unlimited guesses against single-factor accounts, and no
   record that it happened. The highest-severity item in this packet.
2. **No second factor anywhere**, including super admins who can read every tenant.
3. **Refresh reuse is silent.** Rotation is already implemented, but a replayed
   retired token is answered with the same 401 an expired one gets, and the real
   session keeps running — so the clearest evidence of theft the product could
   collect is discarded. `refresh_tokens` also has no lineage column, so revoking a
   compromised family is not expressible today.
4. **`app.use(cors())` allows every origin.** Combined with bearer tokens held in
   browser storage, any page the user visits can call the API with their token. Not in
   the §42 bullet list; it belongs in this packet regardless.
5. **No security headers and no explicit body limit** beyond Express's defaults.
6. **A single static JWT secret with no key id**, so rotation means signing out every
   user on the platform simultaneously — which means, in practice, that it never
   happens.
7. ~~**Support access is undefined.**~~ **Closed by decision on 2026-08-19 (§13.3):
   there is no impersonation and no per-tenant operator read, now or by default
   later.** The hole was never the missing capability — it was that "we never built
   it" and "we decided not to" behave identically until somebody is asked to add it
   in a hurry during an incident. It is now the latter, in writing.

**Secret rotation.** Access tokens gain a `kid` header; the verifier accepts any key in
a small active set while signing only with the current one. Rotation becomes
publish-new → sign-with-new → retire-old-after-one-access-TTL, and nobody is logged
out. Refresh tokens need no such scheme: they are opaque and their hash is the record,
so rotating the *signing* secret does not touch them.

**Rate limiting is Postgres-backed, not in-process.** Two reasons, and the second is
the real one: the API runs more than one instance, so an in-memory counter is a
per-instance counter and the limit is silently multiplied by the instance count; and
this phase has already committed to moving derived state *off* process-local storage
(the outbox scheduler, the lazy expiries), so a new process-local dependency would be
work to undo. There is no Redis in the stack and this does not justify introducing one.

**What rate limiting must not do.** It must not become an availability weapon. A limit
keyed only on the email address lets an attacker lock any user out by guessing wrong at
them. The limit is therefore keyed on **both** the address and the source, with the
address-keyed budget the looser of the two, and a genuine lockout notifies the account
holder rather than silently succeeding for the attacker.

## 11. Analytics contract

Sign-in success rate, MFA enrolment rate among privileged accounts, lockouts per day,
refresh-reuse detections per day, operator-initiated factor resets per month, and the
age of the oldest active signing key.

**Operator factor resets are a metric on purpose.** §13.2 accepted a path that lets an
operator remove a customer's protection; a number that climbs is the early warning that
the path is being used as a convenience rather than as a last resort.

**Excluded as sensitive, explicitly:** any password or code material even in hashed
form, precise IP addresses, full user-agent strings, and anything correlating a named
person with a location. The metric is "how many lockouts", never "who, and where".

## 12. Acceptance script

**Persona: Dana, a company owner. Ola, a platform operator. And an attacker with a
leaked password list.**

1. **Empty.** An existing account with no second factor signs in exactly as before.
   *The majority never meets this domain, and on the day it ships nothing changes for
   them.*
2. **Rate limited.** Repeated wrong passwords are refused with a wait; the message is
   identical to the one an unknown address produces; and the account holder is emailed
   **once** rather than once per attempt.
3. **Not an oracle.** An unknown address, a wrong password and a locked account are
   indistinguishable in body, status and timing.
4. **Not a weapon.** An attacker hammering Dana's address cannot lock Dana out of her
   own live session on her own device.
5. **Enrolled.** Dana enrols TOTP; enrolment is incomplete until she produces a correct
   code; recovery codes are displayed exactly once and never again.
6. **Denied.** Removing the factor without step-up re-authentication is refused. A
   MEMBER cannot revoke anybody's sessions. A non-super-admin cannot reset anybody's
   second factor.
7. **Recovered.** A recovery code signs her in once, is consumed, and cannot be reused.
   Regenerating the set invalidates every old code.
8. **Sessions.** Dana sees her own sessions and no one else's; another user's session id
   is a 404. Ending one stops that device's next refresh.
9. **Rotation.** A refresh exchanges for a successor; replaying the retired token after
   the grace window revokes the whole family and emails her.
10. **Secret rotation.** A key is rotated with both keys active: tokens signed by the old
    key still verify, new tokens carry the new `kid`, and **nobody is signed out**.
    Asserted by holding a live session across the rotation.
11. **No back door.** There is no route by which Ola can read one tenant's records or
    act as one of its users — asserted as an *absence*, by walking the platform surface
    and finding only aggregates and metadata. Ola resetting Dana's lost second factor
    requires a reason, emails Dana unconditionally, and lands in `platform_audit_logs`;
    it grants Ola no access to Dana's data at any point.
12. **Correction.** Everything above is reversible by the account holder without an
    operator: remove the factor, regenerate codes, end sessions, revoke a grant.

## 13. Decisions — answered 2026-08-19

All three were put to the owner with options costed and a recommendation. All three
recommendations were taken. Recorded with their alternatives, because a decision
whose rejected options are lost reads a year later like something nobody considered.

- [x] **1. Who must hold a second factor? → Super admins mandatory, customer
  OWNER/ADMIN optional but offered.** Rejected: super-admins-only, which leaves every
  customer's money-moving account on a password alone — and customer accounts are
  where the actual losses happen. Also rejected *for now*: a per-company policy toggle
  letting an owner mandate MFA for their own admins. That is a policy engine, it can
  be added on top of this without redoing it, and buying it before anyone has asked is
  the definition of a shape with no reader. **Crew-plan field accounts are out of
  scope**, per §1: the persona that logs hours from a car park gets no new friction.

- [x] **2. Device and recovery codes both lost? → A super admin can reset the factor**,
  with a reason, an unconditional email to the account holder and a platform-audit
  row. Rejected: genuinely unrecoverable. It is stronger on paper and worse in
  practice — a lost phone would destroy a company owner's access to their own books,
  and the realistic outcome is somebody doing it directly against the database,
  unlogged. Better that the path exists, is narrow, and is recorded. The cost is
  stated rather than hidden: **this makes the operator the weakest link**, which is
  precisely why decision 1 puts those same operators under mandatory MFA, and why §11
  counts resets as a metric.

- [x] **3. Does platform support access exist? → No. No impersonation, and no
  per-tenant operator read.** Operators keep the aggregate and metadata views they
  already have; a customer problem is diagnosed from audit rows and logs. Rejected:
  time-boxed customer-notified read-only grants — a real capability with real work and
  no support organisation yet to need it. Rejected outright: full impersonation, which
  makes every operator account equivalent to every customer account. **Revisit only
  when a real support case proves the aggregate views insufficient**, and not by
  reaching for (c) when it does.

## 14. Build order

Nothing here needs another decision. Ordered by severity from §10 rather than by
convenience:

1. **Rate limiting** (login, reset, register), Postgres-backed, keyed on address *and*
   source, with the lockout notification itself rate-limited. Plus the CORS origin
   allowlist, security headers and an explicit body limit — small, and they close §10.4
   and §10.5 in the same pass.
2. **Refresh rotation with reuse detection**, and self-service session/device
   management on top of it.
3. **MFA**: TOTP with recovery codes, mandatory for super admins, offered to customer
   OWNER/ADMIN, plus the operator reset path from §13.2.
4. **`kid`-based signing-secret rotation**, asserted by holding a live session across
   a rotation.
