-- ==========================================
-- STAFFTRACK (Kidhar) - reliable in-Supabase scheduler for the
-- kidhar-idle-check Edge Function.
--
-- GitHub Actions' `schedule:` trigger (.github/workflows/idle-check-cron.yml)
-- turned out to be unreliable here - observed gaps of several HOURS between
-- runs instead of every 15 minutes, which delayed real staff alerts (e.g. a
-- staff member's "reach by" task deadline was missed with no Telegram alert
-- for hours). pg_cron runs inside this Supabase project's own Postgres
-- instance, so it isn't subject to GitHub's scheduling delays.
--
-- The GitHub Actions workflow is left in place as a harmless backup trigger
-- - the Edge Function marks each alert as sent (alerted_at /
-- last_alert_sent_at), so a duplicate call from there is a no-op.
-- ==========================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- One-time setup (run manually, NOT committed - same reason no other
-- secret value lives in these migration files):
--   select vault.create_secret(
--     '<value of the KIDHAR_CRON_SECRET edge function secret>',
--     'kidhar_cron_secret',
--     'Shared secret for triggering kidhar-idle-check Edge Function from pg_cron.'
--   );

select cron.schedule(
  'kidhar-idle-check',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://wrzpgultvahxbrgooibn.supabase.co/functions/v1/kidhar-idle-check',
    headers := jsonb_build_object(
      'X-Cron-Secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'kidhar_cron_secret')
    )
  );
  $$
);

-- To inspect run history:
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'kidhar-idle-check') order by start_time desc limit 10;
