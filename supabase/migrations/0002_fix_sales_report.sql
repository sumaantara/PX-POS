-- Fix: per-day grouping and numeric ordering in sales_report
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
