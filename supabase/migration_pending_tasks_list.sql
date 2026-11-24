-- ==========================================
-- STAFFTRACK (Kidhar) - admin-facing list of pending one-time tasks
-- (not the recurring shift/rolling schedules - those already show per
-- staff member). Lets the admin see at a glance, across the whole team,
-- which "reach by" tasks nobody has checked in for yet - without having
-- to open each staff member's task modal one by one.
--
-- "Pending" = no check-in logged yet in the task's valid window (same
-- satisfied-check stf_find_overdue_tasks already uses). Limited to the
-- last 2 days so long-abandoned tasks the admin never cleaned up don't
-- clutter this list forever - they're still visible/deletable from the
-- per-staff task modal.
-- ==========================================

create or replace function stf_list_pending_tasks()
returns table(task_id uuid, staff_id uuid, staff_name text, label text, due_at timestamptz, grace_minutes int, alerted_at timestamptz)
language plpgsql security definer stable
set search_path = public
as $$
begin
  if not stf_is_admin() then raise exception 'Not authorized.'; end if;

  return query
  select t.id, t.staff_id, p.name, t.label, t.due_at, t.grace_minutes, t.alerted_at
  from stf_tasks t
  join stf_profiles p on p.id = t.staff_id
  where p.company_id = stf_my_company_id()
    and t.due_at >= now() - interval '2 days'
    and not exists (
      select 1 from stf_checkins c
      where c.staff_id = t.staff_id
        and c.captured_at >= t.created_at
        and c.captured_at <= t.due_at + (t.grace_minutes || ' minutes')::interval
    )
  order by t.due_at;
end;
$$;

revoke all on function stf_list_pending_tasks() from public;
grant execute on function stf_list_pending_tasks() to authenticated;
