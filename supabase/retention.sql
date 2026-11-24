# سیاست نگهداری داده و پاک‌سازی دوره‌ای
# اجرا در Supabase → SQL Editor (یک‌بار). پیشنهاد می‌شود بعد از audit.sql.
#
# نکتهٔ صادقانه: رمزنگاری سرتاسری (E2E) در این نسخه پیاده نشده است؛ چون بدون
# مدیریت کلید (و پشتیبان‌گیری/بازیابی رمز) پیام‌های کاربران برای همیشه از دست
# می‌رفت. آنچه این‌جا انجام می‌شود، طرف «سیاست نگهداری» است: حذف خودکار داده‌های
# کهنه، پاک‌سازی کش محلی هنگام خروج، و بستن دسترسی حساب غیرفعال.

create or replace function public.purge_old_messages(p_days integer default 365)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if not public.is_system_admin() then
    raise exception 'not_admin';
  end if;
  if p_days is null or p_days < 30 then
    raise exception 'retention_too_short';
  end if;

  delete from public.messages
   where created_at < now() - (p_days || ' days')::interval;

  get diagnostics n = row_count;

  insert into public.audit_log (actor_id, action, details)
  values (auth.uid(), 'purge_old_messages', jsonb_build_object('days', p_days, 'deleted', n));

  return n;
end;
$$;

revoke all on function public.purge_old_messages(integer) from public;
grant execute on function public.purge_old_messages(integer) to authenticated;

-- ============================================================
-- اجرای زمان‌بندی‌شده (اختیاری، روی pg_cron)
-- ============================================================
-- select cron.schedule('monthly-retention', '0 3 1 * *',
--   $$select public.purge_old_messages(365)$$);
--
-- نکته: صداهای قدیمی در باکت voice-messages جدا پاک‌سازی می‌شوند؛ فایل‌های
-- بدون پیام متناظر را می‌توانید دوره‌ای حذف کنید.
