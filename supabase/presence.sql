# حضور و «آخرین بازدید»
# اجرا در Supabase → SQL Editor (یک‌بار)

-- اگر سیاست UPDATE جدول profiles اجازهٔ آپدیت ندهد، آپدیت‌های last_seen
-- بی‌صدا صفر ردیف می‌شوند و «آخرین بازدید» قدیمی می‌ماند.
-- این تابع فقط last_seen کاربر جاری را به‌روز می‌کند.
create or replace function public.touch_last_seen()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;

  update public.profiles
     set last_seen = now()
   where id = auth.uid();
end;
$$;

revoke all on function public.touch_last_seen() from public;
revoke all on function public.touch_last_seen() from anon;
grant execute on function public.touch_last_seen() to authenticated;
