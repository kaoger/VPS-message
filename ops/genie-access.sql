-- Genie-Local v5 Step A. Prerequisite: ops/contact-result.sql has already run,
-- so contact_result, contact_result_at, contact_first_at and outcome_token_hash exist.
-- Run as the database owner in Supabase SQL Editor; do not run from the browser.
-- A unique user_id index supports ON CONFLICT in genie-add-member.sql. If
-- user_id is already a primary key, the extra index is redundant but harmless.
begin;

alter table public.app_admins
  add column if not exists display_name text,
  add column if not exists active boolean not null default true;
alter table public.app_admins enable row level security;
alter table public.customer_leads enable row level security;
create unique index if not exists app_admins_user_id_key
  on public.app_admins (user_id);

-- Existing app_admins self-read policy stays in place. There is no browser write policy.
revoke insert, update, delete, truncate, references, trigger
  on table public.app_admins from public, anon, authenticated;
grant select (display_name, active) on table public.app_admins to authenticated;
drop policy if exists customer_leads_anon_insert on public.customer_leads;
drop policy if exists lead_events_anon_insert on public.lead_events;
revoke insert on table public.lead_events from public, anon;
revoke references, trigger, truncate on table public.messenger_sessions
  from public, anon, authenticated;

-- Table REVOKE does not remove older column grants. Clear both levels so internal
-- fields such as outcome_token_hash cannot remain readable through an old grant.
revoke all on table public.customer_leads from public, anon, authenticated;
grant all on table public.customer_leads to service_role;
do $revoke_columns$
declare
  columns_sql text;
begin
  select pg_catalog.string_agg(pg_catalog.format('%I', a.attname), ', ' order by a.attnum)
    into columns_sql
    from pg_catalog.pg_attribute as a
   where a.attrelid = 'public.customer_leads'::pg_catalog.regclass
     and a.attnum > 0 and not a.attisdropped;
  execute pg_catalog.format(
    'revoke select (%1$s), insert (%1$s), update (%1$s), references (%1$s) '
    || 'on table public.customer_leads from public, anon, authenticated',
    columns_sql
  );
end;
$revoke_columns$;

grant select (
  id, status, answers, customer_name, phone, project_type, location,
  interior_area, budget_range, start_time, completed_at, contact_result,
  contact_result_at, contact_first_at, lead_grade, notification_status
) on table public.customer_leads to authenticated;
grant update (contact_result) on table public.customer_leads to authenticated;

drop policy if exists customer_leads_admin_insert on public.customer_leads;
drop policy if exists customer_leads_admin_select on public.customer_leads;
create policy customer_leads_admin_select on public.customer_leads
  for select to authenticated
  using (exists (
    select 1 from public.app_admins as admin
     where admin.user_id = (select auth.uid()) and admin.active is true
  ));

drop policy if exists customer_leads_admin_update on public.customer_leads;
create policy customer_leads_admin_update on public.customer_leads
  for update to authenticated
  using (exists (
    select 1 from public.app_admins as admin
     where admin.user_id = (select auth.uid()) and admin.active is true
  ))
  with check (exists (
    select 1 from public.app_admins as admin
     where admin.user_id = (select auth.uid()) and admin.active is true
  ));

create or replace function public.genie_set_contact_timestamps()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  changed_at timestamptz;
begin
  if old.contact_result is not null and new.contact_result is null then
    raise exception 'contact_result cannot be reset to null'
      using errcode = '23514';
  end if;
  if new.contact_result is distinct from old.contact_result then
    changed_at := pg_catalog.clock_timestamp();
    new.contact_result_at := changed_at;
    new.contact_first_at := coalesce(old.contact_first_at, changed_at);
  end if;
  return new;
end;
$function$;

drop trigger if exists genie_contact_timestamps on public.customer_leads;
create trigger genie_contact_timestamps
  before update on public.customer_leads
  for each row execute function public.genie_set_contact_timestamps();

-- The explicit service_role grant keeps the VPS bot's reads and writes available.
notify pgrst, 'reload schema';
commit;
