-- Genie-Local v5.1 contact-result undo. Run after ops/genie-access.sql.
-- The column is retained by the optional rollback in genie-access-rollback.sql.
begin;

alter table public.customer_leads
  add column if not exists contact_undo_until timestamptz;
grant select (contact_undo_until) on table public.customer_leads to authenticated;

create or replace function public.genie_set_contact_timestamps()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  changed_at timestamptz;
begin
  if new.contact_result is not distinct from old.contact_result then
    new.contact_result_at := old.contact_result_at;
    new.contact_first_at := old.contact_first_at;
    new.contact_undo_until := old.contact_undo_until;
  elsif old.contact_result is null then
    changed_at := pg_catalog.clock_timestamp();
    new.contact_result_at := changed_at;
    new.contact_first_at := coalesce(old.contact_first_at, changed_at);
    if old.contact_first_at is null then
      new.contact_undo_until := changed_at + interval '15 minutes';
    else
      new.contact_undo_until := null;
    end if;
  elsif new.contact_result is null then
    if pg_catalog.current_setting('genie.contact_undo', true) = 'on' then
      new.contact_result_at := null;
      new.contact_first_at := null;
      new.contact_undo_until := null;
    else
      raise exception 'contact_result cannot be reset to null'
        using errcode = '23514';
    end if;
  else
    new.contact_result_at := pg_catalog.clock_timestamp();
    new.contact_first_at := old.contact_first_at;
    new.contact_undo_until := null;
  end if;
  return new;
end;
$function$;

create or replace function public.genie_undo_contact_result(
  p_id uuid, p_expected_result text, p_expected_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  lead public.customer_leads%rowtype;
begin
  if not exists (
    select 1 from public.app_admins as admin
     where admin.user_id = auth.uid() and admin.active is true
  ) then
    return 'forbidden';
  end if;

  select * into lead
    from public.customer_leads
   where id = p_id
   for update;
  if not found then
    return 'not_found';
  end if;
  if lead.contact_result is distinct from p_expected_result
     or lead.contact_result_at is distinct from p_expected_at then
    return 'changed';
  end if;
  if lead.contact_undo_until is null
     or lead.contact_undo_until <= pg_catalog.now() then
    return 'expired';
  end if;

  perform pg_catalog.set_config('genie.contact_undo', 'on', true);
  update public.customer_leads set contact_result = null where id = p_id;
  return 'undone';
end;
$function$;

revoke all on function public.genie_undo_contact_result(uuid, text, timestamptz)
  from public, anon;
grant execute on function public.genie_undo_contact_result(uuid, text, timestamptz)
  to authenticated;

notify pgrst, 'reload schema';
commit;
