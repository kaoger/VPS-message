-- Read-only verification. Any unexpected privilege or schema shape fails closed.
do $verify$
declare
  column_number smallint;
begin
  select attnum into column_number from pg_catalog.pg_attribute
  where attrelid = 'public.customer_leads'::pg_catalog.regclass
    and attname = 'messenger_thread_id' and not attisdropped
    and atttypid = 'text'::pg_catalog.regtype and not attnotnull;
  if column_number is null then raise exception 'THREAD_COLUMN_FAIL: column'; end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.customer_leads'::pg_catalog.regclass
      and conname = 'customer_leads_messenger_thread_id_check'
      and contype = 'c' and convalidated and column_number = any(conkey)
      and pg_catalog.pg_get_constraintdef(oid) like '%^[0-9]{1,30}$%'
  ) then raise exception 'THREAD_COLUMN_FAIL: constraint'; end if;

  if pg_catalog.has_column_privilege('anon', 'public.customer_leads', 'messenger_thread_id', 'SELECT')
     or not pg_catalog.has_column_privilege('authenticated', 'public.customer_leads', 'messenger_thread_id', 'SELECT')
     or pg_catalog.has_column_privilege('authenticated', 'public.customer_leads', 'messenger_thread_id', 'UPDATE') then
    raise exception 'THREAD_COLUMN_FAIL: privileges';
  end if;
end;
$verify$;

select 'THREAD_COLUMN_OK' as result,
  pg_catalog.has_column_privilege('anon', 'public.customer_leads', 'messenger_thread_id', 'SELECT') as anon_select,
  pg_catalog.has_column_privilege('authenticated', 'public.customer_leads', 'messenger_thread_id', 'SELECT') as authenticated_select,
  pg_catalog.has_column_privilege('authenticated', 'public.customer_leads', 'messenger_thread_id', 'UPDATE') as authenticated_update;
