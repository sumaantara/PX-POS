-- PX POS multi-outlet self-test. Runs inside one transaction and is rolled back (final RAISE).
do $$
declare
  owner_id uuid := gen_random_uuid(); villa_id uuid := gen_random_uuid();
  rv uuid; pv uuid; massage uuid; bike uuid; r jsonb; out text := ''; n int; rep jsonb;
begin
  select id into rv from public.outlets where name = 'Ratu Village';
  select id into pv from public.outlets where name = 'PeraONE Villas';
  out := out || 'outlets: ' || (select string_agg(name || '=' || receipt_prefix, ', ' order by sort) from public.outlets) || E'\n';
  out := out || 'old tx all at Ratu: ' || ((select count(*) from public.transactions where outlet_id = rv) = (select count(*) from public.transactions))::text || E'\n';

  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mo-owner@px-pos.app', '{"full_name":"MO Owner"}', now(), now()),
    (villa_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mo-villa@px-pos.app', '{"full_name":"MO Villa"}', now(), now());
  update public.profiles set role = 'owner', active = true, outlet_ids = '{}' where id = owner_id;
  update public.profiles set role = 'cashier', active = true, outlet_ids = array[pv] where id = villa_id;
  select id into massage from public.services where name = 'Massage' limit 1;
  select id into bike from public.services where name like 'Bike Rental%' limit 1;
  update public.services set outlet_ids = array[rv] where id = massage;      -- massage only at Ratu (rolled back)

  -- villa cashier
  perform set_config('request.jwt.claims', json_build_object('sub', villa_id, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.open_shift(0, pv);
  r := public.create_sale(jsonb_build_object('outlet_id', pv, 'payment_method', 'Cash', 'items', jsonb_build_array(jsonb_build_object('service_id', bike, 'qty', 1))));
  out := out || 'villa sale: ' || (r->>'receipt_no') || ' outlet ok=' || ((r->>'outlet_id')::uuid = pv)::text || E'\n';
  begin perform public.create_sale(jsonb_build_object('outlet_id', rv, 'items', jsonb_build_array(jsonb_build_object('service_id', bike))));
    out := out || 'FAIL villa cashier sold at Ratu' || E'\n';
  exception when others then out := out || 'ok other outlet blocked: ' || sqlerrm || E'\n'; end;
  begin perform public.create_sale(jsonb_build_object('outlet_id', pv, 'items', jsonb_build_array(jsonb_build_object('service_id', massage))));
    out := out || 'FAIL Ratu-only massage sold at Villas' || E'\n';
  exception when others then out := out || 'ok not-sold-here blocked: ' || sqlerrm || E'\n'; end;
  select count(*) into n from public.transactions where outlet_id = rv;
  out := out || 'villa cashier sees Ratu sales: ' || n || E'\n';
  begin perform public.open_shift(0, rv); out := out || 'FAIL second shift' || E'\n';
  exception when others then out := out || 'ok one open shift: ' || sqlerrm || E'\n'; end;

  -- owner (all outlets)
  perform set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
  r := public.create_sale(jsonb_build_object('outlet_id', rv, 'payment_method', 'Cash', 'items', jsonb_build_array(jsonb_build_object('service_id', massage, 'qty', 1))));
  out := out || 'owner Ratu sale: ' || (r->>'receipt_no') || E'\n';
  r := public.create_sale(jsonb_build_object('payment_method', 'Cash', 'items', jsonb_build_array(jsonb_build_object('service_id', bike, 'qty', 1))));
  out := out || 'old app (no outlet) → ' || (select name from public.outlets where id = (r->>'outlet_id')::uuid) || E'\n';
  rep := public.sales_report((now() at time zone 'Asia/Makassar')::date, (now() at time zone 'Asia/Makassar')::date, pv);
  out := out || 'report Villas only: count=' || (rep->>'count') || ' by_outlet=' || (rep->'by_outlet')::text || E'\n';
  rep := public.sales_report((now() at time zone 'Asia/Makassar')::date, (now() at time zone 'Asia/Makassar')::date);
  out := out || 'report all: outlets=' || jsonb_array_length(rep->'by_outlet') || E'\n';

  perform set_config('role', 'postgres', true);
  raise exception E'PX-POS-OUTLET-TEST (rolled back)\n%', out;
end $$;
