-- PX POS: required guest details, mandatory daily shifts (auto-end at midnight WITA, no cash count),
-- void with supervisor PIN from the cashier app, rental return with optional damage charge.

-- ── shifts: auto-end at midnight ────────────────────────────
alter table public.shifts add column if not exists auto_closed boolean not null default false;

create or replace function public.px_close_stale_shifts() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.shifts
     set closed_at = (((opened_at at time zone 'Asia/Makassar')::date + 1)::timestamp at time zone 'Asia/Makassar'),
         auto_closed = true, note = case when note = '' then 'Ended automatically at midnight' else note end
   where closed_at is null
     and (opened_at at time zone 'Asia/Makassar')::date < (now() at time zone 'Asia/Makassar')::date;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.px_close_stale_shifts() from public, anon;
grant execute on function public.px_close_stale_shifts() to authenticated, service_role;

create or replace function public.open_shift(p_cash numeric, p_outlet uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid; o uuid := p_outlet;
begin
  if public.px_role() is null then raise exception 'Your account is not active'; end if;
  perform public.px_close_stale_shifts();
  if o is null then select id into o from public.outlets where active and public.px_outlet_ok(id) order by sort, name limit 1; end if;
  if o is null or not public.px_outlet_ok(o) then raise exception 'You are not assigned to this outlet'; end if;
  if exists (select 1 from public.shifts where cashier_id = auth.uid() and closed_at is null) then
    raise exception 'You already have an open shift';
  end if;
  insert into public.shifts (cashier_id, outlet_id, opening_cash) values (auth.uid(), o, 0) returning id into v;
  return v;
end $$;

-- shift_summary now also ends yesterday's forgotten shifts (no longer STABLE)
create or replace function public.shift_summary(p_shift uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sh public.shifts; r jsonb;
begin
  perform public.px_close_stale_shifts();
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

create or replace function public.end_shift(p_note text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare sh public.shifts;
begin
  perform public.px_close_stale_shifts();
  select * into sh from public.shifts where cashier_id = auth.uid() and closed_at is null;
  if not found then raise exception 'No open shift'; end if;
  update public.shifts set closed_at = now(), note = coalesce(p_note,'') where id = sh.id;
  return public.shift_summary(sh.id);
end $$;
grant execute on function public.end_shift(text) to authenticated;

-- ── sales: guest details + open shift required ──────────────
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
  if coalesce(trim(p->>'customer_name'),'') = '' then raise exception 'Guest name is required'; end if;
  if length(regexp_replace(coalesce(p->>'customer_phone',''), '\D', '', 'g')) < 8 then raise exception 'A valid phone / WhatsApp number is required'; end if;
  if coalesce(trim(p->>'customer_note'),'') = '' then raise exception 'Room / hotel / note is required'; end if;
  perform public.px_close_stale_shifts();
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
  if v_shift is null then raise exception 'Open your shift before taking orders'; end if;
  if v_shift_outlet <> o.id then
    raise exception 'Your open shift is at another outlet — end it first';
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

-- ── supervisor PIN (hash kept out of the API) ───────────────
create table if not exists px_private.supervisor_pin (
  id int primary key default 1 check (id = 1),
  pin_hash text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table px_private.supervisor_pin enable row level security;
create table if not exists px_private.pin_attempts (
  id bigserial primary key, user_id uuid not null, at timestamptz not null default now(), ok boolean not null
);
alter table px_private.pin_attempts enable row level security;

create or replace function public.set_supervisor_pin(p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.px_is_admin() then raise exception 'Only an owner or admin can set the supervisor PIN'; end if;
  if p_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN must be 4–8 digits'; end if;
  insert into px_private.supervisor_pin (id, pin_hash, updated_at, updated_by) values (1, crypt(p_pin, gen_salt('bf')), now(), auth.uid())
  on conflict (id) do update set pin_hash = excluded.pin_hash, updated_at = now(), updated_by = auth.uid();
end $$;

create or replace function public.supervisor_pin_info() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('set', exists (select 1 from px_private.supervisor_pin),
                            'updated_at', (select updated_at from px_private.supervisor_pin where id = 1))
  where public.px_role() is not null
$$;

alter table public.transactions add column if not exists voided_with_pin boolean not null default false;

create or replace function public.void_sale_pin(p_id uuid, p_pin text, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare t public.transactions; h text; fails int;
begin
  if public.px_role() is null then raise exception 'Your account is not active'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  select * into t from public.transactions where id = p_id;
  if not found or t.status <> 'paid' then raise exception 'Sale not found or already void'; end if;
  if not public.px_outlet_ok(t.outlet_id) then raise exception 'This sale belongs to another outlet'; end if;
  select count(*) into fails from px_private.pin_attempts where user_id = auth.uid() and not ok and at > now() - interval '15 minutes';
  if fails >= 5 then raise exception 'Too many wrong PINs — try again in 15 minutes'; end if;
  select pin_hash into h from px_private.supervisor_pin where id = 1;
  if h is null then raise exception 'No supervisor PIN has been set in the back office yet'; end if;
  if crypt(coalesce(p_pin,''), h) <> h then
    insert into px_private.pin_attempts (user_id, ok) values (auth.uid(), false);
    raise exception 'Wrong supervisor PIN';
  end if;
  insert into px_private.pin_attempts (user_id, ok) values (auth.uid(), true);
  update public.transactions set status = 'void', void_reason = p_reason, voided_by = auth.uid(), voided_at = now(), voided_with_pin = true
   where id = p_id;
  update public.transaction_items set rental_status = 'returned', returned_at = now(), returned_by = auth.uid()
   where transaction_id = p_id and rental_status = 'out';
end $$;

revoke all on function public.set_supervisor_pin(text), public.supervisor_pin_info(), public.void_sale_pin(uuid,text,text) from public, anon;
grant execute on function public.set_supervisor_pin(text), public.supervisor_pin_info(), public.void_sale_pin(uuid,text,text) to authenticated;

-- ── rental return with optional damage charge ───────────────
alter table public.transactions add column if not exists kind text not null default 'sale';
alter table public.transactions add column if not exists ref_tx uuid references public.transactions(id);
do $$ begin
  alter table public.transactions add constraint transactions_kind check (kind in ('sale','damage'));
exception when duplicate_object then null; end $$;
alter table public.transaction_items add column if not exists damage_note text not null default '';

-- p = { damaged: bool, amount, note, payment_method, amount_paid }
create or replace function public.return_rental2(p_item uuid, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare it public.transaction_items; t public.transactions; s public.settings; o public.outlets;
  v_amt numeric; v_paid numeric; v_method text; v_note text; v_n int; v_no text; v_tx uuid; v_shift uuid; v_shift_outlet uuid;
  v_day date := (now() at time zone 'Asia/Makassar')::date;
begin
  if public.px_role() is null then raise exception 'Your account is not active'; end if;
  select * into it from public.transaction_items where id = p_item;
  if not found or it.rental_status <> 'out' then raise exception 'Rental not found or already returned'; end if;
  select * into t from public.transactions where id = it.transaction_id;
  if not public.px_outlet_ok(t.outlet_id) then raise exception 'This rental belongs to another outlet'; end if;

  if coalesce((p->>'damaged')::boolean, false) then
    v_amt := round(coalesce((p->>'amount')::numeric, 0));
    v_note := left(trim(coalesce(p->>'note','')), 200);
    if v_amt <= 0 then raise exception 'Enter the damage charge amount'; end if;
    if v_note = '' then raise exception 'Describe the damage'; end if;
    select * into s from public.settings where id = 1;
    select * into o from public.outlets where id = t.outlet_id;
    v_method := coalesce(nullif(p->>'payment_method',''), 'Cash');
    if not (v_method = any(s.payment_methods)) then raise exception 'Unknown payment method: %', v_method; end if;
    v_paid := coalesce((p->>'amount_paid')::numeric, v_amt);
    if v_paid < v_amt then raise exception 'Amount paid is less than the damage charge'; end if;
    perform public.px_close_stale_shifts();
    select id, outlet_id into v_shift, v_shift_outlet from public.shifts where cashier_id = auth.uid() and closed_at is null;
    if v_shift is null then raise exception 'Open your shift before taking payments'; end if;
    if v_shift_outlet <> o.id then raise exception 'Your open shift is at another outlet'; end if;

    insert into public.receipt_counters as c (outlet_id, day, n) values (o.id, v_day, 1)
      on conflict (outlet_id, day) do update set n = c.n + 1 returning n into v_n;
    v_no := o.receipt_prefix || to_char(v_day, 'YYMMDD') || '-' || lpad(v_n::text, 4, '0');
    insert into public.transactions (receipt_no, outlet_id, cashier_id, shift_id, customer_name, customer_phone, customer_note,
        subtotal, discount, service_charge, tax, card_fee, total, payment_method, amount_paid, change_amount, kind, ref_tx)
    values (v_no, o.id, auth.uid(), v_shift, t.customer_name, t.customer_phone, t.customer_note,
        v_amt, 0, 0, 0, 0, v_amt, v_method, v_paid, v_paid - v_amt, 'damage', t.id)
    returning id into v_tx;
    insert into public.transaction_items (transaction_id, service_id, category, name, unit, price, qty, line_total, item_ref, note, rental_status)
    values (v_tx, it.service_id, 'damage', 'Damage charge - ' || it.name, 'pcs', v_amt, 1, v_amt, it.item_ref,
        v_note || ' (rental ' || t.receipt_no || ')', 'none');
  end if;

  update public.transaction_items set rental_status = 'returned', returned_at = now(), returned_by = auth.uid(),
         damage_note = coalesce(v_note, '') where id = p_item;
  return jsonb_build_object('returned', true, 'damage_tx', v_tx, 'receipt_no', v_no);
end $$;
revoke all on function public.return_rental2(uuid, jsonb) from public, anon;
grant execute on function public.return_rental2(uuid, jsonb) to authenticated;

-- ── end forgotten shifts right after midnight WITA (16:00 UTC) ──
select cron.unschedule('px-close-shifts') where exists (select 1 from cron.job where jobname = 'px-close-shifts');
select cron.schedule('px-close-shifts', '0 16 * * *', $job$ select public.px_close_stale_shifts() $job$);
select public.px_close_stale_shifts();
