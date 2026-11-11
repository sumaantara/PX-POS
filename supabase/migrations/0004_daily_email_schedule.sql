-- PX POS: hourly scheduler for the daily sales email (the function itself decides whether it is time to send).
-- Run AFTER deploying the daily-report edge function.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('px-daily-report') where exists (select 1 from cron.job where jobname = 'px-daily-report');
select cron.schedule('px-daily-report', '1 * * * *', $job$
  select net.http_post(
    url     := 'https://nmpinkizjivkhxbndtdk.supabase.co/functions/v1/daily-report',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-key', (select cron_key from px_private.secrets where id = 1)),
    body    := '{"scheduled":true}'::jsonb,
    timeout_milliseconds := 30000)
$job$);
