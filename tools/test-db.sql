-- PX POS database self-test. Everything happens inside one transaction and is rolled back
-- (the final RAISE aborts it), so no data is left behind. Result is shown as the error message.
do $$
declare
  owner_id uuid := gen_random_uuid();
  kasir_id uuid := gen_random_uuid();
  bike uuid; snork uuid; laundry uuid;
  r jsonb; r2 jsonb; rep jsonb; sh jsonb; out text := '';
  item uuid; n int; err text;
begin
  -- fake auth users (trigger creates profiles: first = owner, second = pending cashier)
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-test@px-pos.app', '{"full_name":"Owner Test"}', now(), now()),
         (kasir_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'kasir-test@px-pos.app', '{"full_name":"Kasir Test","username":"kasirtest"}', now(), now());
  -- a real owner may already exist: force the test roles (as postgres, no JWT → guard allows it)
  update public.profiles set role = 'owner', active = true where id = owner_id;
  update public.profiles set role = 'cashier', active = false where id = kasir_id;
  update public.settings set service_percent = 5, tax_percent = 10, max_discount_pct = 100, payment_methods = array['Cash','QRIS','Transfer','Card'] where id = 1;
  out := out || 'profiles: ' || (select string_agg(full_name||'/'||role||'/'||active, ', ') from public.profiles where id in (owner_id, kasir_id)) || E'\n';

  select id into bike from public.services where name like 'Bike Rental%';
  select id into snork from public.services where name like 'Private Snorkeling 2%';
  select id into laundry from public.services where name like 'Laundry%';

  -- act as the pending cashier: must be refused
  perform set_config('request.jwt.claims', json_build_object('sub', kasir_id, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.create_sale(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('service_id', bike))));
    out := out || 'FAIL pending cashier could sell' || E'\n';
  exception when others then out := out || 'ok pending cashier blocked: ' || sqlerrm || E'\n'; end;
  select count(*) into n from public.services; out := out || 'pending sees services: ' || n || E'\n';

  -- act as owner: activate cashier
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  update public.profiles set active = true where id = kasir_id;

  -- cashier: open shift, sell, try price override, try big discount
  perform set_config('request.jwt.claims', json_build_object('sub', kasir_id, 'role', 'authenticated')::text, true);
  perform public.open_shift(200000);
  r := public.create_sale(jsonb_build_object('customer_name','John','payment_method','Cash','amount_paid',2000000,'discount',50000,
        'items', jsonb_build_array(
          jsonb_build_object('service_id', bike, 'qty', 3, 'item_ref', 'B-07'),
          jsonb_build_object('service_id', snork, 'qty', 1),
          jsonb_build_object('service_id', laundry, 'qty', 2.5))));
  out := out || 'sale1: ' || r::text || ' (expect total 1429313, change 570687)' || E'\n';
  out := out || 'sale1 row: ' || (select format('sub=%s disc=%s srv=%s tax=%s', subtotal, discount, service_charge, tax) from public.transactions where id = (r->>'id')::uuid) || E'\n';
  r2 := public.create_sale(jsonb_build_object('payment_method','QRIS','items', jsonb_build_array(jsonb_build_object('service_id', bike, 'qty', 1))));
  out := out || 'sale2: ' || r2::text || E'\n';
  begin perform public.create_sale(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('service_id', bike, 'price', 1))));
    out := out || 'FAIL cashier changed price' || E'\n';
  exception when others then out := out || 'ok price override blocked: ' || sqlerrm || E'\n'; end;
  begin perform public.create_sale(jsonb_build_object('payment_method','Cash','amount_paid',1000,'items', jsonb_build_array(jsonb_build_object('service_id', bike))));
    out := out || 'FAIL underpaid accepted' || E'\n';
  exception when others then out := out || 'ok underpay blocked: ' || sqlerrm || E'\n'; end;
  begin insert into public.transactions (receipt_no, cashier_id, subtotal, total, payment_method, amount_paid) values ('HACK', kasir_id, 0, 0, 'Cash', 0);
    out := out || 'FAIL direct insert allowed' || E'\n';
  exception when others then out := out || 'ok direct insert blocked' || E'\n'; end;
  begin perform public.void_sale((r->>'id')::uuid, 'x'); out := out || 'FAIL cashier voided' || E'\n';
  exception when others then out := out || 'ok cashier void blocked: ' || sqlerrm || E'\n'; end;
  begin perform public.sales_report(current_date, current_date); out := out || 'FAIL cashier report' || E'\n';
  exception when others then out := out || 'ok cashier report blocked' || E'\n'; end;

  select count(*) into n from public.transaction_items where rental_status = 'out';
  out := out || 'rentals out: ' || n || E'\n';
  select id into item from public.transaction_items where rental_status = 'out' and item_ref = 'B-07';
  out := out || 'B-07 due: ' || (select to_char(due_at - start_at, 'DD "days" HH24"h"') from public.transaction_items where id = item) || E'\n';
  perform public.return_rental(item);
  select count(*) into n from public.transaction_items where rental_status = 'out';
  out := out || 'rentals out after return: ' || n || E'\n';

  sh := public.close_shift(1500000, 'test');
  out := out || 'shift: total=' || (sh->>'total') || ' cash_sales=' || (sh->>'cash_sales') || ' expected=' || (sh->'shift'->>'expected_cash') || ' counted=' || (sh->'shift'->>'closing_cash') || E'\n';

  -- owner: void sale2, report
  perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
  perform public.void_sale((r2->>'id')::uuid, 'salah input');
  rep := public.sales_report((now() at time zone 'Asia/Makassar')::date, (now() at time zone 'Asia/Makassar')::date);
  out := out || 'report: count=' || (rep->>'count') || ' service=' || (rep->>'service') || ' tax=' || (rep->>'tax') || ' void=' || (rep->>'void_count') || ' gross=' || (rep->>'gross') || ' disc=' || (rep->>'discount') || ' total=' || (rep->>'total')
      || E'\n  by_category=' || (rep->'by_category')::text || E'\n  by_method=' || (rep->'by_method')::text || E'\n';
  -- owner cannot be demoted by itself / guard
  begin update public.profiles set role = 'cashier' where id = owner_id; out := out || 'FAIL owner self-demote' || E'\n';
  exception when others then out := out || 'ok owner guard: ' || sqlerrm || E'\n'; end;

  perform set_config('role', 'postgres', true);
  out := out || 'cron key check: ' || public.px_check_cron_key('wrong')::text || E'\n';
  raise exception E'PX-POS-TEST (rolled back)\n%', out;
end $$;
