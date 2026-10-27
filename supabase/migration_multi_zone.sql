-- ==========================================
-- STAFFTRACK (Kidhar) - Multiple named zones per company
-- Replaces the single zone_lat/zone_lng/zone_radius_m columns on
-- stf_companies with a proper stf_zones table - a check-in now counts if
-- it's inside ANY of a company's zones (or always allowed if the company
-- has none yet).
-- ==========================================

create table if not exists stf_zones (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references stf_companies(id),
  name text not null,
  lat double precision not null,
  lng double precision not null,
  radius_m numeric not null check (radius_m > 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_stf_zones_company on stf_zones(company_id);

alter table stf_checkins add column if not exists matched_zone_name text;

-- Carry forward any company that already had the old single zone set.
insert into stf_zones (company_id, name, lat, lng, radius_m)
select id, 'Zone 1', zone_lat, zone_lng, zone_radius_m
from stf_companies
where zone_lat is not null and zone_lng is not null and zone_radius_m is not null;

alter table stf_companies drop column if exists zone_lat;
alter table stf_companies drop column if exists zone_lng;
alter table stf_companies drop column if exists zone_radius_m;

alter table stf_zones enable row level security;

create policy "zones_admin_select" on stf_zones for select
  using (stf_is_admin() and company_id = stf_my_company_id());

grant select on stf_zones to authenticated;
revoke insert, update, delete on stf_zones from authenticated, anon;

create or replace function stf_add_zone(p_name text, p_lat double precision, p_lng double precision, p_radius_m numeric)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not stf_is_admin() then raise exception 'Not authorized.'; end if;
  if p_name is null or trim(p_name) = '' then raise exception 'Zone name is required.'; end if;
  if p_lat is null or p_lng is null or p_radius_m is null then raise exception 'Location and radius are required.'; end if;
  if p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then raise exception 'Invalid coordinates.'; end if;
  if p_radius_m <= 0 then raise exception 'Radius must be greater than zero.'; end if;

  insert into stf_zones (company_id, name, lat, lng, radius_m)
  values (stf_my_company_id(), trim(p_name), p_lat, p_lng, p_radius_m)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function stf_add_zone(text, double precision, double precision, numeric) from public;
grant execute on function stf_add_zone(text, double precision, double precision, numeric) to authenticated;

create or replace function stf_update_zone(p_zone_id uuid, p_name text, p_lat double precision, p_lng double precision, p_radius_m numeric)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not stf_is_admin() then raise exception 'Not authorized.'; end if;
  if not exists (select 1 from stf_zones where id = p_zone_id and company_id = stf_my_company_id()) then
    raise exception 'Zone not found in your company.';
  end if;
  if p_name is null or trim(p_name) = '' then raise exception 'Zone name is required.'; end if;
  if p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then raise exception 'Invalid coordinates.'; end if;
  if p_radius_m <= 0 then raise exception 'Radius must be greater than zero.'; end if;

  update stf_zones set name = trim(p_name), lat = p_lat, lng = p_lng, radius_m = p_radius_m
  where id = p_zone_id;
end;
$$;

revoke all on function stf_update_zone(uuid, text, double precision, double precision, numeric) from public;
grant execute on function stf_update_zone(uuid, text, double precision, double precision, numeric) to authenticated;

create or replace function stf_delete_zone(p_zone_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not stf_is_admin() then raise exception 'Not authorized.'; end if;
  if not exists (select 1 from stf_zones where id = p_zone_id and company_id = stf_my_company_id()) then
    raise exception 'Zone not found in your company.';
  end if;
  delete from stf_zones where id = p_zone_id;
end;
$$;

revoke all on function stf_delete_zone(uuid) from public;
grant execute on function stf_delete_zone(uuid) to authenticated;

-- ---------- stf_log_checkin: check against ANY of the company's zones ----------

create or replace function stf_log_checkin(p_lat double precision, p_lng double precision, p_accuracy_m numeric, p_note text)
returns table(checkin_id uuid, checkin_captured_at timestamptz)
language plpgsql security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_id uuid;
  v_captured_at timestamptz;
  v_zone record;
  v_distance double precision;
  v_best_zone_name text;
  v_best_distance double precision;
  v_best_radius numeric;
  v_matched boolean := false;
  v_has_zones boolean := false;
begin
  if not stf_is_active_user() then raise exception 'Your account is not active yet.'; end if;
  if p_lat is null or p_lng is null then raise exception 'Location is required.'; end if;
  if p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    raise exception 'Invalid coordinates.';
  end if;

  select company_id into v_company_id from stf_profiles where stf_profiles.id = auth.uid();

  for v_zone in select * from stf_zones where company_id = v_company_id loop
    v_has_zones := true;
    v_distance := stf_distance_m(p_lat, p_lng, v_zone.lat, v_zone.lng);
    if v_best_distance is null or v_distance < v_best_distance then
      v_best_distance := v_distance;
      v_best_zone_name := v_zone.name;
      v_best_radius := v_zone.radius_m;
    end if;
    if v_distance <= v_zone.radius_m then
      v_matched := true;
      exit;
    end if;
  end loop;

  if v_has_zones and not v_matched then
    raise exception 'You are about % m outside the nearest zone (% - max % m allowed). Move closer and try again.',
      round(v_best_distance)::int, v_best_zone_name, round(v_best_radius)::int;
  end if;

  insert into stf_checkins (company_id, staff_id, lat, lng, accuracy_m, note, distance_from_zone_m, matched_zone_name)
  values (v_company_id, auth.uid(), p_lat, p_lng, p_accuracy_m, nullif(trim(coalesce(p_note, '')), ''),
          v_best_distance, case when v_matched then v_best_zone_name else null end)
  returning stf_checkins.id, stf_checkins.captured_at into v_id, v_captured_at;

  update stf_profiles set rolling_alert_sent_at = null where id = auth.uid();

  return query select v_id, v_captured_at;
end;
$$;

revoke all on function stf_log_checkin(double precision, double precision, numeric, text) from public;
grant execute on function stf_log_checkin(double precision, double precision, numeric, text) to authenticated;

-- stf_set_zone from the old single-zone model is no longer used.
drop function if exists stf_set_zone(double precision, double precision, numeric);
