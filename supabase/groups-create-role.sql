-- ایجاد گروه فقط برای مدیر سیستم، مدیر، رئیس و سرپرست
-- اجرا در Supabase → SQL Editor (یک‌بار). بعد از groups.sql.
--
-- چرا این فایل؟ گیت «ساخت گروه» در app.js فقط جلوی رابط کاربری را می‌گیرد؛
-- کارشناس می‌توانست با درخواست مستقیم به REST همان insert را انجام دهد.
-- این سیاست همان شرط را در دیتابیس اعمال می‌کند.

-- تابع امن (security definer) تا بررسی نقش به RLS جدول profiles وابسته نباشد
create or replace function public.can_create_group()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and coalesce(p.active, true)
      and (
        p.username = 'admin'
        or p.role in ('مدیر', 'رئیس', 'سرپرست')
      )
  );
$$;

revoke all on function public.can_create_group() from public;
grant execute on function public.can_create_group() to authenticated;

-- جایگزینی سیاست درج گروه با نسخهٔ نقش‌محور
drop policy if exists "groups_insert_self" on public.chat_groups;

create policy "groups_insert_privileged"
  on public.chat_groups for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.can_create_group()
  );

-- ============================================================
-- بررسی وضعیت پس از اجرا
-- ============================================================
-- select policyname, cmd, with_check
-- from pg_policies
-- where schemaname = 'public' and tablename = 'chat_groups';
-- باید سیاست groups_insert_privileged دیده شود و groups_insert_self نباشد.
