# امنیت پوش و فایل‌های صوتی
# اجرا در Supabase → SQL Editor (یک‌بار)

-- ============================================================
-- ۱) جدول اشتراک‌های پوش: فقط صاحب ردیف دسترسی دارد
-- ============================================================
alter table public.push_subscriptions enable row level security;

revoke all on table public.push_subscriptions from anon;
revoke all on table public.push_subscriptions from authenticated;
grant select, insert, update, delete on table public.push_subscriptions to authenticated;

do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'push_subscriptions'
  loop
    execute format('drop policy %I on public.push_subscriptions', p.policyname);
  end loop;
end $$;

create policy "push_subscriptions_select_own"
  on public.push_subscriptions for select to authenticated
  using (auth.uid() = user_id);

create policy "push_subscriptions_insert_own"
  on public.push_subscriptions for insert to authenticated
  with check (auth.uid() = user_id);

create policy "push_subscriptions_update_own"
  on public.push_subscriptions for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "push_subscriptions_delete_own"
  on public.push_subscriptions for delete to authenticated
  using (auth.uid() = user_id);

-- اگر هنوز کلید یکتا روی user_id ندارید و جدول رکورد تکراری ندارد، این خط را فعال کنید
-- create unique index if not exists push_subscriptions_user_id_key
--   on public.push_subscriptions (user_id);

-- ============================================================
-- ۲) باکت پیام‌های صوتی: خصوصی + فقط کاربران لاگین‌کرده
-- کد اپ اکنون فقط مسیر فایل را ذخیره می‌کند و هنگام پخش
-- لینک امضاشده یک‌ساعته می‌سازد؛ فایل‌های قدیمی هم از همان
-- مسیر بازیابی می‌شوند، پس بعد از این تغییر از کار نمی‌افتند.
-- ============================================================
update storage.buckets set public = false where id = 'voice-messages';

drop policy if exists "voice_read_authenticated" on storage.objects;
drop policy if exists "voice_insert_authenticated" on storage.objects;

create policy "voice_read_authenticated"
  on storage.objects for select to authenticated
  using (bucket_id = 'voice-messages');

create policy "voice_insert_authenticated"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'voice-messages');
