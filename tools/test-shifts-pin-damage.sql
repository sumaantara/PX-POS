-- PX POS self-test: required guest details, mandatory shift, midnight auto-end, supervisor PIN void,
-- rental return with damage charge. Rolled back at the end (final RAISE).
do $$
declare
  k uuid := gen_random_uuid(); own uuid := gen_random_uuid(); rv uuid; bike uuid; r jsonb; d jsonb; it uuid; out text := ''; sh uuid;
  ok_guest jsonb := '{"customer_name":"Test Guest","customer_phone":"081234567890","customer_note":"Room 1"}';
begin
  select id into rv from public.outlets where name = 'Ratu Village';
  select id into bike from public.services where name like 'Bike Rental%' limit 1;
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (k,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't-k@px-pos.app', '{"full_name":"T Cashier"}', now(), now()),
    (own, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't-o@px-pos.app', '{"full_name":"T Owner"}', now(), now());
  update public.profiles set role = 'cashier', active = true, outlet_ids = array[rv] where id = k;
  update public.profiles set role = 'owner', active = true, outlet_ids = '{}' where id = own;

  -- midnight auto-end: a shift opened yesterday is ended at 00:00 WITA
  insert into public.shifts (cashier_id, outlet_id, opening_cash, opened_at) values (k, rv, 0, now() - interval '1 day') returning id into sh;
  perform public.px_close_stale_shifts();
  out := out || 'yesterday shift: ' || (select format('auto=%s ended=%s', auto_closed, to_char(closed_at at time zone 'Asia/Makassar', 'YYYY-MM-DD HH24:MI')) from public.shifts where id = sh) || E'\n';

  perform set_config('request.jwt.claims', json_build_object('sub', k, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin perform public.create_sale(ok_guest || jsonb_build_object('outlet_id', rv, 'items', jsonb_build_array(jsonb_build_object('service_id', bike))));
    out := out || 'FAIL sold without shift' || E'\n';
  exception when others then out := out || 'ok no shift: ' || sqlerrm || E'\n'; end;
  perform public.open_shift(0, rv);
  begin perform public.create_sale(jsonb_build_object('outlet_id', rv, 'customer_name', 'X', 'customer_phone', '123', 'customer_note', 'R', 'items', jsonb_build_array(jsonb_build_object('service_id', bike))));
    out := out || 'FAIL bad phone accepted' || E'\n';
  exception when others then out := out || 'ok phone: ' || sqlerrm || E'\n'; end;
  begin perform public.create_sale(jsonb_build_object('outlet_id', rv, 'customer_name', 'X', 'customer_phone', '081234567890', 'items', jsonb_build_array(jsonb_build_object('service_id', bike))));
    out := out || 'FAIL missing room accepted' || E'\n';
  exception when others then out := out || 'ok room: ' || sqlerrm || E'\n'; end;
  r := public.create_sale(ok_guest || jsonb_build_object('outlet_id', rv, 'payment_method', 'Cash', 'items', jsonb_build_array(jsonb_build_object('service_id', bike, 'qty', 2, 'item_ref', 'B-99'))));
  out := out || 'sale: ' || (r->>'receipt_no') || E'\n';

  -- supervisor PIN (set by owner)
  perform set_config('request.jwt.claims', json_build_object('sub', own, 'role', 'authenticated')::text, true);
  perform public.set_supervisor_pin('2468');
  perform set_config('request.jwt.claims', json_build_object('sub', k, 'role', 'authenticated')::text, true);
  begin perform public.set_supervisor_pin('1111'); out := out || 'FAIL cashier set PIN' || E'\n';
  exception when others then out := out || 'ok cashier cannot set PIN' || E'\n'; end;
  out := out || 'pin info (cashier sees): ' || public.supervisor_pin_info()::text || E'\n';

  -- damage return (before voiding)
  select id into it from public.transaction_items where transaction_id = (r->>'id')::uuid;
  d := public.return_rental2(it, '{"damaged":true,"amount":75000,"note":"Broken brake lever","payment_method":"Cash","amount_paid":100000}');
  out := out || 'damage: ' || (select format('%s kind=%s total=%s change=%s item=%s', receipt_no, kind, total, change_amount,
      (select name || ' / ' || note from public.transaction_items where transaction_id = t.id)) from public.transactions t where id = (d->>'damage_tx')::uuid) || E'\n';
  out := out || 'rental now: ' || (select rental_status || ' / ' || damage_note from public.transaction_items where id = it) || E'\n';

  begin perform public.void_sale_pin((r->>'id')::uuid, '0000', 'test'); out := out || 'FAIL wrong PIN' || E'\n';
  exception when others then out := out || 'ok wrong PIN: ' || sqlerrm || E'\n'; end;
  perform public.void_sale_pin((r->>'id')::uuid, '2468', 'guest cancelled');
  out := out || 'void: ' || (select format('%s pin=%s by_cashier=%s', status, voided_with_pin, voided_by = k) from public.transactions where id = (r->>'id')::uuid) || E'\n';
  out := out || 'end shift: ' || (public.end_shift('test')->>'count') || ' sales' || E'\n';

  perform set_config('role', 'postgres', true);
  raise exception E'PX-POS-SHIFT-PIN-TEST (rolled back)\n%', out;
end $$;
