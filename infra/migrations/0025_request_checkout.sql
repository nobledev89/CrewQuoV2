-- The additional-company checkout (§3.1.1(3)).
--
-- A checkout attempt has exactly one subject, and for this flow that subject is
-- **a request, not a company** — the whole point is that the tenant does not
-- exist yet and the payment is what authorises bringing it into existence. So
-- `company_id` stops being mandatory and a second, mutually exclusive subject
-- column joins it, rather than a nullable company id that means two things.

alter table billing_checkouts
  alter column company_id drop not null;

alter table billing_checkouts
  add column if not exists company_creation_request_id uuid
    references company_creation_requests(id) on delete cascade;

-- Exactly one subject, enforced rather than documented: a row with both would
-- make "what did this payment buy" ambiguous, and a row with neither is a
-- payment attributable to nobody.
alter table billing_checkouts
  drop constraint if exists billing_checkouts_one_subject_chk;
alter table billing_checkouts
  add constraint billing_checkouts_one_subject_chk
  check ((company_id is not null) <> (company_creation_request_id is not null));

-- One live attempt per request. Without this, two clicks produce two Paddle
-- transactions against one approval, and whichever completes second is a charge
-- for a company slot the payer already owns.
create unique index if not exists billing_checkouts_request_live_uidx
  on billing_checkouts (company_creation_request_id)
  where company_creation_request_id is not null and status in ('CREATING', 'PENDING');

create index if not exists billing_checkouts_request_idx
  on billing_checkouts (company_creation_request_id, created_at desc)
  where company_creation_request_id is not null;

comment on column billing_checkouts.company_creation_request_id is
  'Set instead of company_id when the payment authorises an additional company that does not exist yet.';
