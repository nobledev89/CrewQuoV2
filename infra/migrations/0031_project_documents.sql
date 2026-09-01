-- Project documents (CREWQUO_V2_PLAN.md §24) — step 5 of the Phase 7 build order
-- in docs/operating-model/project-evidence.md §14.
--
-- A DOCUMENT IS A CHAIN, NOT AN EDIT (packet §3). A new version inserts a row
-- with `supersedes_id` pointing at the old one, which stays and is hidden by
-- default. There is deliberately no update path for `file_id` — not in the API,
-- and nothing here that would make one easy to add. A document whose bytes can be
-- replaced in place is a document whose history is a claim rather than a record,
-- and waste transfer notes are precisely the documents somebody is later asked to
-- prove.

create table if not exists project_documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,

  -- Who uploaded it. NOT who it is about — that is `provider_company_id` below,
  -- and the two are different questions on the same row for the same reason
  -- `stored_files.company_id` is not the billing key.
  company_id uuid not null references companies(id),
  file_id uuid not null references stored_files(id),

  category text not null check (category in
    ('RAMS','RISK_ASSESSMENT','METHOD_STATEMENT','INSURANCE','PURCHASE_ORDER','DRAWING',
     'SITE_INSTRUCTION','WASTE_TRANSFER_NOTE','WEIGHBRIDGE_TICKET','RECYCLING_CERTIFICATE',
     'DONATION_RECEIPT','DELIVERY_NOTE','COLLECTION_NOTE','CLIENT_SIGNOFF','INCIDENT','OTHER')),
  title     text not null,
  reference text,                                   -- WTN number, PO number, ticket number
  notes     text,

  version int not null default 1,
  supersedes_id uuid references project_documents(id),

  issued_on  date,
  expires_on date,

  -- THE SUBCONTRACTOR THIS DOCUMENT IS ABOUT, and the column that decides who may
  -- read it. Null means project-wide — the site RAMS, the drawings, the things
  -- everybody working here has to follow. Set means it belongs to one provider:
  -- their insurance certificate is not the other trades' business.
  --
  -- The API defaults it to the uploader's own company when a PROVIDER uploads,
  -- because the alternative default — null — publishes a subcontractor's own
  -- paperwork to every other subcontractor on the job, which is the kind of
  -- disclosure nobody would choose and everybody would ship.
  provider_company_id uuid references companies(id),

  location_id uuid references project_locations(id),
  client_visible boolean not null default false,

  -- Nullable, for the closure decision of 2026-08-20: deletion anonymises the
  -- person and preserves the record. §24 writes `not null`; a `not null` here
  -- would make closing an account either impossible or destructive of a document
  -- somebody is required to retain.
  uploaded_by_user_id uuid references users(id) on delete set null,

  -- The sync contract's two columns (0029, item 7.7).
  revision int not null default 1,
  deleted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint project_documents_not_own_predecessor
    check (supersedes_id is null or supersedes_id <> id),
  -- A typo, not a record. Caught here as well as in the API because a hand-written
  -- correction is exactly where an inverted pair of dates gets in.
  constraint project_documents_expiry_after_issue
    check (issued_on is null or expires_on is null or expires_on >= issued_on)
);

-- ── One successor per version, which is what makes it a chain ────────────────
--
-- Two people re-issuing the same RAMS at once would otherwise leave two version
-- 2s claiming to replace one version 1, and "which is current" stops having an
-- answer — in a category where the answer is what somebody on site is relying on.
--
-- THE DATABASE IS THE ARBITER, NOT THE ROUTE. The API refuses an already-superseded
-- document with a message a person can act on, but that check is check-then-act
-- and the sync contract already caught two of those in this phase. A unique index
-- makes the fork impossible rather than merely refused.
create unique index if not exists project_documents_one_successor_idx
  on project_documents (supersedes_id)
  where supersedes_id is not null and deleted_at is null;

-- §24's two indexes, with the tombstone filter every read carries.
create index if not exists project_documents_project_category_idx
  on project_documents (project_id, category) where deleted_at is null;
create index if not exists project_documents_expiry_idx
  on project_documents (expires_on) where expires_on is not null and deleted_at is null;
create index if not exists project_documents_provider_idx
  on project_documents (project_id, provider_company_id) where deleted_at is null;
create index if not exists project_documents_location_idx
  on project_documents (location_id) where location_id is not null and deleted_at is null;

-- The revision trigger from 0029, reused rather than reimplemented.
drop trigger if exists project_documents_bump_revision on project_documents;
create trigger project_documents_bump_revision
  before update on project_documents
  for each row execute function bump_revision();

-- ── What is deliberately NOT here ────────────────────────────────────────────
--
-- No `superseded` boolean. A row is superseded exactly when another live row
-- points at it, which is a join — and a stored flag beside `supersedes_id` is two
-- answers to one question that disagree the first time a bad version is retracted.
-- Deleting a wrongly-issued v2 must restore v1 to current with nothing to
-- back-fill, and a derived answer does that for free.
--
-- No `expiring_notified_at` either. The expiry pass re-enqueues
-- `document.expiring` with the idempotency key (document, threshold) every time it
-- runs; `delivery_outbox` already refuses the duplicate, so a column tracking what
-- has been sent would be a second, weaker copy of a fact the outbox holds
-- authoritatively — and one that goes wrong the moment a send is retried.
comment on column project_documents.provider_company_id is
  'The subcontractor this document is ABOUT (§24), which is not necessarily who uploaded it. Null means project-wide and readable by both hops; set means readable by the project owner and that provider only.';
