# جریان زنده + تیک خوانده‌شدن
# این فایل را یک‌بار در Supabase → SQL Editor اجرا کنید.

-- ============================================================
-- ۱) ستون خوانده‌شدن پیام‌ها و ایندکس آن
-- ============================================================
alter table public.messages
  add column if not exists read_at timestamptz;

create index if not exists messages_unread_idx
  on public.messages (task_id, from_user_id)
  where read_at is null;

-- ============================================================
-- ۲) افزودن جدول‌ها به Publication مربوط به Realtime
-- (اگر از قبل عضو باشند، خطا نمی‌دهد)
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table public.tasks;
  end if;
end $$;

-- ============================================================
-- ۳) تغییر تصویر کامل رکورد (لازم برای رویداد UPDATE/DELETE
--    با فیلتر و بررسی RLS در Realtime)
-- ============================================================
alter table public.messages replica identity full;
alter table public.tasks replica identity full;

-- نکته: سیاست‌های RLS موجود روی messages و tasks همین‌جا اعمال می‌شوند؛
-- یعنی هر کاربر فقط رویداد پیام‌های موضوع‌هایی را می‌گیرد که اجازهٔ خواندنش را دارد.
-- اگر فایل security.sql را هم اجرا نکرده‌اید، آن را جداگانه اجرا کنید.
