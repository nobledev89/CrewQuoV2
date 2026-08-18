# CrewQuo Platform admin workspace

Status: implemented 2026-08-18.

## Context and access boundary

`CrewQuo Platform` is a synthetic option in the company selector and `Super Admin` is its only view. Neither is a company, membership, subscription or customer entitlement. Platform requests omit `X-Company-Id` and are authorized by the authenticated user's `is_super_admin` flag. A super admin can therefore operate the platform with no customer-company membership.

Normal company/view contexts remain Contractor, Subcontractor and Client. Selecting a real company leaves the platform workspace and restores that company's eligible view. Deep links under `/admin/*` require Super Admin regardless of what the client displays.

## Sidebar and responsibility

| Page | Responsibility | Writes |
|---|---|---|
| Dashboard | platform totals, newest users/companies, plan mix, attention counts | none |
| Users | identity search, verification/membership/session visibility | revoke sessions; grant/revoke Super Admin |
| Companies | customer support, subscription, trials and entitlement overrides | existing company controls |
| Plans & pricing | plan, feature, limit and price catalog | existing catalog controls |
| Operations | API/config health, durable-delivery queues/dead letters, pending invites and expiring overrides | reason-required dead-letter replay |
| Reporting | acquisition, plan/subscription distribution, workflow volume | none |
| Platform audit | immutable platform-administration history | none |
| Settings | platform name/support identity and explicit access-state flags | typed setting update |
| Admin access | filtered register of Super Admin identities | same protected user access controls |

## Safeguards

- Every platform mutation records actor, action, subject, reason/change payload and timestamp in `platform_audit_logs`.
- Session revocation and Super Admin access changes require a reason.
- An admin cannot revoke their own Super Admin access, and the final Super Admin cannot be removed.
- Both the admin screen and bootstrap command accept only an existing, email-verified user; neither creates an identity, sets a password or bypasses verification.
- Settings accept only the typed branding/access contract. Secrets and arbitrary configuration keys never enter the browser.
- Company/subscription/entitlement changes continue writing the subject company's audit where applicable and additionally record the platform operator.
- Operations reads real outbox/webhook queue counts and exposes audited dead-letter replay. MoR and email remain truthfully `NOT_CONFIGURED` until their handlers exist.

## API inventory

All routes are below `/v1/admin` and require authentication plus Super Admin:

- `GET /dashboard`
- `GET /users`, `GET /users/:id`
- `POST /users/:id/revoke-sessions`
- `POST /users/:id/super-admin`
- `GET /reporting`, `GET /operations`, `GET /audit`
- `GET /settings`, `PATCH /settings`
- Existing `/companies*`, `/plans*`, `/features` and `/limits` routes

Bootstrap an existing verified identity with:

```text
pnpm --filter @crewquo/api grant-super-admin -- user@example.com
```

## Deferred integrations

The settings screen stores registration and maintenance controls but labels them as not yet enforced. Enforcement belongs with the guarded company-creation/onboarding work and production maintenance middleware. Durable queues, dead-letter/replay controls, Merchant-of-Record lifecycle, notifications, observability and support impersonation are still separate Phase 6 work; their absence is visible in Operations rather than mocked.
