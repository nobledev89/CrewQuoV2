# Operating-model packet — access, sessions & platform security

**Domain:** who can prove they are who they say they are, for how long, from which
device, and what a platform operator may do to somebody else's tenant. Covers
authentication factors and recovery, session and device lifecycle, step-up
re-authentication, request rate limiting, signing-secret rotation, support access,
and the tenant-boundary threat model the rest of the packets assume.
**Phase:** 6 · **Status:** draft · **Last updated:** 2026-08-19
**Plan refs:** §4 (auth context), §5 (tokens), §5B (platform staff), §3.1.1(7)
(recent authentication, rate limiting, immutable decision record), §19.5 (this
packet's shape), §42 (the security-hardening bullet this answers), §44 (the test
discipline).

> **Draft, and deliberately so.** Three questions in this packet are the owner's
> rather than the implementer's, and they are marked as such in §13. Nothing is
> built against this file until they are answered — the point of writing the packet
> first is that a wrong guess here is expensive in a way a wrong guess about a
> column name is not.

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
| A support-access grant | a super admin | **the customer**, not the operator | the customer and platform audit | expiry, or customer revocation | the company |

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

**Refresh rotation is the change with teeth.** Today a refresh token is a bearer
string valid for thirty days that survives being used. Rotating it on every exchange
means a stolen token is good only until the real user next refreshes — and when both
the thief and the user present the same retired token, that is *detectable*. **Reuse
of a retired token revokes the entire family**, because the only two explanations
are theft and a client bug, and both deserve a re-login.

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
| Grant support access to a tenant | none | **super admin** | — | one company, time-boxed, reason required, customer-visible |
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
| `support_access.granted` / `.revoked` | companyId, operator, reason, expiry | per grant | notifications to the tenant's owners; platform audit |

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
| Support access granted to your company | every OWNER/ADMIN of that company | in-product + email | `URGENT` | bypasses both |
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
| **Lost device, no recovery codes** | n/a | locked out | **owner decision — §13.2** |
| Refresh-token reuse detected | no | signed out everywhere, told why | sign in again; change the password if it was not them |
| Signing secret rotated | n/a | nothing — overlapping validation means no forced logout | none |

**Sign-in failures are deliberately indistinguishable.** "No account with that
address" is a free account-existence oracle, and this product already refused to build
one for company names in §3.1.1 for exactly that reason. Wrong password, unknown
address and locked account produce one message and one timing profile.

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
3. **A refresh token is a thirty-day bearer string that survives use.** Stolen once,
   valid for a month, and undetectable.
4. **`app.use(cors())` allows every origin.** Combined with bearer tokens held in
   browser storage, any page the user visits can call the API with their token. Not in
   the §42 bullet list; it belongs in this packet regardless.
5. **No security headers and no explicit body limit** beyond Express's defaults.
6. **A single static JWT secret with no key id**, so rotation means signing out every
   user on the platform simultaneously — which means, in practice, that it never
   happens.
7. **Support access is undefined.** No impersonation exists today, which is the *good*
   default; what is missing is a written stance, because "we never built it" and "we
   decided not to" behave identically until somebody is asked to add it in a hurry
   during an incident.

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
refresh-reuse detections per day, support grants outstanding, and the age of the oldest
active signing key.

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
   MEMBER cannot revoke anybody's sessions. A non-super-admin cannot grant support
   access.
7. **Recovered.** A recovery code signs her in once, is consumed, and cannot be reused.
   Regenerating the set invalidates every old code.
8. **Sessions.** Dana sees her own sessions and no one else's; another user's session id
   is a 404. Ending one stops that device's next refresh.
9. **Rotation.** A refresh exchanges for a successor; replaying the retired token after
   the grace window revokes the whole family and emails her.
10. **Secret rotation.** A key is rotated with both keys active: tokens signed by the old
    key still verify, new tokens carry the new `kid`, and **nobody is signed out**.
    Asserted by holding a live session across the rotation.
11. **Support access.** Ola cannot reach a tenant's data without a grant; a grant requires
    a reason, expires on its own, notifies the tenant's owners at the moment it is
    created, and stays visible to them afterwards.
12. **Correction.** Everything above is reversible by the account holder without an
    operator: remove the factor, regenerate codes, end sessions, revoke a grant.

## 13. Open — owner decisions

These three are not implementation choices, and are not being guessed at.

- [ ] **1. Who must have a second factor?** Cheapest first: (a) **super admins only,
  mandatory** — smallest slice, protects the accounts that can read every tenant, and no
  customer's login flow changes at all; (b) **super admins mandatory, customer
  OWNER/ADMIN optional but offered**; (c) as (b) plus a per-company policy toggle letting
  an owner mandate it for their own admins. The work roughly doubles at each step.
  **Recommendation: (b)** — (a) leaves every customer's money-moving account on a
  password alone, and (c) is a policy engine that can be added later without redoing (b).
  Crew-plan field accounts are out of scope under all three.

- [ ] **2. What happens when somebody loses their device *and* their recovery codes?**
  Either (a) **a super admin can reset a factor**, with a reason, an unconditional email
  to the account holder and a platform-audit row — recoverable, but it means an operator
  can strip a customer's MFA, so the operator becomes the weakest link; or (b) **nobody
  can**, and the account is genuinely unrecoverable. **Recommendation: (a)**, because (b)
  means a lost phone destroys a company owner's access to their own books, and the
  realistic outcome is a support process that does it through the database anyway —
  unlogged. Better to make the path exist, narrow it, and record it.

- [ ] **3. Does support access exist at all?** (a) **No impersonation, ever** — operators
  keep the aggregate and metadata reads they already have, and a customer problem is
  diagnosed from audit rows and logs; (b) **time-boxed, reason-required,
  customer-notified read-only access** to one tenant; (c) full impersonation.
  **Recommendation: (a) for now**, revisited when a real support case proves the aggregate
  views insufficient — this is the highest-blast-radius capability in the product and
  there is currently no support organisation to need it. (c) is not recommended at any
  point without a customer-facing consent step.

Until these are answered, the buildable subset — everything needing no decision — is:
**login and reset rate limiting, refresh-token rotation with reuse detection,
self-service session and device management, a CORS origin allowlist, security headers,
and `kid`-based signing-secret rotation.** That subset also happens to close the
highest-severity holes in §10, which is a convenient accident rather than a plan.
