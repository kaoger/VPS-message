-- Minimal rollback of the contact timestamp automation only. Keep the access
-- fixes: no anon INSERT policy/grant, no authenticated table-level privileges,
-- and no restored messenger_sessions privileges. The bot and notify-lead use
-- service_role and are unaffected. Keep existing policies, columns and data.
begin;

drop trigger if exists genie_contact_timestamps on public.customer_leads;
drop function if exists public.genie_set_contact_timestamps();

-- Section 5.2 read columns; without the trigger the browser must write times.
grant select (
  id, status, answers, customer_name, phone, project_type, location,
  interior_area, budget_range, start_time, completed_at, contact_result,
  contact_result_at, contact_first_at, lead_grade, notification_status
) on table public.customer_leads to authenticated;
grant update (contact_result, contact_result_at, contact_first_at)
  on table public.customer_leads to authenticated;

commit;
