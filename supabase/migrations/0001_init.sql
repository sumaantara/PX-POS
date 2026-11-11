-- PX POS — schema, security and business logic
-- Run once in the Supabase SQL editor of the PX POS project.

create extension if not exists pgcrypto;

-- ───────────────────────── Tables ─────────────────────────

create table if not exists public.settings (
  id               int primary key default 1 check (id = 1),
  business_name    text not null default 'PX',
  address          text not null default '',
  phone            text not null default '',
  receipt_header   text not null default '',
  receipt_footer   text not null default 'Terima kasih! Thank you!',
  receipt_prefix   text not null default 'PX',
  tax_percent      numeric(5,2) not null default 0 check (tax_percent >= 0 and tax_percent <= 100),
  max_discount_pct numeric(5,2) not null default 100 check (max_discount_pct >= 0 and max_discount_pct <= 100),
  payment_methods  text[] not null default array['Cash','QRIS','Transfer','Card'],
  updated_at       timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict do nothing;

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  username    text unique,
  role        text not null default 'cashier' check (role in ('owner','admin','cashier')),
  active      boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.categories (
  code       text primary key check (code ~ '^[a-z0-9_]{2,30}$'),
  name       text not null,
  icon       text not null default '🛎️',
  color      text not null default '#0ea5e9',
  is_rental  boolean not null default false,
  sort       int not null default 0,
  active     boolean not null default true
);

create table if not exists public.services (
  id          uuid primary key default gen_random_uuid(),
  category    text not null references public.categories(code) on update cascade,
  name        text not null,
  description text not null default '',
  price       numeric(14,0) not null check (price >= 0),
  unit        text not null default 'session' check (unit in ('day','hour','session','kg','pcs','trip','person')),
  duration_hours numeric(6,2),            -- fixed-length services (snorkeling 2/3/4 h)
  active      boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.shifts (
  id            uuid primary key default gen_random_uuid(),
  cashier_id    uuid not null references public.profiles(id),
  opened_at     timestamptz not null default now(),
  opening_cash  numeric(14,0) not null default 0,
  closed_at     timestamptz,
  closing_cash  numeric(14,0),
  expected_cash numeric(14,0),
  note          text not null default ''
);
create unique index if not exists shifts_one_open on public.shifts(cashier_id) where closed_at is null;

create table if not exists public.transactions (
  id              uuid primary key default gen_random_uuid(),
  receipt_no      text not null unique,
  created_at      timestamptz not null default now(),
  cashier_id      uuid not null references public.profiles(id),
  shift_id        uuid references public.shifts(id),
  customer_name   text not null default '',
  customer_phone  text not null default '',
  customer_note   text not null default '',
  subtotal        numeric(14,0) not null,
  discount        numeric(14,0) not null default 0,
  tax             numeric(14,0) not null default 0,
  total           numeric(14,0) not null,
  payment_method  text not null,
  amount_paid     numeric(14,0) not null,
  change_amount   numeric(14,0) not null default 0,
  status          text not null default 'paid' check (status in ('paid','void')),
  void_reason     text,
  voided_by       uuid references public.profiles(id),
  voided_at       timestamptz
);
create index if not exists transactions_created on public.transactions(created_at desc);

create table if not exists public.transaction_items (
  id              uuid primary key default gen_random_uuid(),
  transaction_id  uuid not null references public.transactions(id) on delete cascade,
  service_id      uuid references public.services(id) on delete set null,
  category        text not null,
  name            text not null,
  unit            text not null,
  price           numeric(14,0) not null,
  qty             numeric(10,2) not null check (qty > 0),
  line_total      numeric(14,0) not null,
  item_ref        text not null default '',   -- bike no., therapist, guide …
  note            text not null default '',
  start_at        timestamptz,
  due_at          timestamptz,
  rental_status   text not null default 'none' check (rental_status in ('none','out','returned')),
  returned_at     timestamptz,
  returned_by     uuid references public.profiles(id)
);
create index if not exists items_tx on public.transaction_items(transaction_id);
create index if not exists items_rental on public.transaction_items(rental_status) where rental_status = 'out';

create table if not exists public.receipt_counters (
  day date primary key,
  n   int not null default 0
);

-- ───────────────────────── Helpers ─────────────────────────

create or replace function public.px_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create or replace function public.px_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.px_role() in ('owner','admin'), false)
$$;

-- New auth user → profile. The very first user becomes the active owner;
-- everybody else waits (inactive) until an admin activates them.
create or replace function public.px_on_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare first_user boolean;
begin
  select not exists (select 1 from public.profiles where role = 'owner') into first_user;
  insert into public.profiles (id, full_name, username, role, active)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'full_name',''), split_part(new.email,'@',1)),
    nullif(lower(new.raw_user_meta_data->>'username'),''),
    case when first_user then 'owner' else coalesce(nullif(new.raw_user_meta_data->>'role',''),'cashier') end,
    first_user or coalesce((new.raw_user_meta_data->>'active')::boolean, false)
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists px_on_new_user on auth.users;
create trigger px_on_new_user after insert on auth.users
  for each row execute function public.px_on_new_user();

