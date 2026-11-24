# گروه‌های گفتگو
# اجرا در Supabase → SQL Editor (یک‌بار). پیشنهاد می‌شود بعد از rbac-sessions.sql.

-- ============================================================
-- ۱) جدول‌ها
-- ============================================================
create table if not exists public.chat_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.chat_group_members (
  group_id uuid not null references public.chat_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.chat_group_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.chat_groups(id) on delete cascade,
  from_user_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 4000),
  client_id text,
  created_at timestamptz not null default now()
);

create index if not exists chat_group_messages_group_idx
  on public.chat_group_messages (group_id, created_at desc);
create index if not exists chat_group_members_user_idx
  on public.chat_group_members (user_id);

-- ============================================================
-- ۲) عضویت (تابع امن تا سیاست‌ها بازگشتی نشوند)
-- ============================================================
create or replace function public.is_group_member(p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.chat_group_members m
    where m.group_id = p_group and m.user_id = auth.uid()
  );
$$;

revoke all on function public.is_group_member(uuid) from public;
grant execute on function public.is_group_member(uuid) to authenticated;

-- ============================================================
-- ۳) RLS
-- ============================================================
alter table public.chat_groups enable row level security;
alter table public.chat_group_members enable row level security;
alter table public.chat_group_messages enable row level security;

grant select, insert, update, delete on table public.chat_groups to authenticated;
grant select, insert, delete on table public.chat_group_members to authenticated;
grant select, insert on table public.chat_group_messages to authenticated;

do $$
declare p record;
begin
  for p in
    select policyname, tablename from pg_policies
    where schemaname = 'public'
      and tablename in ('chat_groups', 'chat_group_members', 'chat_group_messages')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- گروه‌ها: اعضا می‌بینند، سازنده می‌سازد و تغییر می‌دهد
create policy "groups_select_member"
  on public.chat_groups for select to authenticated
  using (public.is_group_member(id) or created_by = auth.uid());

create policy "groups_insert_self"
  on public.chat_groups for insert to authenticated
  with check (created_by = auth.uid());

create policy "groups_update_creator"
  on public.chat_groups for update to authenticated
  using (created_by = auth.uid())
  with check (created_by = auth.uid());

create policy "groups_delete_creator"
  on public.chat_groups for delete to authenticated
  using (created_by = auth.uid());

-- اعضا: هر عضو فهرست اعضای گروه‌های خودش را می‌بیند
create policy "group_members_select_member"
  on public.chat_group_members for select to authenticated
  using (public.is_group_member(group_id) or user_id = auth.uid());

create policy "group_members_insert_creator_or_member"
  on public.chat_group_members for insert to authenticated
  with check (
    user_id = auth.uid()
    or public.is_group_member(group_id)
    or exists (
      select 1 from public.chat_groups g
      where g.id = group_id and g.created_by = auth.uid()
    )
  );

create policy "group_members_delete_self_or_creator"
  on public.chat_group_members for delete to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.chat_groups g
      where g.id = group_id and g.created_by = auth.uid()
    )
  );

-- پیام‌ها: فقط اعضا می‌خوانند و فقط به نام خودشان می‌نویسند
create policy "group_messages_select_member"
  on public.chat_group_messages for select to authenticated
  using (public.is_group_member(group_id));

create policy "group_messages_insert_member"
  on public.chat_group_messages for insert to authenticated
  with check (public.is_group_member(group_id) and from_user_id = auth.uid());

-- ============================================================
-- ۴) استریم زنده
-- ============================================================
alter table public.chat_group_messages replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'chat_group_messages'
  ) then
    alter publication supabase_realtime add table public.chat_group_messages;
  end if;
end $$;
