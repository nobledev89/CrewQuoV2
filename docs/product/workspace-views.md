# Workspace views

Status: implemented 2026-08-18  
Decision source: `CREWQUO_V2_PLAN.md` §9.2

## Product boundary

CrewQuo has exactly three customer views: `OPERATIONS`, `SUBCONTRACTOR`, and
`CLIENT`. A view is a navigation lens over the active company. It changes the
landing page, vocabulary, navigation, and default filters; it is not a membership
role, tenant, route tree, or authorization input. Platform Admin and Account setup
are application states outside those three views.

Eligibility is derived server-side:

- Operations: the company's effective subscription, trial, comp, or feature
  override grants operational capability.
- Subcontractor: the company has a direct provider-side relationship or project
  assignment.
- Client: the company has a direct provider-created client relationship or a
  client-visible portal project.

The API continues to authorize every request from membership, role, company edge,
resource scope, and entitlement. A selected view is never sent as proof of access.

## Route and action inventory

| Surface | View | Purpose and action boundary |
|---|---|---|
| `/app` | Operations | Operating overview and operational decision queues |
| `/projects`, `/projects/:id` | Operations | Create/manage projects, crew, costs, reports, settings |
| `/review` | Operations | Review and approve submitted downstream work |
| `/audit` | Operations | Internal audit/reporting subject to entitlement |
| `/network/providers` | Operations | Add and manage subcontractors |
| `/network/clients` | Operations | Add and manage portal clients |
| `/rates/*` | Operations | Roles, private cards, templates, and resolution |
| `/work` | Subcontractor | Assigned jobs, own time/expenses, submission and assignment decisions |
| `/portal`, `/portal/:id` | Client | Only provider-published projects and BILL-side client data |
| `/commercial` | Shared by Operations/Subcontractor | Hiring-side approval/direct entry or provider-side proposal; API edge determines actions |
| `/network/engagements` | Shared by Operations/Subcontractor | Direct relationship status and acceptance |
| `/invoices` | Shared by Operations/Client | Provider management in Operations; issued-only read surface in Client |
| `/settings` | Shared account/company | Company settings allowed by membership role |
| `/company/members` | Shared account/company | Team controls allowed by membership role |
| `/profile`, `/plan` | Shared account/company | Identity, company memberships, plan and usage |
| `/admin/*` | Platform Admin | Internal platform console; never a customer view |
| auth, invite, verification | Application state | Public/authenticated transition into a valid company/view |

Future project-local modules join the appropriate project rail instead of adding
top-level navigation. Client project detail remains the structurally filtered
`/portal/:id` record; subcontractor job detail remains within `/work`. Consequently,
neither can expose the Operations project rail, PAY/BILL counterpart figures, margin,
unrelated providers, or unpublished client data.

## Navigation and selection

| View | Landing | Primary navigation (six or fewer) | Secondary destinations |
|---|---|---|---|
| Contractor | `/app` | Workspace, Commercial, Network, Rates, Reports, Company | All eligible pages remain links inside these sidebar groups |
| Subcontractor | `/work` | Work, Commercial, Company | All eligible pages remain links inside these sidebar groups |
| Client | `/portal` | Workspace, Company | All eligible pages remain links inside these sidebar groups |

The top-right View dropdown always names the current perspective and lists only the
active company's eligible Contractor, Subcontractor and Client views. Switching it
changes the landing and the complete grouped sidebar. Company switching is a separate
dropdown shown only for multi-company users and restores the selected company's last
valid view. A deep link selects its eligible view; an ineligible view-specific URL
returns to the active company's valid landing without changing API access.

A free company with no relationship or assignment gets Account setup navigation. It
does not receive an Operations sidebar made of upgrade refusals.

## Acceptance matrix

| Persona | Expected result | Automated evidence |
|---|---|---|
| Paying Contractor only | `/app`, full eligible Contractor sidebar, dropdown contains Contractor only | Browser core workflow |
| Free Subcontractor only | `/work`, subcontractor pages only, dropdown contains Subcontractor only | Browser invite workflow + resolver unit tests |
| Free Client only | `/portal`, client pages only, dropdown contains Client only | Browser portal workflow + resolver unit tests |
| Free Subcontractor + Client | View dropdown contains those two views and no Contractor | Resolver unit test |
| Paying Contractor + relationship view | View dropdown contains Contractor plus only genuine relationship views | Resolver and selection unit tests |
| One user across companies | Separate company dropdown; switching restores a valid saved/default view | Workspace read model + selection unit tests |
| Platform staff without company | Platform console only | Browser platform workflow |

The browser workflow also proves client PAY exclusion and the provider/client
one-hop data boundary. Shared tests prove stable view ordering, deduplication,
deep-link selection, invalid-view fallback, mixed views, and the no-view setup state.
