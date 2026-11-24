-- ==========================================
-- STAFFTRACK (Kidhar) - one-time tasks, alongside (not instead of) the
-- existing recurring shift-window / rolling-idle alerting. A staff member
-- can have an ongoing recurring schedule AND occasionally get assigned a
-- one-off task with its own specific date/time deadline - independent of
-- each other.
--
-- Deliberately reuses the exact same "satisfied" signal the recurring
-- alerts already use (any check-in logged in the relevant window) rather
-- than adding a separate "mark task done" action - staff keep using the
-- one Check In button they already have, nothing new for them to learn.
-- ==========================================

create table if not exists stf_tasks (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references stf_profiles(id) on delete cascade,
  label text,
  due_at timestamptz not null,
  grace_minutes int not null default 10,
  created_at timestamptz not null default now(),
  alerted_at timestamptz
);

create index if not exists idx_stf_tasks_staff on stf_tasks(staff_id);

alter table stf_tasks enable row level security;

-- Admin can view (for the task list/assign UI) tasks belonging to their
-- own company's staff. No direct writes - only via the RPCs below.
create policy "tasks_admin_select" on stf_tasks for select
  using (exists (
    select 1 from stf_profiles p
    where p.id = stf_tasks.staff_id and p.company_id = stf_my_company_id()
  ) and stf_is_admin());

grant select on stf_tasks to authenticated;
revoke insert, update, delete on stf_tasks from authenticated, anon;

create or replace function stf_create_task(p_staff_id uuid, p_label text, p_due_at timestamptz, p_grace_minutes int)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not stf_is_admin() then raise exception 'Not authorized.'; end if;
  if not exists(select 1 from stf_profiles where id = p_staff_id and company_id = stf_my_company_id()) then
    raise exception 'Staff member not found in your company.';
  end if;
  if p_due_at is null then raise exception 'Due date/time is required.'; end if;

  insert into stf_tasks (staff_id, label, due_at, grace_minutes)
  values (p_staff_id, nullif(trim(coalesce(p_label, '')), ''), p_due_at, coalesce(p_grace_minutes, 10))
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function stf_create_task(uuid, text, timestamptz, int) from public;
grant execute on function stf_create_task(uuid, text, timestamptz, int) to authenticated;

create or replace function stf_delete_task(p_task_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not stf_is_admin() then raise exception 'Not authorized.'; end if;
  delete from stf_tasks
  where id = p_task_id
    and staff_id in (select id from stf_profiles where company_id = stf_my_company_id());
end;
$$;

revoke all on function stf_delete_task(uuid) from public;
grant execute on function stf_delete_task(uuid) to authenticated;

-- Tasks past their due_at + grace with no matching check-in, admin not
-- yet pinged. "Matching check-in" = any check-in between task creation
-- and the due+grace deadline, same loose definition the recurring shift
-- windows already use.
create or replace function stf_find_overdue_tasks()
returns table(task_id uuid, staff_name text, label text, due_at timestamptz, admin_chat_id text)
language sql security definer stable
set search_path = public
as $$
  select t.id, p.name, t.label, t.due_at, admin.telegram_chat_id
  from stf_tasks t
  join stf_profiles p on p.id = t.staff_id and p.active
  join stf_profiles admin on admin.company_id = p.company_id and admin.role = 'admin' and admin.active
  where t.alerted_at is null
    and now() > t.due_at + (t.grace_minutes || ' minutes')::interval
    and admin.telegram_chat_id is not null
    and not exists (
      select 1 from stf_checkins c
      where c.staff_id = t.staff_id
        and c.captured_at >= t.created_at
        and c.captured_at <= t.due_at + (t.grace_minutes || ' minutes')::interval
    );
$$;

revoke all on function stf_find_overdue_tasks() from public;

create or replace function stf_mark_task_alerted(p_task_id uuid)
returns void language sql security definer set search_path = public
as $$ update stf_tasks set alerted_at = now() where id = p_task_id; $$;

revoke all on function stf_mark_task_alerted(uuid) from public;
