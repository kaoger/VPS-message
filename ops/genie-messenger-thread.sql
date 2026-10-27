-- Run as database owner after genie-access.sql; no changes to RLS or workflow fields.
begin;

alter table public.customer_leads
  add column if not exists messenger_thread_id text;

do $constraint$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.customer_leads'::pg_catalog.regclass
      and conname = 'customer_leads_messenger_thread_id_check'
  ) then
    alter table public.customer_leads
      add constraint customer_leads_messenger_thread_id_check
      check (messenger_thread_id is null or messenger_thread_id ~ '^[0-9]{1,30}$');
  end if;
end;
$constraint$;

grant select (messenger_thread_id) on table public.customer_leads to authenticated;
notify pgrst, 'reload schema';

commit;
