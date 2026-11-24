-- ==========================================
-- STAFFTRACK (Kidhar) - admin-facing list of pending one-time tasks
-- (not the recurring shift/rolling schedules - those already show per
-- staff member). Lets the admin see at a glance, across the whole team,
-- which "reach by" tasks nobody has checked in for yet - without having
-- to open each staff member's task modal one by one.
--
-- "Pending" = staff hasn't checked in at all since the task was assigned,
-- at any point up to now - deliberately NOT capped at due_at+grace like
-- stf_find_overdue_tasks' alert-firing check is. That cap exists there so
-- the "you were missed" alert still fires right at the deadline instead
-- of waiting forever for a check-in that may never come; here, a LATE
-- check-in should still clear the task off this list (staff did
-- eventually reach, just late), rather than showing "Overdue" forever
-- even after they've tapped in.
--
-- Limited to the last 2 days so long-abandoned tasks the admin never
-- cleaned up don't clutter this list forever - they're still
-- visible/deletable from the per-staff task modal.
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
    )
  order by t.due_at;
end;
$$;

revoke all on function stf_list_pending_tasks() from public;
grant execute on function stf_list_pending_tasks() to authenticated;
