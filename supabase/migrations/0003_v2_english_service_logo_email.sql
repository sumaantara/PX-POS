-- PX POS v2: English messages, service charge, receipt logo + thank-you text, daily sales email settings.
-- Safe to run more than once.

-- ── settings ────────────────────────────────────────────────
alter table public.settings add column if not exists service_percent numeric(5,2) not null default 0;
alter table public.settings add column if not exists service_label   text not null default 'Service';
alter table public.settings add column if not exists tax_label       text not null default 'Tax';
alter table public.settings add column if not exists thank_you       text not null default 'Thank you for your visit!';
alter table public.settings add column if not exists logo_data       text not null default '';
alter table public.settings add column if not exists report_enabled  boolean not null default false;
alter table public.settings add column if not exists report_hour     int not null default 22;
alter table public.settings add column if not exists report_emails   text[] not null default '{}';

do $$ begin
  alter table public.settings add constraint settings_service_pct check (service_percent >= 0 and service_percent <= 100);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.settings add constraint settings_logo_size check (length(logo_data) <= 300000);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.settings add constraint settings_report_hour check (report_hour between 0 and 23);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.settings add constraint settings_report_emails check (cardinality(report_emails) <= 20);
exception when duplicate_object then null; end $$;

update public.settings set receipt_footer = 'Please keep this receipt.' where receipt_footer = 'Terima kasih! Thank you!';

-- ── transactions ────────────────────────────────────────────
alter table public.transactions add column if not exists service_charge numeric(14,0) not null default 0;

-- ── daily email log + scheduler secret ──────────────────────
create table if not exists public.report_log (
  id          bigserial primary key,
  day         date not null,
  sent_at     timestamptz not null default now(),
  kind        text not null default 'scheduled' check (kind in ('scheduled','manual')),
  recipients  text[] not null default '{}',
  ok          boolean not null,
  error       text
);
alter table public.report_log enable row level security;
drop policy if exists report_log_read on public.report_log;
create policy report_log_read on public.report_log for select to authenticated using (public.px_is_admin());

create schema if not exists px_private;
revoke all on schema px_private from public, anon, authenticated;
create table if not exists px_private.secrets (
  id int primary key default 1 check (id = 1),
  cron_key text not null default encode(gen_random_bytes(24), 'hex')
);
insert into px_private.secrets (id) values (1) on conflict do nothing;
alter table px_private.secrets enable row level security;  -- no policies: only the owner / service role can read it
grant usage on schema px_private to service_role;
grant select on px_private.secrets to service_role;

