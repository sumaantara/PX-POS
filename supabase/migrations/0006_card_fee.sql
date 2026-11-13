-- PX POS: card fee (surcharge) for chosen payment methods, set in Back office → Settings.
-- Fee = round((subtotal - discount + service + tax) × card_fee_percent / 100) + card_fee_fixed

alter table public.settings add column if not exists card_fee_percent numeric(5,2) not null default 0;
alter table public.settings add column if not exists card_fee_fixed   numeric(14,0) not null default 0;
alter table public.settings add column if not exists card_fee_label   text not null default 'Card fee';
alter table public.settings add column if not exists card_fee_methods text[] not null default array['Card'];
do $$ begin
  alter table public.settings add constraint settings_card_fee check (card_fee_percent between 0 and 100 and card_fee_fixed >= 0);
exception when duplicate_object then null; end $$;

alter table public.transactions add column if not exists card_fee numeric(14,0) not null default 0;

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
  if v_method = any(s.card_fee_methods) and (s.card_fee_percent > 0 or s.card_fee_fixed > 0) then
    v_fee := round(v_total * s.card_fee_percent / 100) + s.card_fee_fixed;
    v_total := v_total + v_fee;
  end if;
  v_paid  := coalesce((p->>'amount_paid')::numeric, v_total);
  if v_paid < v_total then raise exception 'Amount paid is less than the total'; end if;

  insert into public.receipt_counters as c (day, n) values (v_day, 1)
    on conflict (day) do update set n = c.n + 1 returning n into v_n;
  v_no := s.receipt_prefix || to_char(v_day, 'YYMMDD') || '-' || lpad(v_n::text, 4, '0');

  select id into v_shift from public.shifts where cashier_id = me and closed_at is null;

  insert into public.transactions (receipt_no, cashier_id, shift_id, customer_name, customer_phone, customer_note,
      subtotal, discount, service_charge, tax, card_fee, total, payment_method, amount_paid, change_amount)
  values (v_no, me, v_shift, left(coalesce(p->>'customer_name',''),80), left(coalesce(p->>'customer_phone',''),30),
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

  return jsonb_build_object('id', v_tx, 'receipt_no', v_no, 'total', v_total, 'change', v_paid - v_total);
end $$;

create or replace function public.sales_report(p_from date, p_to date) returns jsonb
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
    'by_cashier', (select coalesce(jsonb_agg(x),'[]') from (
                    select jsonb_build_object('cashier', coalesce(pr.full_name,'?'), 'count', count(*), 'total', sum(p.total)) x
                    from paid p left join public.profiles pr on pr.id = p.cashier_id group by pr.full_name order by sum(p.total) desc) a),
    'by_day',     (select coalesce(jsonb_agg(x order by x->>'day'),'[]') from (
                    select jsonb_build_object('day', (created_at at time zone 'Asia/Makassar')::date, 'count', count(*), 'total', sum(total)) x
                    from paid group by (created_at at time zone 'Asia/Makassar')::date ) a)
  ) into r;
  return r;
end $$;