-- Only the owner may create/modify owners; nobody can demote the last owner.
create or replace function public.px_guard_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;              -- service role / SQL editor
  if (old.role = 'owner' or new.role = 'owner') and coalesce(public.px_role(),'') <> 'owner' then
    raise exception 'Hanya owner yang boleh mengubah akun owner';
  end if;
  if old.role = 'owner' and (new.role <> 'owner' or not new.active)
     and (select count(*) from public.profiles where role = 'owner' and active and id <> old.id) = 0 then
    raise exception 'Harus ada minimal satu owner aktif';
  end if;
  if old.id = auth.uid() and (new.role <> old.role or new.active <> old.active) then
    raise exception 'Tidak bisa mengubah role/status akun sendiri';
  end if;
  return new;
end $$;
drop trigger if exists px_guard_profile on public.profiles;
create trigger px_guard_profile before update on public.profiles
  for each row execute function public.px_guard_profile();

create or replace function public.px_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists services_touch on public.services;
create trigger services_touch before update on public.services for each row execute function public.px_touch();
drop trigger if exists settings_touch on public.settings;
create trigger settings_touch before update on public.settings for each row execute function public.px_touch();

-- ───────────────────────── Row Level Security ─────────────────────────

alter table public.settings          enable row level security;
alter table public.profiles          enable row level security;
alter table public.categories        enable row level security;
alter table public.services          enable row level security;
alter table public.shifts            enable row level security;
alter table public.transactions      enable row level security;
alter table public.transaction_items enable row level security;
alter table public.receipt_counters  enable row level security;

drop policy if exists settings_read  on public.settings;
drop policy if exists settings_write on public.settings;
create policy settings_read  on public.settings for select to authenticated using (public.px_role() is not null);
create policy settings_write on public.settings for update to authenticated using (public.px_is_admin()) with check (public.px_is_admin());

drop policy if exists profiles_read  on public.profiles;
drop policy if exists profiles_write on public.profiles;
create policy profiles_read  on public.profiles for select to authenticated using (id = auth.uid() or public.px_role() is not null);
create policy profiles_write on public.profiles for update to authenticated using (public.px_is_admin()) with check (public.px_is_admin());

drop policy if exists categories_read  on public.categories;
drop policy if exists categories_write on public.categories;
create policy categories_read  on public.categories for select to authenticated using (public.px_role() is not null);
create policy categories_write on public.categories for all    to authenticated using (public.px_is_admin()) with check (public.px_is_admin());

drop policy if exists services_read  on public.services;
drop policy if exists services_write on public.services;
create policy services_read  on public.services for select to authenticated using (public.px_role() is not null);
create policy services_write on public.services for all    to authenticated using (public.px_is_admin()) with check (public.px_is_admin());

drop policy if exists shifts_read on public.shifts;
create policy shifts_read on public.shifts for select to authenticated
  using (cashier_id = auth.uid() or public.px_is_admin());

-- Cashiers see their own sales plus everything from the last 2 days (reprints, rentals);
-- admins see everything. Writes only through the functions below.
drop policy if exists tx_read on public.transactions;
create policy tx_read on public.transactions for select to authenticated
  using (public.px_is_admin() or (public.px_role() is not null and (cashier_id = auth.uid() or created_at > now() - interval '2 days')));

