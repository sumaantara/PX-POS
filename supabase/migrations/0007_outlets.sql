-- PX POS: multiple outlets (Ratu Village + PeraONE Villas), one back office for the organisation.
--  • outlets: name + its own receipt (prefix, address, phone, logo, texts)
--  • services.outlet_ids:  which outlets sell it  (empty = every outlet)
--  • profiles.outlet_ids:  where a cashier may sell (empty = every outlet, owners/admins only)
--  • transactions / shifts / receipt numbers are per outlet
-- Tax, service, card fee, payment methods and the daily email stay organisation-wide (settings).

create table if not exists public.outlets (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  active            boolean not null default true,
  sort              int not null default 0,
  receipt_prefix    text not null unique check (receipt_prefix ~ '^[A-Z0-9]{1,6}$'),
  address           text not null default '',
  phone             text not null default '',
  receipt_header    text not null default '',
  receipt_footer    text not null default '',
  thank_you         text not null default 'Thank you for your visit!',
  logo_data         text not null default '' check (length(logo_data) <= 300000),
  receipt_show_name boolean not null default true,
  created_at        timestamptz not null default now()
);
alter table public.outlets enable row level security;

-- seed: Ratu Village takes over the current receipt settings; PeraONE Villas starts as a copy
insert into public.outlets (name, sort, receipt_prefix, address, phone, receipt_header, receipt_footer, thank_you, logo_data, receipt_show_name)
select 'Ratu Village', 1, coalesce(nullif(upper(regexp_replace(receipt_prefix, '[^A-Za-z0-9]', '', 'g')), ''), 'RV'),
       address, phone, receipt_header, receipt_footer, thank_you, logo_data, receipt_show_name
from public.settings where id = 1 and not exists (select 1 from public.outlets);

insert into public.outlets (name, sort, receipt_prefix, address, phone, receipt_header, receipt_footer, thank_you, logo_data, receipt_show_name)
select 'PeraONE Villas', 2, case when exists (select 1 from public.outlets where receipt_prefix = 'PV') then 'PV2' else 'PV' end,
       address, phone, receipt_header, receipt_footer, thank_you, logo_data, receipt_show_name
from public.settings where id = 1 and not exists (select 1 from public.outlets where name = 'PeraONE Villas');

-- availability / assignment
alter table public.services add column if not exists outlet_ids uuid[] not null default '{}';
alter table public.profiles add column if not exists outlet_ids uuid[] not null default '{}';
-- existing cashiers worked at Ratu Village
update public.profiles set outlet_ids = array[(select id from public.outlets where name = 'Ratu Village')]
 where role = 'cashier' and cardinality(outlet_ids) = 0;

-- outlet on sales & shifts (existing rows → Ratu Village)
alter table public.transactions add column if not exists outlet_id uuid references public.outlets(id);
alter table public.shifts       add column if not exists outlet_id uuid references public.outlets(id);
update public.transactions set outlet_id = (select id from public.outlets where name = 'Ratu Village') where outlet_id is null;
update public.shifts       set outlet_id = (select id from public.outlets where name = 'Ratu Village') where outlet_id is null;
alter table public.transactions alter column outlet_id set not null;
alter table public.shifts       alter column outlet_id set not null;
create index if not exists transactions_outlet on public.transactions(outlet_id, created_at desc);

-- receipt numbers count per outlet per day
alter table public.receipt_counters add column if not exists outlet_id uuid references public.outlets(id);
update public.receipt_counters set outlet_id = (select id from public.outlets where name = 'Ratu Village') where outlet_id is null;
alter table public.receipt_counters alter column outlet_id set not null;
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'receipt_counters_pkey'
             and pg_get_constraintdef(oid) = 'PRIMARY KEY (day)') then
    alter table public.receipt_counters drop constraint receipt_counters_pkey;
    alter table public.receipt_counters add primary key (outlet_id, day);
  end if;
