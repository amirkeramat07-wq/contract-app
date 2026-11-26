# شمارش تلاش‌های ورود و «آخرین ورود»
# اجرا در Supabase → SQL Editor (یک‌بار). بعد از security.sql.
#
# چرا جدول؟ ورود حالا روی سرور (/api/login) انجام می‌شود؛ برای قفل موقت حساب
# پس از چند رمز اشتباه، باید تلاش‌ها جایی ثبت شوند. اگر این فایل اجرا نشود،
# ورود همچنان کار می‌کند ولی شمارش و قفل موقت غیرفعال می‌ماند (سرور این حالت
# را تشخیص می‌دهد و خطا نمی‌دهد).

create table if not exists public.login_attempts (
  id bigserial primary key,
  username text not null,
  ip text,
  succeeded boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists login_attempts_username_idx
  on public.login_attempts (username, created_at desc);

-- فقط سرور (کلید سرویس، که RLS را دور می‌زند) به این جدول دسترسی دارد.
-- هیچ سیاستی برای anon/authenticated ساخته نمی‌شود: کاربران نمی‌توانند
-- تلاش‌های دیگران را بخوانند یا شمارندهٔ خودشان را پاک کنند.
alter table public.login_attempts enable row level security;
revoke all on table public.login_attempts from anon, authenticated;

-- «آخرین ورود موفق» روی پروفایل؛ کنار last_seen که حضور را نشان می‌دهد.
alter table public.profiles add column if not exists last_login_at timestamptz;

-- پاک‌سازی دوره‌ای (اختیاری): نگه‌داشتن تاریخچهٔ تلاش‌ها ۹۰ روز
-- delete from public.login_attempts where created_at < now() - interval '90 days';
