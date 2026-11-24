-- ==========================================
-- STAFFTRACK (Kidhar) - "task completed" closing-the-loop notification.
--
-- Previously: once a one-time task was alerted as missed, the admin had
-- no way to know when/whether the staff member eventually checked in -
-- they'd have to keep reopening the app to check. This adds a second,
-- one-time Telegram ping for exactly that case: task was alerted as
-- overdue, AND has since been satisfied by a check-in. Ordinary
-- on-time completions stay silent (no alert was ever raised, so there's
-- nothing to "resolve").
-- ==========================================

alter table stf_tasks add column if not exists resolved_notified_at timestamptz;

create or replace function stf_find_resolved_tasks()
returns table(task_id uuid, staff_name text, label text, due_at timestamptz, admin_chat_id text)
language sql security definer stable
set search_path = public
as $$
  select t.id, p.name, t.label, t.due_at, admin.telegram_chat_id
  from stf_tasks t
  join stf_profiles p on p.id = t.staff_id and p.active
  join stf_profiles admin on admin.company_id = p.company_id and admin.role = 'admin' and admin.active
  where t.alerted_at is not null
    and t.resolved_notified_at is null
    and admin.telegram_chat_id is not null
    and exists (
      select 1 from stf_checkins c
      where c.staff_id = t.staff_id
        and c.captured_at >= t.created_at
    );
$$;

revoke all on function stf_find_resolved_tasks() from public;

create or replace function stf_mark_task_resolved_notified(p_task_id uuid)
returns void language sql security definer set search_path = public
as $$ update stf_tasks set resolved_notified_at = now() where id = p_task_id; $$;

revoke all on function stf_mark_task_resolved_notified(uuid) from public;
