-- PX POS: Google review QR at the bottom of each outlet's receipt
alter table public.outlets add column if not exists review_url  text not null default '';
alter table public.outlets add column if not exists review_text text not null default 'Enjoyed your visit? Scan to review us on Google';
do $$ begin
  alter table public.outlets add constraint outlets_review_url check (review_url = '' or review_url ~ '^https://');
exception when duplicate_object then null; end $$;
