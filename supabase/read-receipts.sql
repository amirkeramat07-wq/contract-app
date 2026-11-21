# تیک خوانده‌شدن (نسخهٔ بدون نیاز به سیاست UPDATE روی جدول)
# اجرا در Supabase → SQL Editor (یک‌بار). اگر قبلاً realtime.sql را اجرا کرده‌اید،
# فقط همین فایل را اجرا کنید.

-- ============================================================
-- ۱) ستون و ایندکس (اگر نبود)
-- ============================================================
alter table public.messages
  add column if not exists read_at timestamptz;

create index if not exists messages_unread_idx
  on public.messages (task_id, from_user_id)
  where read_at is null;

-- ============================================================
-- ۲) تابع امن علامت‌زدن خوانده‌شده
--    فقط طرفین موضوع می‌توانند پیام‌های همان موضوع را «خوانده» کنند،
--    و تنها ستونی که تغییر می‌کند read_at است (متن پیام دست‌نخورده می‌ماند).
-- ============================================================
create or replace function public.mark_task_read(p_task_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  if not exists (
    select 1
    from public.tasks t
    where t.id = p_task_id
      and (t.from_user_id = auth.uid() or t.to_user_id = auth.uid())
  ) then
    raise exception 'not_a_participant';
  end if;

  update public.messages
     set read_at = now()
   where task_id = p_task_id
     and from_user_id <> auth.uid()
     and read_at is null;

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.mark_task_read(uuid) from public;
revoke all on function public.mark_task_read(uuid) from anon;
grant execute on function public.mark_task_read(uuid) to authenticated;

-- ============================================================
-- ۳) بررسی وضعیت (برای عیب‌یابی؛ اجرای این بخش اختیاری است)
-- ============================================================
-- select count(*) as total,
--        count(read_at) as read_ok
-- from public.messages;
--
-- select policyname, cmd, qual, with_check
-- from pg_policies
-- where schemaname = 'public' and tablename = 'messages';
