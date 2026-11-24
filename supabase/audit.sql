# گزارش فعالیت (audit log)
# اجرا در Supabase → SQL Editor (یک‌بار). پیشنهاد می‌شود بعد از rbac-sessions.sql اجرا شود.

create table if not exists public.audit_log (
  id bigserial primary key,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_id uuid,
  details jsonb not null default '{}'::jsonb,
  ip text,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_created_idx on public.audit_log (created_at desc);
create index if not exists audit_log_target_idx on public.audit_log (target_id);

alter table public.audit_log enable row level security;

-- فقط مدیر سیستم می‌تواند بخواند؛ نوشتن تنها از سرور (کلید سرویس) انجام می‌شود.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'audit_log' and policyname = 'audit_admin_select'
  ) then
    create policy "audit_admin_select"
      on public.audit_log for select to authenticated
      using (public.is_system_admin());
  end if;
end $$;

revoke insert, update, delete on table public.audit_log from anon, authenticated;
grant select on table public.audit_log to authenticated;
