-- Minimal rollback of the contact timestamp automation only. Keep the access
-- fixes: no anon INSERT policy/grant, no authenticated table-level privileges,
-- and no restored messenger_sessions privileges. The bot and notify-lead use
-- service_role and are unaffected. Keep existing policies, columns and data.
begin;

drop trigger if exists genie_contact_timestamps on public.customer_leads;
drop function if exists public.genie_set_contact_timestamps();

-- Section 5.2 read columns; without the trigger the browser must write times.
-- This minimal rollback does not grant messenger_user_id automatically. To
-- revoke that column's access, run the revoke in genie-messenger-link.sql's header.
grant select (
  id, status, answers, customer_name, phone, project_type, location,
  interior_area, budget_range, start_time, completed_at, contact_result,
  contact_result_at, contact_first_at, lead_grade, notification_status
) on table public.customer_leads to authenticated;
grant update (contact_result, contact_result_at, contact_first_at)
  on table public.customer_leads to authenticated;

commit;

-- Optional v5.1-only rollback (do not run the minimal rollback above for this).
-- Copy the following block without the leading "-- " into SQL Editor. It drops
-- the undo RPC and restores the original genie-access.sql trigger behavior.
-- Keep contact_undo_until and its SELECT grant so existing data remains intact.
-- begin;
-- drop function if exists public.genie_undo_contact_result(uuid, text, timestamptz);
-- create or replace function public.genie_set_contact_timestamps()
-- returns trigger
-- language plpgsql
-- security invoker
-- set search_path = ''
-- as $function$
-- declare
--   changed_at timestamptz;
-- begin
--   if old.contact_result is not null and new.contact_result is null then
--     raise exception 'contact_result cannot be reset to null'
--       using errcode = '23514';
--   end if;
--   if new.contact_result is distinct from old.contact_result then
--     changed_at := pg_catalog.clock_timestamp();
--     new.contact_result_at := changed_at;
--     new.contact_first_at := coalesce(old.contact_first_at, changed_at);
--   end if;
--   return new;
-- end;
-- $function$;
-- notify pgrst, 'reload schema';
-- commit;
