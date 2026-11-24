# خطاهای زمان اجرای کلاینت
# اجرا در Supabase → SQL Editor (یک‌بار).

create table if not exists public.client_errors (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete set null,
  level text not null default 'error',
  message text not null,
  stack text,
  url text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists client_errors_created_idx on public.client_errors (created_at desc);

alter table public.client_errors enable row level security;

-- هیچ سیاستی ساخته نمی‌شود: نه خواندن و نه نوشتن از سمت کلاینت.
-- نوشتن فقط با کلید سرویس در api/client-log.js انجام می‌شود.
revoke all on table public.client_errors from anon, authenticated;
