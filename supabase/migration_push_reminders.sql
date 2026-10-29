-- ==========================================
-- STAFFTRACK (Kidhar) - Web Push reminders for staff themselves
-- Admin alerts stay on Telegram. Staff get a buzz/notification straight
-- from the app, at the exact same moment an admin would be alerted -
-- reuses the same detection, just also pushes to the staff member.
-- ==========================================

alter table stf_profiles add column if not exists push_endpoint text;
alter table stf_profiles add column if not exists push_p256dh text;
alter table stf_profiles add column if not exists push_auth text;

create or replace function stf_set_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  update stf_profiles set push_endpoint = p_endpoint, push_p256dh = p_p256dh, push_auth = p_auth where id = auth.uid();
end;
$$;

revoke all on function stf_set_push_subscription(text, text, text) from public;
grant execute on function stf_set_push_subscription(text, text, text) to authenticated;

-- Called by the idle-check function if a push send comes back expired/gone
-- (HTTP 410), so we stop retrying a dead subscription forever.
create or replace function stf_clear_push_subscription(p_staff_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  update stf_profiles set push_endpoint = null, push_p256dh = null, push_auth = null where id = p_staff_id;
end;
$$;

revoke all on function stf_clear_push_subscription(uuid) from public;

-- ---------- stf_find_overdue_alerts: also surface the staff member's own push subscription ----------
-- No longer requires admin.telegram_chat_id - a row is now worth acting on
-- if EITHER the admin has Telegram connected OR the staff member has a
-- push subscription (the Edge Function sends whichever channels exist).

drop function if exists stf_find_overdue_alerts();

create function stf_find_overdue_alerts()
returns table (
  alert_kind text,
  window_id uuid,
  staff_id uuid,
  staff_name text,
  admin_chat_id text,
  push_endpoint text,
  push_p256dh text,
  push_auth text,
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
      admin.telegram_chat_id as admin_chat_id, p.push_endpoint, p.push_p256dh, p.push_auth,
      'entry'::text as checkpoint, w.start_time as window_start, w.end_time as window_end
    from stf_shift_windows w
    join stf_profiles p on p.id = w.staff_id and p.active
    join stf_profiles admin on admin.company_id = p.company_id and admin.role = 'admin'
    cross join ist_now
    where (admin.telegram_chat_id is not null or p.push_endpoint is not null)
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
      admin.telegram_chat_id as admin_chat_id, p.push_endpoint, p.push_p256dh, p.push_auth,
      'exit'::text as checkpoint, w.start_time as window_start, w.end_time as window_end
    from stf_shift_windows w
    join stf_profiles p on p.id = w.staff_id and p.active
    join stf_profiles admin on admin.company_id = p.company_id and admin.role = 'admin'
    cross join ist_now
    where (admin.telegram_chat_id is not null or p.push_endpoint is not null)
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
      admin.telegram_chat_id as admin_chat_id, p.push_endpoint, p.push_p256dh, p.push_auth,
      'rolling'::text as checkpoint, null::time as window_start, null::time as window_end
    from stf_profiles p
    join stf_profiles admin on admin.company_id = p.company_id and admin.role = 'admin'
    cross join ist_now
    where p.role = 'staff' and p.active
      and p.idle_alert_hours is not null
      and (admin.telegram_chat_id is not null or p.push_endpoint is not null)
      and p.rolling_alert_sent_at is null
      and not exists (select 1 from stf_shift_windows w where w.staff_id = p.id)
      and (ist_now.ts::time) >= p.idle_active_start
      and (ist_now.ts::time) <= p.idle_active_end
      and extract(epoch from (
            now() - greatest(
              coalesce((select max(c.captured_at) from stf_checkins c where c.staff_id = p.id), p.created_at),
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
