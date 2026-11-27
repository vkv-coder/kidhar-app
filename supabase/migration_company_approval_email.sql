-- Daily audit 2026-11-27: stf_app_admin_approve_company() (the APP
-- admin's "approve this new company" action, called via the
-- kidhar-app-admin edge function) flips the company + its founding
-- admin's profile active, but never told that admin they were
-- approved - they'd only find out by trying to log in again. This app
-- has two existing notification channels (Admin->Telegram,
-- Staff->Web Push, see migration_telegram_alerts.sql/
-- migration_push_reminders.sql) but no email precedent yet; reusing
-- the shared telegram-notify relay's sendEmail action, same pattern
-- already proven on sportbook/derasar-boli/giftcoupon.
--
-- admin_email is already available via auth.users (same join
-- stf_find_pending_company_approvals already uses), no schema change
-- needed.

create or replace function stf_app_admin_approve_company(p_company_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_email text;
  v_company_name text;
begin
  update stf_companies set active = true where id = p_company_id
    returning name into v_company_name;
  update stf_profiles set active = true where company_id = p_company_id and role = 'admin';

  select u.email::text into v_email
  from stf_profiles p
  join auth.users u on u.id = p.id
  where p.company_id = p_company_id and p.role = 'admin';

  if v_email is not null then
    perform net.http_post(
      url := 'https://telegram-notify.unigoods2026.workers.dev/',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := jsonb_build_object(
        'action','sendEmail','to',v_email,'subject','Your Kidhar company is approved',
        'html','<p>Good news - <b>'||coalesce(v_company_name,'your company')||'</b> has been approved on Kidhar.</p><p>You can log in now and start adding staff.</p>'
      )
    );
  end if;
end;
$$;
revoke all on function stf_app_admin_approve_company(uuid) from public;
