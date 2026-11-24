-- ==========================================
-- STAFFTRACK (Kidhar) - PIN-based staff login, for staff with no email
-- (peons etc.). Admin creates the staff profile directly (pre-approved,
-- no join-and-wait-for-approval step needed since the admin is vouching
-- for them directly) and assigns an alphanumeric PIN; staff log in with
-- just that PIN, no email/password at all.
--
-- Staying inside real Supabase Auth rather than inventing a parallel
-- session system: a PIN-login still mints a genuine Supabase session
-- (via the Admin API's magic-link token, exchanged client-side) against a
-- synthetic internal auth.users row, so auth.uid() and every existing RLS
-- policy/helper (stf_is_admin, stf_my_company_id, etc.) keep working
-- completely unchanged for PIN-based staff too.
-- ==========================================

alter table stf_profiles add column if not exists pin text;

-- Global uniqueness (not per-company) - staff log in with just a PIN, no
-- company selector, so two different companies' staff can't share one.
create unique index if not exists idx_stf_profiles_pin on stf_profiles(pin) where pin is not null;

-- Lightweight brute-force guard on the login endpoint: counts recent
-- attempts per caller IP, independent of whether the PIN they tried
-- exists at all (so it also throttles pure guessing against unknown
-- PINs, not just known accounts).
create table if not exists stf_pin_login_attempts (
  id uuid primary key default gen_random_uuid(),
  ip text not null,
  attempted_at timestamptz not null default now()
);
create index if not exists idx_stf_pin_attempts_ip_time on stf_pin_login_attempts(ip, attempted_at desc);
revoke all on stf_pin_login_attempts from anon, authenticated;

create or replace function stf_record_pin_attempt(p_ip text)
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  v_count int;
begin
  insert into stf_pin_login_attempts (ip) values (p_ip);
  select count(*) into v_count from stf_pin_login_attempts
  where ip = p_ip and attempted_at > now() - interval '5 minutes';
  delete from stf_pin_login_attempts where attempted_at < now() - interval '1 hour';
  return v_count;
end;
$$;
revoke all on function stf_record_pin_attempt(text) from public;

-- Looks up which auth user a PIN belongs to (service_role only, called
-- from the kidhar-pin-auth Edge Function - never exposed to the client
-- directly, since that would let anyone enumerate PINs by probing).
create or replace function stf_find_staff_by_pin(p_pin text)
returns uuid
language sql security definer stable
set search_path = public
as $$
  select id from stf_profiles where pin = trim(p_pin) and active;
$$;
revoke all on function stf_find_staff_by_pin(text) from public;

-- Admin assigns/changes a PIN on an EXISTING staff profile (e.g. staff
-- who joined via the email flow earlier, or re-issuing a lost PIN) -
-- doesn't touch auth.users, just the pin column.
create or replace function stf_admin_set_staff_pin(p_staff_id uuid, p_pin text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not stf_is_admin() then raise exception 'Not authorized.'; end if;
  if not exists(select 1 from stf_profiles where id = p_staff_id and company_id = stf_my_company_id()) then
    raise exception 'Staff member not found in your company.';
  end if;
  if p_pin is null or length(trim(p_pin)) < 6 then
    raise exception 'PIN must be at least 6 characters.';
  end if;
  update stf_profiles set pin = trim(p_pin) where id = p_staff_id;
end;
$$;
revoke all on function stf_admin_set_staff_pin(uuid, text) from public;
grant execute on function stf_admin_set_staff_pin(uuid, text) to authenticated;

-- Used by the Edge Function's create-new-PIN-staff action, after it has
-- already created the synthetic auth.users row with service_role - this
-- just inserts the stf_profiles row linking to it. Admin-ness/company_id
-- is derived from p_admin_profile_id, which the Edge Function fetches
-- itself after verifying the caller's own session server-side (never
-- trusted from the client as a bare parameter).
create or replace function stf_admin_create_pin_staff(p_admin_profile_id uuid, p_new_user_id uuid, p_name text, p_pin text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_company_id uuid;
begin
  select company_id into v_company_id from stf_profiles
  where id = p_admin_profile_id and role = 'admin' and active;
  if v_company_id is null then raise exception 'Not authorized.'; end if;
  if p_name is null or trim(p_name) = '' then raise exception 'Staff name is required.'; end if;
  if p_pin is null or length(trim(p_pin)) < 6 then raise exception 'PIN must be at least 6 characters.'; end if;

  insert into stf_profiles (id, company_id, name, role, active, pin)
  values (p_new_user_id, v_company_id, trim(p_name), 'staff', true, trim(p_pin));
end;
$$;
revoke all on function stf_admin_create_pin_staff(uuid, uuid, text, text) from public;