drop policy if exists items_read on public.transaction_items;
create policy items_read on public.transaction_items for select to authenticated
  using (public.px_is_admin() or (public.px_role() is not null and (rental_status = 'out' or exists (
    select 1 from public.transactions t where t.id = transaction_id
      and (t.cashier_id = auth.uid() or t.created_at > now() - interval '2 days')))));

-- ───────────────────────── Business functions ─────────────────────────

-- p = { customer_name, customer_phone, customer_note, discount, payment_method, amount_paid,
--       items: [{ service_id, qty, price?, item_ref?, note?, start_at? }] }
create or replace function public.create_sale(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_role text := public.px_role();
  s public.settings;
  it jsonb; svc public.services; cat public.categories;
  v_price numeric; v_qty numeric; v_start timestamptz; v_due timestamptz;
  v_sub numeric := 0; v_disc numeric; v_tax numeric; v_total numeric; v_paid numeric;
  v_no text; v_n int; v_day date := (now() at time zone 'Asia/Makassar')::date;
  v_tx uuid; v_shift uuid; v_method text;
begin
  if my_role is null then raise exception 'Akun tidak aktif'; end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'Keranjang kosong';
  end if;
  select * into s from public.settings where id = 1;
  v_method := coalesce(nullif(p->>'payment_method',''), 'Cash');
  if not (v_method = any(s.payment_methods)) then raise exception 'Metode bayar tidak dikenal: %', v_method; end if;

  -- pass 1: validate & subtotal
  for it in select * from jsonb_array_elements(p->'items') loop
    select * into svc from public.services where id = (it->>'service_id')::uuid;
    if not found or not svc.active then raise exception 'Layanan tidak tersedia'; end if;
    v_qty := coalesce((it->>'qty')::numeric, 1);
    if v_qty <= 0 or v_qty > 1000 then raise exception 'Jumlah tidak valid'; end if;
    v_price := svc.price;
    if it ? 'price' and (it->>'price')::numeric <> svc.price then
      if my_role not in ('owner','admin') then raise exception 'Hanya admin yang boleh mengubah harga'; end if;
      v_price := (it->>'price')::numeric;
      if v_price < 0 then raise exception 'Harga tidak valid'; end if;
    end if;
    v_sub := v_sub + round(v_price * v_qty);
  end loop;

  v_disc := greatest(0, coalesce((p->>'discount')::numeric, 0));
  if v_disc > v_sub then raise exception 'Diskon melebihi subtotal'; end if;
  if my_role = 'cashier' and v_sub > 0 and v_disc > v_sub * s.max_discount_pct / 100 then
    raise exception 'Diskon maksimal kasir % persen', s.max_discount_pct;
  end if;
  v_tax   := round((v_sub - v_disc) * s.tax_percent / 100);
  v_total := v_sub - v_disc + v_tax;
  v_paid  := coalesce((p->>'amount_paid')::numeric, v_total);
  if v_paid < v_total then raise exception 'Pembayaran kurang'; end if;

  insert into public.receipt_counters as c (day, n) values (v_day, 1)
    on conflict (day) do update set n = c.n + 1 returning n into v_n;
  v_no := s.receipt_prefix || to_char(v_day, 'YYMMDD') || '-' || lpad(v_n::text, 4, '0');

  select id into v_shift from public.shifts where cashier_id = me and closed_at is null;

  insert into public.transactions (receipt_no, cashier_id, shift_id, customer_name, customer_phone, customer_note,
      subtotal, discount, tax, total, payment_method, amount_paid, change_amount)
  values (v_no, me, v_shift, left(coalesce(p->>'customer_name',''),80), left(coalesce(p->>'customer_phone',''),30),
      left(coalesce(p->>'customer_note',''),200), v_sub, v_disc, v_tax, v_total, v_method, v_paid, v_paid - v_total)
  returning id into v_tx;

  -- pass 2: items
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
  if not public.px_is_admin() then raise exception 'Hanya admin yang boleh void'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'Alasan void wajib diisi'; end if;
  update public.transactions set status = 'void', void_reason = p_reason, voided_by = auth.uid(), voided_at = now()
   where id = p_id and status = 'paid';
  if not found then raise exception 'Transaksi tidak ditemukan / sudah void'; end if;
  update public.transaction_items set rental_status = 'returned', returned_at = now(), returned_by = auth.uid()
   where transaction_id = p_id and rental_status = 'out';
end $$;

create or replace function public.return_rental(p_item uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.px_role() is null then raise exception 'Akun tidak aktif'; end if;
  update public.transaction_items set rental_status = 'returned', returned_at = now(), returned_by = auth.uid()
   where id = p_item and rental_status = 'out';
  if not found then raise exception 'Rental tidak ditemukan / sudah kembali'; end if;
end $$;

create or replace function public.open_shift(p_cash numeric) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if public.px_role() is null then raise exception 'Akun tidak aktif'; end if;
  if exists (select 1 from public.shifts where cashier_id = auth.uid() and closed_at is null) then
    raise exception 'Shift masih terbuka';
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
  if sh.cashier_id <> auth.uid() and not public.px_is_admin() then raise exception 'Tidak diizinkan'; end if;
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
  if not found then raise exception 'Tidak ada shift terbuka'; end if;
  summ := public.shift_summary(sh.id);
  expected := sh.opening_cash + (summ->>'cash_sales')::numeric;
  update public.shifts set closed_at = now(), closing_cash = greatest(0, coalesce(p_cash,0)), expected_cash = expected,
      note = coalesce(p_note,'') where id = sh.id;
  return public.shift_summary(sh.id);
end $$;

-- Sales report for a date range (local dates, WITA)
create or replace function public.sales_report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not public.px_is_admin() then raise exception 'Hanya admin'; end if;
  with tx as (
    select * from public.transactions
     where (created_at at time zone 'Asia/Makassar')::date between p_from and p_to
  ), paid as (select * from tx where status = 'paid'),
  items as (select i.* from public.transaction_items i join paid t on t.id = i.transaction_id)
  select jsonb_build_object(
    'count',      (select count(*) from paid),
    'void_count', (select count(*) from tx where status='void'),
    'gross',      (select coalesce(sum(subtotal),0) from paid),
    'discount',   (select coalesce(sum(discount),0) from paid),
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

revoke all on function public.create_sale(jsonb), public.void_sale(uuid,text), public.return_rental(uuid),
  public.open_shift(numeric), public.close_shift(numeric,text), public.shift_summary(uuid),
  public.sales_report(date,date) from public, anon;
grant execute on function public.create_sale(jsonb), public.void_sale(uuid,text), public.return_rental(uuid),
  public.open_shift(numeric), public.close_shift(numeric,text), public.shift_summary(uuid),
  public.sales_report(date,date), public.px_role(), public.px_is_admin() to authenticated;
revoke execute on function public.px_on_new_user(), public.px_guard_profile() from public, anon, authenticated;

-- ───────────────────────── Seed data ─────────────────────────

insert into public.categories (code, name, icon, color, is_rental, sort) values
  ('rent_bike',  'Rent Bike',  '🚲', '#16a34a', true,  1),
  ('ebike',      'E-Bike',     '⚡', '#f59e0b', true,  2),
  ('laundry',    'Laundry',    '🧺', '#6366f1', false, 3),
  ('massage',    'Massage',    '💆', '#db2777', false, 4),
  ('snorkeling', 'Snorkeling', '🤿', '#0284c7', false, 5)
on conflict (code) do nothing;

insert into public.services (category, name, price, unit, duration_hours, sort, description)
select * from (values
  ('rent_bike',  'Rent Bike (per hari)',             50000::numeric,  'day',     null::numeric, 1, ''),
  ('ebike',      'E-Bike (per hari)',                250000,          'day',     null,          1, ''),
  ('laundry',    'Laundry (per kg)',                 15000,           'kg',      null,          1, 'Harga contoh — sesuaikan di Backoffice'),
  ('massage',    'Massage',                          350000,          'session', null,          1, ''),
  ('snorkeling', 'Snorkeling Private 2 Jam',         1100000,         'trip',    2,             1, ''),
  ('snorkeling', 'Snorkeling Private 3 Jam',         1300000,         'trip',    3,             2, ''),
  ('snorkeling', 'Snorkeling Private 4 Jam',         1500000,         'trip',    4,             3, '')
) v(category, name, price, unit, duration_hours, sort, description)
where not exists (select 1 from public.services);
