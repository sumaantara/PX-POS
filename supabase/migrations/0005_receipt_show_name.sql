-- Option: hide the business name on receipts (e.g. when the logo already shows it)
alter table public.settings add column if not exists receipt_show_name boolean not null default true;
