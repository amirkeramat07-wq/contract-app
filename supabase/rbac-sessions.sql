# نقش‌ها، سلسله‌مراتب و بستن نشست‌ها
# اجرا در Supabase → SQL Editor (یک‌بار). این فایل سیاست‌های موجود را ضعیف نمی‌کند؛
# فقط یک سیاست «محدودکننده» (restrictive) اضافه می‌کند که روی همهٔ سیاست‌های فعلی سوار می‌شود.

-- ============================================================
-- ۱) مهر نشست: با هر تغییر رمز یا غیرفعال‌سازی، نشست‌های قبلی باطل می‌شوند
-- ============================================================
alter table public.profiles
  add column if not exists session_epoch timestamptz not null default now();

-- ============================================================
-- ۲) توابع کمکی
-- ============================================================

-- آیا کاربر جاری حساب فعالی دارد؟ (security definer تا RLS بازگشتی نگیرد)
create or replace function public.current_user_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.active from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

revoke all on function public.current_user_active() from public;
grant execute on function public.current_user_active() to authenticated;

-- نقش عددی برای مقایسه در سیاست‌ها
create or replace function public.role_rank(p_role text)
returns integer
language sql
immutable
as $$
  select case p_role
    when 'مدیر' then 4
    when 'رئیس' then 3
    when 'سرپرست' then 2
    when 'کارشناس' then 1
    else 0
  end;
$$;

revoke all on function public.role_rank(text) from public;
grant execute on function public.role_rank(text) to authenticated;

-- آیا کاربر جاری «مدیر سیستم» است؟ (نام کاربری admin و فعال)
create or replace function public.is_system_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.username = 'admin'
      and coalesce(p.active, true)
  );
$$;

revoke all on function public.is_system_admin() from public;
grant execute on function public.is_system_admin() to authenticated;

-- آیا کاربر جاری مدیر (مستقیم یا غیرمستقیم) کاربر هدف است؟
-- مدیران در ستون manager_id به‌صورت فهرست شناسه ذخیره می‌شوند.
create or replace function public.manages_user(p_target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive up as (
    select t.id, t.manager_id, 1 as depth
    from public.profiles t
    where t.id = p_target
    union all
    select p.id, p.manager_id, up.depth + 1
    from up
    join lateral (
      select trim(x)::uuid as mid
      from unnest(string_to_array(coalesce(up.manager_id, ''), ',')) as x
      where trim(x) <> ''
    ) m on true
    join public.profiles p on p.id = m.mid
    where up.depth < 6
  )
  select exists (
    select 1 from up where up.id <> p_target and up.id = auth.uid()
  );
$$;

revoke all on function public.manages_user(uuid) from public;
grant execute on function public.manages_user(uuid) to authenticated;

-- ============================================================
-- ۳) سیاست محدودکننده: حساب غیرفعال هیچ ردیفی نمی‌بیند
--    (به‌جای حذف/تغییر سیاست‌های فعلی؛ آن‌ها دست‌نخورده می‌مانند)
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['profiles', 'tasks', 'messages'] loop
    if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = t) then
      execute format('drop policy if exists %I on public.%I', 'require_active_account', t);
      execute format(
        'create policy %I on public.%I as restrictive for select to authenticated using (public.current_user_active())',
        'require_active_account', t
      );
    end if;
  end loop;
end $$;

-- ============================================================
-- ۴) بررسی وضعیت
-- ============================================================
-- select policyname, permissive, cmd from pg_policies
-- where schemaname='public' and tablename in ('profiles','tasks','messages')
-- order by tablename, permissive desc;
