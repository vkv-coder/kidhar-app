-- ==========================================
-- STAFFTRACK - Full Schema
-- Multi-tenant staff location check-in app.
-- Run this once in Supabase SQL Editor (project Rotary_Events / wrzpgultvahxbrgooibn)
-- ==========================================

-- ---------- TABLES ----------

create table if not exists stf_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists stf_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  company_id uuid not null references stf_companies(id),
  name text not null,
  role text not null check (role in ('staff','admin')),
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_stf_profiles_company on stf_profiles(company_id);

create table if not exists stf_checkins (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references stf_companies(id),
  staff_id uuid not null references stf_profiles(id),
  lat double precision not null,
  lng double precision not null,
  accuracy_m numeric,
  note text,
  captured_at timestamptz not null default now()
);

create index if not exists idx_stf_checkins_staff on stf_checkins(staff_id, captured_at desc);
create index if not exists idx_stf_checkins_company on stf_checkins(company_id, captured_at desc);

-- ---------- ROLE HELPERS ----------

create or replace function stf_my_company_id()
returns uuid
language sql security definer stable
set search_path = public
as $$
  select company_id from stf_profiles where id = auth.uid() and active;
$$;

create or replace function stf_is_admin()
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists(select 1 from stf_profiles where id = auth.uid() and role = 'admin' and active);
$$;

create or replace function stf_is_active_user()
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists(select 1 from stf_profiles where id = auth.uid() and active);
$$;

-- ---------- RLS ----------

alter table stf_companies enable row level security;
alter table stf_profiles enable row level security;
alter table stf_checkins enable row level security;

-- companies: name list needs to be visible on the signup page (to pick which
-- company to join) before the person has any profile/session role yet, so
-- this is readable by anon too. Only id/name/active - nothing sensitive.
create policy "companies_select" on stf_companies for select
  using (true);

-- profiles: see your own row, or every row in your own company if admin.
-- No direct insert/update grants at all - company creation, joining, and
-- activation all go through RPCs below so the role/active/company_id
-- invariants can never be forged from the client.
create policy "profiles_select" on stf_profiles for select
  using (id = auth.uid() or (stf_is_admin() and company_id = stf_my_company_id()));

-- checkins: a staff member sees their own check-ins; admin sees every
-- check-in for their own company. All writes go through stf_log_checkin.
create policy "checkins_select" on stf_checkins for select
  using (staff_id = auth.uid() or (stf_is_admin() and company_id = stf_my_company_id()));

-- ---------- GRANTS ----------
-- SQL-editor-pasted schemas get zero default table grants - RLS alone
-- leaves everyone locked out, so these are required even though every
-- write actually happens through SECURITY DEFINER RPCs below.

grant select on stf_companies to anon, authenticated;
grant select on stf_profiles to authenticated;
grant select on stf_checkins to authenticated;

-- No direct writes from the client on any table - everything through RPCs.
revoke insert, update, delete on stf_companies from authenticated, anon;
revoke insert, update, delete on stf_profiles from authenticated, anon;
revoke insert, update, delete on stf_checkins from authenticated, anon;

-- ---------- RPCs ----------

-- First person at a company: creates the company and becomes its admin,
-- active immediately (there is no one else yet to approve them).
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

  insert into stf_companies (name) values (trim(p_company_name))
  returning id into v_company_id;

  insert into stf_profiles (id, company_id, name, role, active)
  values (auth.uid(), v_company_id, trim(p_admin_name), 'admin', true);

  return v_company_id;
end;
$$;

revoke all on function stf_signup_create_company(text,text) from public;
grant execute on function stf_signup_create_company(text,text) to authenticated;

-- Staff joins an existing company - stays inactive until an admin of that
-- company approves them.
create or replace function stf_signup_join_company(p_company_id uuid, p_staff_name text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  if exists(select 1 from stf_profiles where id = auth.uid()) then
    raise exception 'You already have a profile.';
  end if;
  if p_staff_name is null or trim(p_staff_name) = '' then
    raise exception 'Your name is required.';
  end if;
  if not exists(select 1 from stf_companies where id = p_company_id and active) then
    raise exception 'Selected company was not found.';
  end if;

  insert into stf_profiles (id, company_id, name, role, active)
  values (auth.uid(), p_company_id, trim(p_staff_name), 'staff', false);
end;
$$;

revoke all on function stf_signup_join_company(uuid,text) from public;
grant execute on function stf_signup_join_company(uuid,text) to authenticated;

-- Admin activates/deactivates a staff member in their own company.
create or replace function stf_admin_set_active(p_profile_id uuid, p_active boolean)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not stf_is_admin() then raise exception 'Not authorized.'; end if;
  if not exists(select 1 from stf_profiles where id = p_profile_id and company_id = stf_my_company_id()) then
    raise exception 'Staff member not found in your company.';
  end if;
  update stf_profiles set active = p_active where id = p_profile_id;
end;
$$;

revoke all on function stf_admin_set_active(uuid,boolean) from public;
grant execute on function stf_admin_set_active(uuid,boolean) to authenticated;

-- Logs one location check-in for the calling staff member. company_id and
-- staff_id are taken from the caller's own profile, never from client input,
-- so a check-in can never be forged under someone else's name/company.
create or replace function stf_log_checkin(p_lat double precision, p_lng double precision, p_accuracy_m numeric, p_note text)
returns table(checkin_id uuid, checkin_captured_at timestamptz)
language plpgsql security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_id uuid;
  v_captured_at timestamptz;
begin
  if not stf_is_active_user() then raise exception 'Your account is not active yet.'; end if;
  if p_lat is null or p_lng is null then raise exception 'Location is required.'; end if;
  if p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    raise exception 'Invalid coordinates.';
  end if;

  select company_id into v_company_id from stf_profiles where stf_profiles.id = auth.uid();

  insert into stf_checkins (company_id, staff_id, lat, lng, accuracy_m, note)
  values (v_company_id, auth.uid(), p_lat, p_lng, p_accuracy_m, nullif(trim(coalesce(p_note,'')), ''))
  returning stf_checkins.id, stf_checkins.captured_at into v_id, v_captured_at;

  return query select v_id, v_captured_at;
end;
$$;

revoke all on function stf_log_checkin(double precision,double precision,numeric,text) from public;
grant execute on function stf_log_checkin(double precision,double precision,numeric,text) to authenticated;
