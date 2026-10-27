-- ==========================================
-- STAFFTRACK (Kidhar) - Telegram alert dispatch functions
-- service_role only (the scheduled Edge Function) - never grant these to
-- anon/authenticated, since they read/write across every company's data.
-- All shift times are evaluated as India (IST) wall-clock time.
-- ==========================================

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
      and extract(epoch from (now() - coalesce(
            (select max(c.captured_at) from stf_checkins c where c.staff_id = p.id),
            p.created_at
          ))) / 3600.0 > p.idle_alert_hours
  )
  select * from shift_entry
  union all
  select * from shift_exit
  union all
  select * from rolling;
$$;

revoke all on function stf_find_overdue_alerts() from public;

create or replace function stf_record_alert_sent(p_alert_kind text, p_window_id uuid, p_staff_id uuid, p_checkpoint text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if p_alert_kind = 'shift' then
    insert into stf_shift_alerts (shift_window_id, alert_date, checkpoint)
    values (p_window_id, (now() at time zone 'Asia/Kolkata')::date, p_checkpoint)
    on conflict (shift_window_id, alert_date, checkpoint) do nothing;
  elsif p_alert_kind = 'rolling' then
    update stf_profiles set rolling_alert_sent_at = now() where id = p_staff_id;
  end if;
end;
$$;

revoke all on function stf_record_alert_sent(text, uuid, uuid, text) from public;

-- Called by the Telegram webhook receiver when someone messages the bot
-- with a link code. Matches it to the admin who generated it, regardless of
-- company - only service_role should ever call this.
create or replace function stf_link_telegram(p_code text, p_chat_id text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  v_matched boolean := false;
begin
  update stf_profiles
  set telegram_chat_id = p_chat_id, telegram_link_code = null
  where telegram_link_code = upper(trim(p_code)) and role = 'admin';
  if found then v_matched := true; end if;
  return v_matched;
end;
$$;

revoke all on function stf_link_telegram(text, text) from public;
