-- Run once in the Supabase SQL Editor before deploying this Bot change.
-- Keeps only the Messenger ID and whether the one automatic invitation was generic/service.
-- Also verify that the project's Data API exposes the public schema; exposure is
-- separate from SQL grants and may be disabled for newly created tables/projects.
create table if not exists public.bot_invite_registry (
  messenger_user_id text primary key,
  invite_kind text not null check (invite_kind in ('generic', 'service')),
  invited_at timestamptz not null default now()
);

alter table public.bot_invite_registry enable row level security;
revoke all on table public.bot_invite_registry from public, anon, authenticated;
grant insert, delete on table public.bot_invite_registry to service_role;