-- ── business functions (English messages, service charge) ───
create or replace function public.create_sale(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_role text := public.px_role();
  s public.settings;
  it jsonb; svc public.services; cat public.categories;
  v_price numeric; v_qty numeric; v_start timestamptz; v_due timestamptz;
  v_sub numeric := 0; v_disc numeric; v_srv numeric; v_tax numeric; v_total numeric; v_paid numeric;
  v_no text; v_n int; v_day date := (now() at time zone 'Asia/Makassar')::date;
  v_tx uuid; v_shift uuid; v_method text;
begin
  if my_role is null then raise exception 'Your account is not active'; end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'The cart is empty';
  end if;
  select * into s from public.settings where id = 1;
  v_method := coalesce(nullif(p->>'payment_method',''), 'Cash');
  if not (v_method = any(s.payment_methods)) then raise exception 'Unknown payment method: %', v_method; end if;

  for it in select * from jsonb_array_elements(p->'items') loop
    select * into svc from public.services where id = (it->>'service_id')::uuid;
    if not found or not svc.active then raise exception 'Service is not available'; end if;
    v_qty := coalesce((it->>'qty')::numeric, 1);
    if v_qty <= 0 or v_qty > 1000 then raise exception 'Invalid quantity'; end if;
    v_price := svc.price;
    if it ? 'price' and (it->>'price')::numeric <> svc.price then
      if my_role not in ('owner','admin') then raise exception 'Only an admin can change prices'; end if;
      v_price := (it->>'price')::numeric;
      if v_price < 0 then raise exception 'Invalid price'; end if;
    end if;
    v_sub := v_sub + round(v_price * v_qty);
  end loop;

  v_disc := greatest(0, coalesce((p->>'discount')::numeric, 0));
  if v_disc > v_sub then raise exception 'Discount is larger than the subtotal'; end if;
  if my_role = 'cashier' and v_sub > 0 and v_disc > v_sub * s.max_discount_pct / 100 then
    raise exception 'Cashier discount limit is % percent', s.max_discount_pct;
  end if;
  v_srv   := round((v_sub - v_disc) * s.service_percent / 100);
  v_tax   := round((v_sub - v_disc + v_srv) * s.tax_percent / 100);
  v_total := v_sub - v_disc + v_srv + v_tax;
  v_paid  := coalesce((p->>'amount_paid')::numeric, v_total);
  if v_paid < v_total then raise exception 'Amount paid is less than the total'; end if;

  insert into public.receipt_counters as c (day, n) values (v_day, 1)
    on conflict (day) do update set n = c.n + 1 returning n into v_n;
  v_no := s.receipt_prefix || to_char(v_day, 'YYMMDD') || '-' || lpad(v_n::text, 4, '0');

  select id into v_shift from public.shifts where cashier_id = me and closed_at is null;

  insert into public.transactions (receipt_no, cashier_id, shift_id, customer_name, customer_phone, customer_note,
      subtotal, discount, service_charge, tax, total, payment_method, amount_paid, change_amount)
  values (v_no, me, v_shift, left(coalesce(p->>'customer_name',''),80), left(coalesce(p->>'customer_phone',''),30),
      left(coalesce(p->>'customer_note',''),200), v_sub, v_disc, v_srv, v_tax, v_total, v_method, v_paid, v_paid - v_total)
  returning id into v_tx;

  for it in select * from jsonb_array_elements(p->'items') loop
    select * into svc from public.services where id = (it->>'service_id')::uuid;
    select * into cat from public.categories where code = svc.category;
    v_qty := coalesce((it->>'qty')::numeric, 1);
    v_price := case when it ? 'price' and my_role in ('owner','admin') then (it->>'price')::numeric else svc.price end;
    v_start := coalesce((it->>'start_at')::timestamptz, now());
    v_due := case
      when svc.unit = 'day'  then v_start + make_interval(hours => (v_qty * 24)::int)
      when svc.unit = 'hour' then v_start + make_interval(mins => (v_qty * 60)::int)
      when svc.duration_hours is not null then v_start + make_interval(mins => (svc.duration_hours * 60)::int)
      else null end;
    insert into public.transaction_items (transaction_id, service_id, category, name, unit, price, qty, line_total,
        item_ref, note, start_at, due_at, rental_status)
    values (v_tx, svc.id, svc.category, svc.name, svc.unit, v_price, v_qty, round(v_price * v_qty),
        left(coalesce(it->>'item_ref',''),60), left(coalesce(it->>'note',''),200), v_start, v_due,
        case when cat.is_rental then 'out' else 'none' end);
  end loop;

  return jsonb_build_object('id', v_tx, 'receipt_no', v_no, 'total', v_total, 'change', v_paid - v_total);
end $$;

create or replace function public.void_sale(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.px_is_admin() then raise exception 'Only an admin can void sales'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  update public.transactions set status = 'void', void_reason = p_reason, voided_by = auth.uid(), voided_at = now()
   where id = p_id and status = 'paid';
  if not found then raise exception 'Sale not found or already void'; end if;
  update public.transaction_items set rental_status = 'returned', returned_at = now(), returned_by = auth.uid()
   where transaction_id = p_id and rental_status = 'out';
end $$;

create or replace function public.return_rental(p_item uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.px_role() is null then raise exception 'Your account is not active'; end if;
  update public.transaction_items set rental_status = 'returned', returned_at = now(), returned_by = auth.uid()
   where id = p_item and rental_status = 'out';
  if not found then raise exception 'Rental not found or already returned'; end if;
end $$;

create or replace function public.open_shift(p_cash numeric) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if public.px_role() is null then raise exception 'Your account is not active'; end if;
  if exists (select 1 from public.shifts where cashier_id = auth.uid() and closed_at is null) then
    raise exception 'You already have an open shift';
  end if;
  insert into public.shifts (cashier_id, opening_cash) values (auth.uid(), greatest(0, coalesce(p_cash,0))) returning id into v;
  return v;
end $$;

create or replace function public.shift_summary(p_shift uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare sh public.shifts; r jsonb;
begin
  if p_shift is null then
    select * into sh from public.shifts where cashier_id = auth.uid() and closed_at is null;
  else
    select * into sh from public.shifts where id = p_shift;
  end if;
  if not found then return null; end if;
  if sh.cashier_id <> auth.uid() and not public.px_is_admin() then raise exception 'Not allowed'; end if;
  select jsonb_build_object(
    'shift', to_jsonb(sh),
    'count', count(*) filter (where status='paid'),
    'void_count', count(*) filter (where status='void'),
    'total', coalesce(sum(total) filter (where status='paid'),0),
    'cash_sales', coalesce(sum(total) filter (where status='paid' and payment_method='Cash'),0),
    'by_method', coalesce((select jsonb_object_agg(payment_method, s) from (
        select payment_method, sum(total) s from public.transactions where shift_id = sh.id and status='paid' group by 1) m), '{}'::jsonb)
  ) into r from public.transactions where shift_id = sh.id;
  return r;
end $$;

create or replace function public.close_shift(p_cash numeric, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sh public.shifts; summ jsonb; expected numeric;
begin
  select * into sh from public.shifts where cashier_id = auth.uid() and closed_at is null;
  if not found then raise exception 'No open shift'; end if;
  summ := public.shift_summary(sh.id);
  expected := sh.opening_cash + (summ->>'cash_sales')::numeric;
  update public.shifts set closed_at = now(), closing_cash = greatest(0, coalesce(p_cash,0)), expected_cash = expected,
      note = coalesce(p_note,'') where id = sh.id;
  return public.shift_summary(sh.id);
end $$;

-- Sales report (local WITA dates). Admins, or the service role (daily email function).
create or replace function public.sales_report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  -- (security definer: current_user is always the owner, so check the API role / session user instead)
  if not (public.px_is_admin() or coalesce(auth.role(), '') = 'service_role' or session_user = 'postgres') then
    raise exception 'Admins only';
  end if;
  with tx as (
    select * from public.transactions
     where (created_at at time zone 'Asia/Makassar')::date between p_from and p_to
  ), paid as (select * from tx where status = 'paid'),
  items as (select i.* from public.transaction_items i join paid t on t.id = i.transaction_id)
  select jsonb_build_object(
    'count',      (select count(*) from paid),
    'void_count', (select count(*) from tx where status='void'),
    'void_total', (select coalesce(sum(total),0) from tx where status='void'),
    'gross',      (select coalesce(sum(subtotal),0) from paid),
    'discount',   (select coalesce(sum(discount),0) from paid),
    'service',    (select coalesce(sum(service_charge),0) from paid),
    'tax',        (select coalesce(sum(tax),0) from paid),
    'total',      (select coalesce(sum(total),0) from paid),
    'by_category',(select coalesce(jsonb_agg(x order by (x->>'total')::numeric desc),'[]') from (
                    select jsonb_build_object('category', category, 'qty', sum(qty), 'total', sum(line_total)) x
                    from items group by category) a),
    'by_service', (select coalesce(jsonb_agg(x),'[]') from (
                    select jsonb_build_object('category', category, 'name', name, 'qty', sum(qty), 'total', sum(line_total)) x
                    from items group by category, name order by sum(line_total) desc) a),
    'by_method',  (select coalesce(jsonb_agg(x),'[]') from (
                    select jsonb_build_object('method', payment_method, 'count', count(*), 'total', sum(total)) x
                    from paid group by payment_method order by sum(total) desc) a),
    'by_cashier', (select coalesce(jsonb_agg(x),'[]') from (
                    select jsonb_build_object('cashier', coalesce(pr.full_name,'?'), 'count', count(*), 'total', sum(p.total)) x
                    from paid p left join public.profiles pr on pr.id = p.cashier_id group by pr.full_name order by sum(p.total) desc) a),
    'by_day',     (select coalesce(jsonb_agg(x order by x->>'day'),'[]') from (
                    select jsonb_build_object('day', (created_at at time zone 'Asia/Makassar')::date, 'count', count(*), 'total', sum(total)) x
                    from paid group by (created_at at time zone 'Asia/Makassar')::date ) a)
  ) into r;
  return r;
end $$;
grant execute on function public.sales_report(date,date) to service_role;

create or replace function public.px_guard_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if (old.role = 'owner' or new.role = 'owner') and coalesce(public.px_role(),'') <> 'owner' then
    raise exception 'Only the owner can change owner accounts';
  end if;
  if old.role = 'owner' and (new.role <> 'owner' or not new.active)
     and (select count(*) from public.profiles where role = 'owner' and active and id <> old.id) = 0 then
    raise exception 'There must be at least one active owner';
  end if;
  if old.id = auth.uid() and (new.role <> old.role or new.active <> old.active) then
    raise exception 'You cannot change your own role or status';
  end if;
  return new;
end $$;

-- English names for the seeded services (only if they still have the original names)
update public.services set name = 'Bike Rental (per day)'   where name = 'Rent Bike (per hari)';
update public.services set name = 'E-Bike Rental (per day)' where name = 'E-Bike (per hari)';
update public.services set name = 'Laundry (per kg)', description = '' where name = 'Laundry (per kg)' and description like 'Harga contoh%';
update public.services set name = 'Private Snorkeling 2 Hours' where name = 'Snorkeling Private 2 Jam';
update public.services set name = 'Private Snorkeling 3 Hours' where name = 'Snorkeling Private 3 Jam';
update public.services set name = 'Private Snorkeling 4 Hours' where name = 'Snorkeling Private 4 Jam';
update public.categories set name = 'Bike Rental' where code = 'rent_bike' and name = 'Rent Bike';

-- The daily-report function checks the scheduler key through this (px_private is not exposed over the API).
create or replace function public.px_check_cron_key(k text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from px_private.secrets where id = 1 and cron_key = k)
$$;
revoke all on function public.px_check_cron_key(text) from public, anon, authenticated;
grant execute on function public.px_check_cron_key(text) to service_role;