end $$;

-- may the current user sell at this outlet?
create or replace function public.px_outlet_ok(o uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p
                  where p.id = auth.uid() and p.active
                    and ((p.role in ('owner','admin') and cardinality(p.outlet_ids) = 0) or o = any(p.outlet_ids)))
$$;
grant execute on function public.px_outlet_ok(uuid) to authenticated;

-- ── RLS ──
drop policy if exists outlets_read  on public.outlets;
drop policy if exists outlets_write on public.outlets;
create policy outlets_read  on public.outlets for select to authenticated using (public.px_role() is not null);
create policy outlets_write on public.outlets for all    to authenticated using (public.px_is_admin()) with check (public.px_is_admin());

drop policy if exists tx_read on public.transactions;
create policy tx_read on public.transactions for select to authenticated
  using (public.px_is_admin() or (public.px_outlet_ok(outlet_id) and (cashier_id = auth.uid() or created_at > now() - interval '2 days')));

drop policy if exists items_read on public.transaction_items;
create policy items_read on public.transaction_items for select to authenticated
  using (public.px_is_admin() or exists (
    select 1 from public.transactions t where t.id = transaction_id and public.px_outlet_ok(t.outlet_id)
      and (transaction_items.rental_status = 'out' or t.cashier_id = auth.uid() or t.created_at > now() - interval '2 days')));

