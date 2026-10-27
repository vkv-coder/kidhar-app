-- ==========================================
-- STAFFTRACK (Kidhar) - Zone geofence + shift/idle Telegram alerts
-- Run once in Supabase SQL Editor (project Rotary_Events / wrzpgultvahxbrgooibn)
-- ==========================================

-- ---------- ZONE (geofence) ----------

alter table stf_companies add column if not exists zone_lat double precision;
alter table stf_companies add column if not exists zone_lng double precision;
alter table stf_companies add column if not exists zone_radius_m numeric;

alter table stf_checkins add column if not exists distance_from_zone_m numeric;

create or replace function stf_distance_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision
language sql immutable
as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  ));
$$;

create or replace function stf_set_zone(p_lat double precision, p_lng double precision, p_radius_m numeric)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not stf_is_admin() then raise exception 'Not authorized.'; end if;
  if p_lat is null or p_lng is null or p_radius_m is null then raise exception 'Location and radius are required.'; end if;
  if p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then raise exception 'Invalid coordinates.'; end if;
  if p_radius_m <= 0 then raise exception 'Radius must be greater than zero.'; end if;
  update stf_companies set zone_lat = p_lat, zone_lng = p_lng, zone_radius_m = p_radius_m where id = stf_my_company_id();
end;
$$;

revoke all on function stf_set_zone(double precision, double precision, numeric) from public;
grant execute on function stf_set_zone(double precision, double precision, numeric) to authenticated;

-- ---------- SHIFT WINDOWS + ROLLING IDLE + TELEGRAM LINK ----------

alter table stf_profiles add column if not exists idle_alert_hours numeric;
alter table stf_profiles add column if not exists telegram_chat_id text;
alter table stf_profiles add column if not exists telegram_link_code text;
alter table stf_profiles add column if not exists rolling_alert_sent_at timestamptz;

create table if not exists stf_shift_windows (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references stf_profiles(id) on delete cascade,
  start_time time not null,
  end_time time not null,
  grace_minutes int not null default 20,
  created_at timestamptz not null default now(),
  constraint stf_shift_windows_valid_range check (end_time > start_time)
);

create index if not exists idx_stf_shift_windows_staff on stf_shift_windows(staff_id);

-- Shift times are entered and evaluated as India (IST) wall-clock time,
-- since every current customer is India-based - see idle-check function.
create table if not exists stf_shift_alerts (
  id uuid primary key default gen_random_uuid(),
  shift_window_id uuid not null references stf_shift_windows(id) on delete cascade,
  alert_date date not null,
  checkpoint text not null check (checkpoint in ('entry', 'exit')),
  sent_at timestamptz not null default now(),
  unique (shift_window_id, alert_date, checkpoint)
);

alter table stf_shift_windows enable row level security;
alter table stf_shift_alerts enable row level security;

-- Admin can view (for the schedule editor) windows belonging to their own
-- company's staff. No direct writes - only via stf_set_shift_windows below.
create policy "shift_windows_admin_select" on stf_shift_windows for select
  using (exists (
    select 1 from stf_profiles p
    where p.id = stf_shift_windows.staff_id and p.company_id = stf_my_company_id()
  ) and stf_is_admin());

grant select on stf_shift_windows to authenticated;
revoke insert, update, delete on stf_shift_windows from authenticated, anon;
-- stf_shift_alerts is purely internal bookkeeping for the idle-check
-- function (which runs as service_role and bypasses RLS) - no client
-- access needed at all.

-- Replaces the full set of shift windows for one staff member atomically.
-- p_windows is a jsonb array like [{"start_time":"08:00","end_time":"10:00","grace_minutes":20}, ...].
-- An empty array clears all windows for that staff member (switches them to
-- rolling-idle mode, if idle_alert_hours is set).
create or replace function stf_set_shift_windows(p_staff_id uuid, p_windows jsonb)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_window jsonb;
begin
  if not stf_is_admin() then raise exception 'Not authorized.'; end if;
  if not exists (select 1 from stf_profiles where id = p_staff_id and company_id = stf_my_company_id()) then
    raise exception 'Staff member not found in your company.';
  end if;

  delete from stf_shift_windows where staff_id = p_staff_id;

  for v_window in select * from jsonb_array_elements(coalesce(p_windows, '[]'::jsonb)) loop
    insert into stf_shift_windows (staff_id, start_time, end_time, grace_minutes)
    values (
      p_staff_id,
      (v_window->>'start_time')::time,
      (v_window->>'end_time')::time,
      coalesce((v_window->>'grace_minutes')::int, 20)
    );
  end loop;
