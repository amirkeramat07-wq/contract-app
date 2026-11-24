# تضمین تحویل پیام و صف ارسال آفلاین
# اجرا در Supabase → SQL Editor (یک‌بار).

-- ============================================================
-- ۱) شناسهٔ یکتا برای هر پیام از سمت کلاینت
--    اگر شبکه قطع شود و اپ دوباره بفرستد، پیام دوبار ثبت نمی‌شود.
-- ============================================================
alter table public.messages
  add column if not exists client_id text;

create unique index if not exists messages_client_id_key
  on public.messages (task_id, client_id)
  where client_id is not null;

-- ============================================================
-- ۲) ایندکس شمارندهٔ خوانده‌نشدهٔ هر گفتگو
-- ============================================================
create index if not exists messages_unread_from_idx
  on public.messages (from_user_id)
  where read_at is null;

-- ============================================================
-- ۳) بررسی وضعیت
-- ============================================================
-- select count(*) filter (where client_id is not null) as with_client_id,
--        count(*) as total
-- from public.messages;
