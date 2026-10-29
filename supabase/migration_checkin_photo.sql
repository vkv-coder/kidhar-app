-- ==========================================
-- STAFFTRACK (Kidhar) - Optional check-in photo
-- Admin can require a selfie-style photo on every check-in. Photos go in
-- their own private, app-specific bucket (not shared with any other app's
-- files on this project) at path "{company_id}/{random_uuid}.jpg" - the
-- company_id folder lets RLS scope admin access per-company, and the
-- random filename (not staff_id/checkin_id) keeps paths unguessable.
-- ==========================================

alter table stf_companies add column if not exists require_photo boolean not null default false;
alter table stf_checkins add column if not exists photo_path text;

create or replace function stf_set_require_photo(p_require boolean)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not stf_is_admin() then raise exception 'Not authorized.'; end if;
  update stf_companies set require_photo = p_require where id = stf_my_company_id();
end;
$$;

revoke all on function stf_set_require_photo(boolean) from public;
grant execute on function stf_set_require_photo(boolean) to authenticated;

insert into storage.buckets (id, name, public)
values ('kidhar-checkins', 'kidhar-checkins', false)
on conflict (id) do nothing;

create policy "kidhar_checkins_insert" on storage.objects for insert
  with check (
    bucket_id = 'kidhar-checkins'
    and stf_is_active_user()
    and (storage.foldername(name))[1] = stf_my_company_id()::text
  );

create policy "kidhar_checkins_select" on storage.objects for select
  using (
    bucket_id = 'kidhar-checkins'
    and (
      owner = auth.uid()
      or ((storage.foldername(name))[1] = stf_my_company_id()::text and stf_is_admin())
    )
  );

-- ---------- stf_log_checkin: accept + enforce the optional photo ----------

create or replace function stf_log_checkin(p_lat double precision, p_lng double precision, p_accuracy_m numeric, p_note text, p_photo_path text)
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
  v_require_photo boolean;
begin
  if not stf_is_active_user() then raise exception 'Your account is not active yet.'; end if;
  if p_lat is null or p_lng is null then raise exception 'Location is required.'; end if;
  if p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    raise exception 'Invalid coordinates.';
  end if;

  select company_id into v_company_id from stf_profiles where stf_profiles.id = auth.uid();

  select require_photo into v_require_photo from stf_companies where id = v_company_id;
  if v_require_photo and (p_photo_path is null or trim(p_photo_path) = '') then
    raise exception 'A photo is required for check-in at your company.';
  end if;
  if p_photo_path is not null and (storage.foldername(p_photo_path))[1] <> v_company_id::text then
    raise exception 'Invalid photo.';
  end if;

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

  insert into stf_checkins (company_id, staff_id, lat, lng, accuracy_m, note, distance_from_zone_m, matched_zone_name, photo_path)
  values (v_company_id, auth.uid(), p_lat, p_lng, p_accuracy_m, nullif(trim(coalesce(p_note, '')), ''),
          v_best_distance, case when v_matched then v_best_zone_name else null end, p_photo_path)
  returning stf_checkins.id, stf_checkins.captured_at into v_id, v_captured_at;

  update stf_profiles set rolling_alert_sent_at = null where id = auth.uid();

  return query select v_id, v_captured_at;
end;
$$;

revoke all on function stf_log_checkin(double precision, double precision, numeric, text, text) from public;
grant execute on function stf_log_checkin(double precision, double precision, numeric, text, text) to authenticated;

drop function if exists stf_log_checkin(double precision, double precision, numeric, text);