end;
$$;

revoke all on function stf_set_shift_windows(uuid, jsonb) from public;
grant execute on function stf_set_shift_windows(uuid, jsonb) to authenticated;

-- Sets (or clears, with null) the rolling "alert if idle for N hours"
-- threshold for one staff member. Only meaningful when that staff member
-- has no shift windows defined - shift windows take priority.
create or replace function stf_set_idle_alert_hours(p_staff_id uuid, p_hours numeric)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not stf_is_admin() then raise exception 'Not authorized.'; end if;
  if not exists (select 1 from stf_profiles where id = p_staff_id and company_id = stf_my_company_id()) then
    raise exception 'Staff member not found in your company.';
  end if;
  if p_hours is not null and p_hours <= 0 then raise exception 'Hours must be greater than zero.'; end if;
  update stf_profiles set idle_alert_hours = p_hours, rolling_alert_sent_at = null where id = p_staff_id;
end;
$$;

revoke all on function stf_set_idle_alert_hours(uuid, numeric) from public;
grant execute on function stf_set_idle_alert_hours(uuid, numeric) to authenticated;

-- Generates a fresh one-time linking code for the calling admin to connect
-- their own Telegram. Overwrites any previous unused code.
create or replace function stf_generate_telegram_link_code()
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if not stf_is_admin() then raise exception 'Not authorized.'; end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  update stf_profiles set telegram_link_code = v_code where id = auth.uid();
  return v_code;
end;
$$;

revoke all on function stf_generate_telegram_link_code() from public;
grant execute on function stf_generate_telegram_link_code() to authenticated;

-- ---------- stf_log_checkin: enforce zone + clear rolling alert flag ----------

create or replace function stf_log_checkin(p_lat double precision, p_lng double precision, p_accuracy_m numeric, p_note text)
returns table(checkin_id uuid, checkin_captured_at timestamptz)
language plpgsql security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_id uuid;
  v_captured_at timestamptz;
  v_zone_lat double precision;
  v_zone_lng double precision;
  v_zone_radius numeric;
  v_distance double precision;
begin
  if not stf_is_active_user() then raise exception 'Your account is not active yet.'; end if;
  if p_lat is null or p_lng is null then raise exception 'Location is required.'; end if;
  if p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    raise exception 'Invalid coordinates.';
  end if;

  select company_id into v_company_id from stf_profiles where stf_profiles.id = auth.uid();
  select zone_lat, zone_lng, zone_radius_m into v_zone_lat, v_zone_lng, v_zone_radius
  from stf_companies where id = v_company_id;

  if v_zone_lat is not null and v_zone_lng is not null and v_zone_radius is not null then
    v_distance := stf_distance_m(p_lat, p_lng, v_zone_lat, v_zone_lng);
    if v_distance > v_zone_radius then
      raise exception 'You are about % m outside the zone (max % m allowed). Move closer and try again.',
        round(v_distance)::int, round(v_zone_radius)::int;
    end if;
  end if;

  insert into stf_checkins (company_id, staff_id, lat, lng, accuracy_m, note, distance_from_zone_m)
  values (v_company_id, auth.uid(), p_lat, p_lng, p_accuracy_m, nullif(trim(coalesce(p_note, '')), ''), v_distance)
  returning stf_checkins.id, stf_checkins.captured_at into v_id, v_captured_at;

  update stf_profiles set rolling_alert_sent_at = null where id = auth.uid();

  return query select v_id, v_captured_at;
end;
$$;

revoke all on function stf_log_checkin(double precision, double precision, numeric, text) from public;
grant execute on function stf_log_checkin(double precision, double precision, numeric, text) to authenticated;