-- ── functions ──
create or replace function public.create_sale(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_role text := public.px_role();
  s public.settings;
  it jsonb; svc public.services; cat public.categories;
  v_price numeric; v_qty numeric; v_start timestamptz; v_due timestamptz;
  v_sub numeric := 0; v_disc numeric; v_srv numeric; v_tax numeric; v_fee numeric := 0; v_total numeric; v_paid numeric;
  v_no text; v_n int; v_day date := (now() at time zone 'Asia/Makassar')::date;
  v_tx uuid; v_shift uuid; v_shift_outlet uuid; v_method text; o public.outlets;
begin
  if my_role is null then raise exception 'Your account is not active'; end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'The cart is empty';
  end if;
  select * into s from public.settings where id = 1;
  -- outlet: given by the app; older app versions send none → the user's first outlet
  if nullif(p->>'outlet_id','') is not null then
    select * into o from public.outlets where id = (p->>'outlet_id')::uuid;
  else
    select * into o from public.outlets where active and public.px_outlet_ok(id) order by sort, name limit 1;
  end if;
  if o.id is null or not o.active then raise exception 'Outlet not found or closed'; end if;
  if not public.px_outlet_ok(o.id) then raise exception 'You are not assigned to %', o.name; end if;
  v_method := coalesce(nullif(p->>'payment_method',''), 'Cash');
  if not (v_method = any(s.payment_methods)) then raise exception 'Unknown payment method: %', v_method; end if;

  for it in select * from jsonb_array_elements(p->'items') loop
    select * into svc from public.services where id = (it->>'service_id')::uuid;
    if not found or not svc.active then raise exception 'Service is not available'; end if;
    if cardinality(svc.outlet_ids) > 0 and not (o.id = any(svc.outlet_ids)) then
      raise exception '% is not sold at %', svc.name, o.name;
    end if;
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
  if v_method = any(s.card_fee_methods) and (s.card_fee_percent > 0 or s.card_fee_fixed > 0) then
    v_fee := round(v_total * s.card_fee_percent / 100) + s.card_fee_fixed;
    v_total := v_total + v_fee;
  end if;
  v_paid  := coalesce((p->>'amount_paid')::numeric, v_total);
  if v_paid < v_total then raise exception 'Amount paid is less than the total'; end if;

  insert into public.receipt_counters as c (outlet_id, day, n) values (o.id, v_day, 1)
    on conflict (outlet_id, day) do update set n = c.n + 1 returning n into v_n;
  v_no := o.receipt_prefix || to_char(v_day, 'YYMMDD') || '-' || lpad(v_n::text, 4, '0');

  select id, outlet_id into v_shift, v_shift_outlet from public.shifts where cashier_id = me and closed_at is null;
  if v_shift is not null and v_shift_outlet <> o.id then
    raise exception 'Your open shift is at another outlet — close it first';
  end if;

  insert into public.transactions (receipt_no, outlet_id, cashier_id, shift_id, customer_name, customer_phone, customer_note,
      subtotal, discount, service_charge, tax, card_fee, total, payment_method, amount_paid, change_amount)
  values (v_no, o.id, me, v_shift, left(coalesce(p->>'customer_name',''),80), left(coalesce(p->>'customer_phone',''),30),
      left(coalesce(p->>'customer_note',''),200), v_sub, v_disc, v_srv, v_tax, v_fee, v_total, v_method, v_paid, v_paid - v_total)
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

  return jsonb_build_object('id', v_tx, 'receipt_no', v_no, 'outlet_id', o.id, 'total', v_total, 'change', v_paid - v_total);
end $$;

drop function if exists public.open_shift(numeric);
create or replace function public.open_shift(p_cash numeric, p_outlet uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid; o uuid := p_outlet;
begin
  if public.px_role() is null then raise exception 'Your account is not active'; end if;
  if o is null then select id into o from public.outlets where active and public.px_outlet_ok(id) order by sort, name limit 1; end if;
  if o is null or not public.px_outlet_ok(o) then raise exception 'You are not assigned to this outlet'; end if;
  if exists (select 1 from public.shifts where cashier_id = auth.uid() and closed_at is null) then
    raise exception 'You already have an open shift';
  end if;
  insert into public.shifts (cashier_id, outlet_id, opening_cash) values (auth.uid(), o, greatest(0, coalesce(p_cash,0))) returning id into v;
  return v;
end $$;

drop function if exists public.sales_report(date, date);
create or replace function public.sales_report(p_from date, p_to date, p_outlet uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  -- admins, or the daily-report edge function (service role key)
  if not (public.px_is_admin() or coalesce(auth.role(), '') = 'service_role') then
    raise exception 'Admins only';
  end if;
  with tx as (
    select * from public.transactions
     where (created_at at time zone 'Asia/Makassar')::date between p_from and p_to
       and (p_outlet is null or outlet_id = p_outlet)
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
    'card_fee',   (select coalesce(sum(card_fee),0) from paid),
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
    'by_outlet',  (select coalesce(jsonb_agg(x),'[]') from (
                    select jsonb_build_object('outlet_id', o.id, 'outlet', o.name, 'count', count(p.id), 'total', coalesce(sum(p.total),0)) x
                    from public.outlets o left join paid p on p.outlet_id = o.id
                    where p_outlet is null or o.id = p_outlet
                    group by o.id, o.name, o.sort order by o.sort, o.name) a),
    'by_cashier', (select coalesce(jsonb_agg(x),'[]') from (
                    select jsonb_build_object('cashier', coalesce(pr.full_name,'?'), 'count', count(*), 'total', sum(p.total)) x
                    from paid p left join public.profiles pr on pr.id = p.cashier_id group by pr.full_name order by sum(p.total) desc) a),
    'by_day',     (select coalesce(jsonb_agg(x order by x->>'day'),'[]') from (
                    select jsonb_build_object('day', (created_at at time zone 'Asia/Makassar')::date, 'count', count(*), 'total', sum(total)) x
                    from paid group by (created_at at time zone 'Asia/Makassar')::date ) a)
  ) into r;
  return r;
end $$;

revoke all on function public.open_shift(numeric, uuid), public.sales_report(date, date, uuid) from public, anon;
grant execute on function public.open_shift(numeric, uuid), public.sales_report(date, date, uuid) to authenticated;
grant execute on function public.sales_report(date, date, uuid) to service_role;
