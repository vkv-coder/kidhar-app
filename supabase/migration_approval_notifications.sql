-- ==========================================
-- STAFFTRACK (Kidhar) - approval gating + Telegram notifications for both
-- approval paths:
--   1. A brand-new company's founding admin now needs the APP admin (the
--      Kidhar operator, not any company's own admin) to approve them
--      before they can use the app at all.
--   2. A new staff member joining an existing company still needs their
--      OWN company's admin to approve them (unchanged) - but that admin
--      now gets a Telegram ping about it if they've connected Telegram,
--      instead of having to notice it themselves in the app.
-- ==========================================

-- A new company starts inactive (was `true` - "no one else yet to
-- approve them", which is exactly the gap being closed here) and so does
-- its founding admin's profile, mirroring how staff already start
-- inactive until approved.
create or replace function stf_signup_create_company(p_company_name text, p_admin_name text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_company_id uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  if exists(select 1 from stf_profiles where id = auth.uid()) then
    raise exception 'You already have a profile.';
  end if;
  if p_company_name is null or trim(p_company_name) = '' then
    raise exception 'Company name is required.';
  end if;
  if p_admin_name is null or trim(p_admin_name) = '' then
    raise exception 'Your name is required.';
  end if;

  insert into stf_companies (name, active) values (trim(p_company_name), false)
  returning id into v_company_id;

  insert into stf_profiles (id, company_id, name, role, active)
  values (auth.uid(), v_company_id, trim(p_admin_name), 'admin', false);

  return v_company_id;
end;
$$;

-- Tracking columns so the notifier below only ever pings once per
-- pending row, not on every ~15-min cron tick until it's acted on.
alter table stf_companies add column if not exists app_admin_notified_at timestamptz;
alter table stf_profiles add column if not exists approval_notified_at timestamptz;

-- App-admin-only approval action. Deliberately NO grant to anon/
-- authenticated at all below - this is not reachable from any client
-- page, only via direct SQL (same pattern as every other app-operator
-- action across this portfolio) until/unless a dedicated app-admin tool
-- is built.
create or replace function stf_app_admin_approve_company(p_company_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  update stf_companies set active = true where id = p_company_id;
  update stf_profiles set active = true where company_id = p_company_id and role = 'admin';
end;
$$;
revoke all on function stf_app_admin_approve_company(uuid) from public;

-- Companies awaiting app-admin approval, not yet pinged.
create or replace function stf_find_pending_company_approvals()
returns table(company_id uuid, company_name text, admin_name text, admin_email text)
language sql security definer stable
set search_path = public
as $$
  select c.id, c.name, p.name, u.email
  from stf_companies c
  join stf_profiles p on p.company_id = c.id and p.role = 'admin'
  join auth.users u on u.id = p.id
  where c.active = false and c.app_admin_notified_at is null;
$$;
revoke all on function stf_find_pending_company_approvals() from public;

create or replace function stf_mark_company_approval_notified(p_company_id uuid)
returns void language sql security definer set search_path = public
as $$ update stf_companies set app_admin_notified_at = now() where id = p_company_id; $$;
revoke all on function stf_mark_company_approval_notified(uuid) from public;

-- Staff awaiting their own company admin's approval, where that admin has
-- a Telegram connected, not yet pinged for this particular staff row.
create or replace function stf_find_pending_staff_approvals()
returns table(staff_id uuid, staff_name text, admin_chat_id text)
language sql security definer stable
set search_path = public
as $$
  select p.id, p.name, admin.telegram_chat_id
  from stf_profiles p
  join stf_profiles admin on admin.company_id = p.company_id and admin.role = 'admin' and admin.active
  where p.role = 'staff' and p.active = false and p.approval_notified_at is null
    and admin.telegram_chat_id is not null;
$$;
revoke all on function stf_find_pending_staff_approvals() from public;

create or replace function stf_mark_staff_approval_notified(p_staff_id uuid)
returns void language sql security definer set search_path = public
as $$ update stf_profiles set approval_notified_at = now() where id = p_staff_id; $$;
revoke all on function stf_mark_staff_approval_notified(uuid) from public;
