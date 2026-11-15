# تیک خوانده‌شدن پیام‌ها
# اجرا در Supabase → SQL Editor (یک‌بار)

alter table public.messages
  add column if not exists read_at timestamptz;

-- برای سریع‌شدن کوئری «پیام‌های خوانده‌نشده هر موضوع»
create index if not exists messages_unread_idx
  on public.messages (task_id, from_user_id)
  where read_at is null;

-- نکته: سیاست‌های فعلی جدول messages باید به طرفین موضوع اجازه update بدهند
-- (اپ از قبل هم ستون transcription را به‌روزرسانی می‌کند)، بنابراین
-- علامت‌زدن خوانده‌شده نیازی به سیاست جدید ندارد.
