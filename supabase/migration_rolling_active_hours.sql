-- ==========================================
-- STAFFTRACK (Kidhar) - Active hours for rolling idle-check mode
-- Without this, "alert if idle for N hours" ran all day and all night,
-- so an overnight gap (nobody's supposed to be tapping at 2am) would
-- falsely trigger an alert. Rolling mode now only ever checks within an
-- admin-set daily window (e.g. 09:00-19:00).
-- ==========================================

alter table stf_profiles add column if not exists idle_active_start time;
alter table stf_profiles add column if not exists idle_active_end time;

create or replace function stf_set_idle_alert_hours(p_staff_id uuid, p_hours numeric, p_active_start time, p_active_end time)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not stf_is_admin() then raise exception 'Not authorized.'; end if;
  if not exists (select 1 from stf_profiles where id = p_staff_id and company_id = stf_my_company_id()) then
    raise exception 'Staff member not found in your company.';
  end if;
  if p_hours is not null then
    if p_hours <= 0 then raise exception 'Hours must be greater than zero.'; end if;
    if p_active_start is null or p_active_end is null then raise exception 'Set the active hours range.'; end if;
    if p_active_end <= p_active_start then raise exception 'Active end time must be after the start time.'; end if;
  end if;
  update stf_profiles
  set idle_alert_hours = p_hours,
      idle_active_start = case when p_hours is null then null else p_active_start end,
      idle_active_end = case when p_hours is null then null else p_active_end end,
      rolling_alert_sent_at = null
  where id = p_staff_id;
end;
$$;

revoke all on function stf_set_idle_alert_hours(uuid, numeric, time, time) from public;
grant execute on function stf_set_idle_alert_hours(uuid, numeric, time, time) to authenticated;

drop function if exists stf_set_idle_alert_hours(uuid, numeric);

-- ---------- stf_find_overdue_alerts: only check rolling mode during active hours ----------

create or replace function stf_find_overdue_alerts()
returns table (
  alert_kind text,
  window_id uuid,
  staff_id uuid,
  staff_name text,
  admin_chat_id text,
  checkpoint text,
  window_start time,
  window_end time
)
language sql
security definer
set search_path = public
as $$
  with ist_now as (
    select (now() at time zone 'Asia/Kolkata') as ts
  ),
  shift_entry as (
    select
      'shift'::text as alert_kind, w.id as window_id, p.id as staff_id, p.name as staff_name,
      admin.telegram_chat_id as admin_chat_id, 'entry'::text as checkpoint,
      w.start_time as window_start, w.end_time as window_end
    from stf_shift_windows w
    join stf_profiles p on p.id = w.staff_id and p.active
    join stf_profiles admin on admin.company_id = p.company_id and admin.role = 'admin'
    cross join ist_now
    where admin.telegram_chat_id is not null
      and (ist_now.ts::time) > (w.start_time + (w.grace_minutes || ' minutes')::interval)
      and not exists (
        select 1 from stf_checkins c
        where c.staff_id = p.id
          and (c.captured_at at time zone 'Asia/Kolkata')::date = (ist_now.ts)::date
          and (c.captured_at at time zone 'Asia/Kolkata')::time >= w.start_time
      )
      and not exists (
        select 1 from stf_shift_alerts a
        where a.shift_window_id = w.id and a.alert_date = (ist_now.ts)::date and a.checkpoint = 'entry'
      )
  ),
  shift_exit as (
    select
      'shift'::text as alert_kind, w.id as window_id, p.id as staff_id, p.name as staff_name,
      admin.telegram_chat_id as admin_chat_id, 'exit'::text as checkpoint,
      w.start_time as window_start, w.end_time as window_end
    from stf_shift_windows w
    join stf_profiles p on p.id = w.staff_id and p.active
    join stf_profiles admin on admin.company_id = p.company_id and admin.role = 'admin'
    cross join ist_now
    where admin.telegram_chat_id is not null
      and (ist_now.ts::time) > (w.end_time + (w.grace_minutes || ' minutes')::interval)
      and (
        select count(*) from stf_checkins c
        where c.staff_id = p.id
          and (c.captured_at at time zone 'Asia/Kolkata')::date = (ist_now.ts)::date
          and (c.captured_at at time zone 'Asia/Kolkata')::time >= w.start_time
          and (c.captured_at at time zone 'Asia/Kolkata')::time <= w.end_time
      ) < 2
      and not exists (
        select 1 from stf_shift_alerts a
        where a.shift_window_id = w.id and a.alert_date = (ist_now.ts)::date and a.checkpoint = 'exit'
      )
  ),
  rolling as (
    select
      'rolling'::text as alert_kind, null::uuid as window_id, p.id as staff_id, p.name as staff_name,
      admin.telegram_chat_id as admin_chat_id, 'rolling'::text as checkpoint,
      null::time as window_start, null::time as window_end
    from stf_profiles p
    join stf_profiles admin on admin.company_id = p.company_id and admin.role = 'admin'
    cross join ist_now
    where p.role = 'staff' and p.active
      and p.idle_alert_hours is not null
      and admin.telegram_chat_id is not null
      and p.rolling_alert_sent_at is null
      and not exists (select 1 from stf_shift_windows w where w.staff_id = p.id)
      -- Only ever check within today's active-hours window, not around the clock.
      and (ist_now.ts::time) >= p.idle_active_start
      and (ist_now.ts::time) <= p.idle_active_end
      and extract(epoch from (
            now() - greatest(
              coalesce((select max(c.captured_at) from stf_checkins c where c.staff_id = p.id), p.created_at),
              -- Each day's active window starts a fresh clock, so an
              -- overnight gap doesn't trigger an immediate alert the
              -- moment the window opens.
              (ist_now.ts::date + p.idle_active_start) at time zone 'Asia/Kolkata'
            )
          )) / 3600.0 > p.idle_alert_hours
  )
  select * from shift_entry
  union all
  select * from shift_exit
  union all
  select * from rolling;
$$;

revoke all on function stf_find_overdue_alerts() from public;
