-- Run as postgres in Supabase SQL Editor after genie-access.sql,
-- genie-messenger-link.sql and genie-undo.sql.
-- Replace only <成員 uuid> (an existing active app_admins member) and
-- <非成員 uuid> (another Authentication user absent from app_admins).
-- If there is no second user, first create a test account in Authentication.
-- Run the entire DO statement. It creates its own test lead and disabled
-- membership. Every path raises an exception, so even selecting just the DO
-- statement cannot leave these writes behind. Expect GENIE_ACCESS_OK only
-- after all checks; GENIE_ACCESS_FAIL names the failing cell.
-- This checks SQL grants/RLS, not live publishable-key, email or bot delivery.
do $verify$
declare
  member_id uuid;
  outsider_id uuid;
  lead_id text;
  sender_id text;
  old_answers jsonb;
  updated_answers jsonb;
  stored_answers jsonb;
  n integer;
  cell text := 'preflight';
  case_label text;
  case_sql text;
  customer text;
  customer_phone text;
  member_messenger_user_id text;
  first_at timestamptz;
  result_at timestamptz;
  next_result_at timestamptz;
  saved_first_at timestamptz;
  undo_until timestamptz;
  saved_undo_until timestamptz;
  undo_result text;
  stored_result text;
  service_result_at timestamptz;
  service_first_at timestamptz;
  service_undo_until timestamptz;
  function_source text;
begin
  member_id := '<成員 uuid>'::uuid;
  outsider_id := '<非成員 uuid>'::uuid;
  select pg_catalog.left(pg_catalog.pg_get_functiondef(p.oid), 500)
    into function_source
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proname = 'set_customer_leads_updated_at'
     and p.pronargs = 0;
  if function_source is null then
    raise exception 'GENIE_ACCESS_FAIL: set_customer_leads_updated_at definition missing';
  end if;
  raise notice 'set_customer_leads_updated_at first 500 chars: %', function_source;

  if member_id = outsider_id
     or not exists (select 1 from public.app_admins
                     where user_id = member_id and active is true)
     or exists (select 1 from public.app_admins where user_id = outsider_id) then
    raise exception 'GENIE_ACCESS_FAIL: preflight member/outsider UUIDs';
  end if;

  cell := 'test lead INSERT';
  sender_id := 'genie-access-verify-' ||
    pg_catalog.md5(pg_catalog.clock_timestamp()::text || pg_catalog.random()::text);
  old_answers := pg_catalog.jsonb_build_object(
    'name', '權限測試', 'phone', '0900000000', 'area', '台北市',
    'service', '住宅設計', 'size', '20坪', 'budget', '測試',
    'timeline', '測試'
  );
  insert into public.customer_leads (
    source, status, messenger_user_id, answers, location, project_type,
    interior_area, budget_range, start_time, customer_name, phone,
    completed_at, notification_status, outcome_token_hash,
    outcome_token_expires_at
  ) values (
    'facebook', 'complete', sender_id, old_answers, '台北市', '住宅設計',
    '20坪', '測試', '測試', '權限測試', '0900000000',
    pg_catalog.clock_timestamp(), 'pending', 'genie-access-verify',
    pg_catalog.clock_timestamp() + interval '1 hour'
  ) returning id::text into lead_id;
  if lead_id is null then
    raise exception 'GENIE_ACCESS_FAIL: test lead INSERT returned no id';
  end if;

  -- Each role change starts from postgres. JWT claims simulate the API role.
  cell := 'switch to anon';
  execute 'reset role';
  execute 'set local role anon';
  perform pg_catalog.set_config('request.jwt.claims', '{}', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  if current_user <> 'anon' then
    raise exception 'GENIE_ACCESS_FAIL: switch to anon';
  end if;
  for case_label, case_sql in
    select v.label, v.stmt from (values
      ('anon SELECT customer_leads',
       'select id from public.customer_leads where id::text = $1'),
      ('anon UPDATE contact_result',
       'update public.customer_leads set contact_result = ''contacted'' where id::text = $1'),
      ('anon UPDATE phone',
       'update public.customer_leads set phone = phone where id::text = $1'),
      ('anon INSERT customer_leads',
       'insert into public.customer_leads default values'),
      ('anon INSERT lead_events',
       'insert into public.lead_events default values'),
      ('anon DELETE customer_leads',
       'delete from public.customer_leads where id::text = $1')
    ) as v(label, stmt)
  loop
    cell := case_label;
    begin
      execute case_sql using lead_id;
      raise exception 'GENIE_ACCESS_FAIL: % (expected 42501)', cell;
    exception when insufficient_privilege then
      raise notice '%: 42501', cell;
    end;
  end loop;

  cell := 'anon EXECUTE genie_undo_contact_result';
  begin
    execute 'select public.genie_undo_contact_result($1::uuid, $2, $3)'
      into undo_result using lead_id, 'contacted', pg_catalog.clock_timestamp();
    raise exception 'GENIE_ACCESS_FAIL: % (expected 42501)', cell;
  exception when insufficient_privilege then
    raise notice '%: 42501', cell;
  end;

  cell := 'switch to non-member';
  execute 'reset role';
  execute 'set local role postgres';
  execute 'set local role authenticated';
  perform pg_catalog.set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', outsider_id, 'role', 'authenticated')::text, true);
  perform pg_catalog.set_config('request.jwt.claim.sub', outsider_id::text, true);
  if current_user <> 'authenticated' then
    raise exception 'GENIE_ACCESS_FAIL: switch to non-member';
  end if;
  cell := 'non-member SELECT customer_leads';
  execute 'select count(*) from public.customer_leads where id::text = $1'
    into n using lead_id;
  if n <> 0 then raise exception 'GENIE_ACCESS_FAIL: non-member SELECT customer_leads (expected 0)'; end if;
  raise notice '%: 0 rows', cell;
  cell := 'non-member UPDATE contact_result';
  execute 'update public.customer_leads set contact_result = ''site_visit'' where id::text = $1'
    using lead_id;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'GENIE_ACCESS_FAIL: non-member UPDATE contact_result (expected 0)'; end if;
  raise notice '%: 0 rows', cell;
  cell := 'non-member EXECUTE genie_undo_contact_result';
  execute 'select public.genie_undo_contact_result($1::uuid, $2, $3)'
    into undo_result using lead_id, 'contacted', pg_catalog.clock_timestamp();
  if undo_result is distinct from 'forbidden' then
    raise exception 'GENIE_ACCESS_FAIL: non-member EXECUTE genie_undo_contact_result';
  end if;
  raise notice '%: forbidden', cell;
  for case_label, case_sql in
    select v.label, v.stmt from (values
      ('non-member UPDATE phone',
       'update public.customer_leads set phone = phone where id::text = $1'),
      ('non-member INSERT customer_leads',
       'insert into public.customer_leads default values'),
      ('non-member DELETE customer_leads',
       'delete from public.customer_leads where id::text = $1')
    ) as v(label, stmt)
  loop
    cell := case_label;
    begin
      execute case_sql using lead_id;
      raise exception 'GENIE_ACCESS_FAIL: % (expected 42501)', cell;
    exception when insufficient_privilege then
      raise notice '%: 42501', cell;
    end;
  end loop;

  -- Add a disabled membership for the formerly absent auth user. Never alter
  -- the real active member. The final exception rolls this INSERT back too.
  cell := 'disabled membership INSERT';
  execute 'reset role';
  execute 'set local role postgres';
  insert into public.app_admins (user_id, display_name, active)
  values (outsider_id, $name$權限測試停用成員$name$, false);
  cell := 'switch to disabled member';
  execute 'reset role';
  execute 'set local role authenticated';
  perform pg_catalog.set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', outsider_id, 'role', 'authenticated')::text, true);
  perform pg_catalog.set_config('request.jwt.claim.sub', outsider_id::text, true);
  if current_user <> 'authenticated' then
    raise exception 'GENIE_ACCESS_FAIL: switch to disabled member';
  end if;
  cell := 'disabled member SELECT customer_leads';
  execute 'select count(*) from public.customer_leads where id::text = $1'
    into n using lead_id;
  if n <> 0 then raise exception 'GENIE_ACCESS_FAIL: disabled member SELECT customer_leads (expected 0)'; end if;
  raise notice '%: 0 rows', cell;
  cell := 'disabled member UPDATE contact_result';
  execute 'update public.customer_leads set contact_result = ''site_visit'' where id::text = $1'
    using lead_id;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'GENIE_ACCESS_FAIL: disabled member UPDATE contact_result (expected 0)'; end if;
  raise notice '%: 0 rows', cell;
  cell := 'disabled member EXECUTE genie_undo_contact_result';
  execute 'select public.genie_undo_contact_result($1::uuid, $2, $3)'
    into undo_result using lead_id, 'contacted', pg_catalog.clock_timestamp();
  if undo_result is distinct from 'forbidden' then
    raise exception 'GENIE_ACCESS_FAIL: disabled member EXECUTE genie_undo_contact_result';
  end if;
  raise notice '%: forbidden', cell;

  cell := 'switch to active member';
  execute 'reset role';
  execute 'set local role postgres';
  execute 'set local role authenticated';
  perform pg_catalog.set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', member_id, 'role', 'authenticated')::text, true);
  perform pg_catalog.set_config('request.jwt.claim.sub', member_id::text, true);
  if current_user <> 'authenticated' then
    raise exception 'GENIE_ACCESS_FAIL: switch to active member';
  end if;
  cell := 'active member SELECT customer_name/phone';
  execute 'select customer_name, phone from public.customer_leads where id::text = $1'
    into customer, customer_phone using lead_id;
  if customer is distinct from '權限測試' or customer_phone is distinct from '0900000000' then
    raise exception 'GENIE_ACCESS_FAIL: active member SELECT customer_name/phone';
  end if;
  raise notice '%: correct test values', cell;
  cell := 'active member SELECT messenger_user_id';
  execute 'select messenger_user_id from public.customer_leads where id::text = $1'
    into member_messenger_user_id using lead_id;
  if member_messenger_user_id is distinct from sender_id then
    raise exception 'GENIE_ACCESS_FAIL: active member SELECT messenger_user_id (expected test lead value)';
  end if;
  raise notice '%: matches test lead value', cell;
  for case_label, case_sql in
    select v.label, v.stmt from (values
      ('active member SELECT outcome_token_hash',
       'select outcome_token_hash from public.customer_leads where id::text = $1')
    ) as v(label, stmt)
  loop
    cell := case_label;
    begin
      execute case_sql using lead_id;
      raise exception 'GENIE_ACCESS_FAIL: % (expected 42501)', cell;
    exception when insufficient_privilege then
      raise notice '%: 42501', cell;
    end;
  end loop;

  cell := 'active member first UPDATE contact_result/timestamps';
  execute 'update public.customer_leads set contact_result = ''site_visit''
           where id::text = $1
           returning contact_result_at, contact_first_at, contact_undo_until'
    into result_at, first_at, undo_until using lead_id;
  if not found or result_at is null or first_at is distinct from result_at
     or undo_until is distinct from result_at + interval '15 minutes' then
    raise exception 'GENIE_ACCESS_FAIL: active member first UPDATE contact_result/timestamps';
  end if;
  raise notice '%: both times filled, undo opens for 15 minutes', cell;

  cell := 'active member same-result UPDATE preserves all times';
  execute 'update public.customer_leads set contact_result = ''site_visit''
           where id::text = $1
           returning contact_result_at, contact_first_at, contact_undo_until'
    into next_result_at, saved_first_at, saved_undo_until using lead_id;
  if not found or next_result_at is distinct from result_at
     or saved_first_at is distinct from first_at
     or saved_undo_until is distinct from undo_until then
    raise exception 'GENIE_ACCESS_FAIL: active member same-result UPDATE preserves all times';
  end if;
  raise notice '%: all three times unchanged', cell;

  cell := 'active member undo correct expected values';
  execute 'select public.genie_undo_contact_result($1::uuid, $2, $3)'
    into undo_result using lead_id, 'site_visit', result_at;
  if undo_result is distinct from 'undone' then
    raise exception 'GENIE_ACCESS_FAIL: active member undo correct expected values';
  end if;
  execute 'select contact_result, contact_result_at, contact_first_at,
                  contact_undo_until
             from public.customer_leads where id::text = $1'
    into stored_result, result_at, first_at, undo_until using lead_id;
  if not found or stored_result is not null or result_at is not null
     or first_at is not null
     or undo_until is not null then
    raise exception 'GENIE_ACCESS_FAIL: active member undo did not clear all times';
  end if;
  raise notice '%: undone, all three times null', cell;

  cell := 'active member undo missing lead';
  execute 'select public.genie_undo_contact_result($1, $2, $3)'
    into undo_result using pg_catalog.gen_random_uuid(), 'site_visit', pg_catalog.clock_timestamp();
  if undo_result is distinct from 'not_found' then
    raise exception 'GENIE_ACCESS_FAIL: active member undo missing lead';
  end if;
  raise notice '%: not_found', cell;

  -- The successful RPC set a transaction-local flag. Clear it before testing
  -- whether an ordinary UPDATE can reset a result in this same DO statement.
  perform pg_catalog.set_config('genie.contact_undo', 'off', true);
  cell := 'active member first UPDATE after undo reopens window';
  execute 'update public.customer_leads set contact_result = ''site_visit''
           where id::text = $1
           returning contact_result_at, contact_first_at, contact_undo_until'
    into result_at, first_at, undo_until using lead_id;
  if not found or result_at is null or first_at is distinct from result_at
     or undo_until is distinct from result_at + interval '15 minutes' then
    raise exception 'GENIE_ACCESS_FAIL: active member first UPDATE after undo reopens window';
  end if;
  raise notice '%: new 15-minute window', cell;

  cell := 'postgres expire undo window';
  execute 'reset role';
  execute 'set local role postgres';
  -- The trigger deliberately restores time columns when the result is the
  -- same. Disable this user trigger only while arranging the expired fixture.
  execute 'alter table public.customer_leads disable trigger genie_contact_timestamps';
  execute 'update public.customer_leads
              set contact_undo_until = pg_catalog.now() - interval ''1 minute''
            where id::text = $1' using lead_id;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'GENIE_ACCESS_FAIL: postgres expire undo window'; end if;
  execute 'alter table public.customer_leads enable trigger genie_contact_timestamps';
  execute 'set local role authenticated';
  cell := 'active member undo expired by time';
  execute 'select public.genie_undo_contact_result($1::uuid, $2, $3)'
    into undo_result using lead_id, 'site_visit', result_at;
  if undo_result is distinct from 'expired' then
    raise exception 'GENIE_ACCESS_FAIL: active member undo expired by time';
  end if;
  raise notice '%: expired', cell;

  perform pg_catalog.pg_sleep(0.01);
  cell := 'active member second UPDATE preserves first timestamp';
  execute 'update public.customer_leads set contact_result = ''contacted''
           where id::text = $1
           returning contact_result_at, contact_first_at, contact_undo_until'
    into next_result_at, saved_first_at, saved_undo_until using lead_id;
  if not found or saved_first_at is distinct from first_at
     or next_result_at is null or next_result_at <= result_at
     or saved_undo_until is not null then
    raise exception 'GENIE_ACCESS_FAIL: active member second UPDATE preserves first timestamp';
  end if;
  raise notice '%: first unchanged, result time advanced, undo closed', cell;
  cell := 'active member undo after result change';
  execute 'select public.genie_undo_contact_result($1::uuid, $2, $3)'
    into undo_result using lead_id, 'contacted', next_result_at;
  if undo_result is distinct from 'expired' then
    raise exception 'GENIE_ACCESS_FAIL: active member undo after result change';
  end if;
  raise notice '%: expired', cell;
  cell := 'active member undo wrong expected result';
  execute 'select public.genie_undo_contact_result($1::uuid, $2, $3)'
    into undo_result using lead_id, 'site_visit', next_result_at;
  if undo_result is distinct from 'changed' then
    raise exception 'GENIE_ACCESS_FAIL: active member undo wrong expected result';
  end if;
  raise notice '%: changed', cell;
  cell := 'active member undo wrong expected time';
  execute 'select public.genie_undo_contact_result($1::uuid, $2, $3)'
    into undo_result using lead_id, 'contacted', result_at;
  if undo_result is distinct from 'changed' then
    raise exception 'GENIE_ACCESS_FAIL: active member undo wrong expected time';
  end if;
  raise notice '%: changed', cell;
  cell := 'active member reset contact_result to NULL';
  begin
    execute 'update public.customer_leads set contact_result = null where id::text = $1'
      using lead_id;
    raise exception 'GENIE_ACCESS_FAIL: % (expected 23514)', cell;
  exception when check_violation then
    raise notice '%: 23514', cell;
  end;
  for case_label, case_sql in
    select v.label, v.stmt from (values
      ('active member UPDATE phone',
       'update public.customer_leads set phone = phone where id::text = $1'),
      ('active member INSERT customer_leads',
       'insert into public.customer_leads default values'),
      ('active member UPDATE app_admins',
       'update public.app_admins set active = false where user_id = $2'),
      ('active member INSERT app_admins',
       'insert into public.app_admins (user_id, active) values ($2, true)')
    ) as v(label, stmt)
  loop
    cell := case_label;
    begin
      execute case_sql using lead_id, member_id;
      raise exception 'GENIE_ACCESS_FAIL: % (expected 42501)', cell;
    exception when insufficient_privilege then
      raise notice '%: 42501', cell;
    end;
  end loop;

  cell := 'switch to service_role';
  execute 'reset role';
  execute 'set local role postgres';
  execute 'set local role service_role';
  perform pg_catalog.set_config('request.jwt.claims',
    '{"role":"service_role"}', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
  if current_user <> 'service_role' then
    raise exception 'GENIE_ACCESS_FAIL: switch to service_role';
  end if;
  -- recordContactResult: same hash/expiry guards and two UPDATE shapes.
  cell := 'service_role recordContactResult first UPDATE';
  execute 'update public.customer_leads
              set contact_result = ''unreachable'', contact_result_at = $3
            where id::text = $1 and outcome_token_hash = $2
              and outcome_token_expires_at > $3
            returning contact_result_at, contact_first_at, contact_undo_until'
    into result_at, first_at, undo_until
    using lead_id, 'genie-access-verify', pg_catalog.clock_timestamp();
  if not found or result_at is null or first_at is distinct from saved_first_at
     or undo_until is not null then
    raise exception 'GENIE_ACCESS_FAIL: service_role recordContactResult first UPDATE';
  end if;
  service_result_at := result_at;
  service_first_at := first_at;
  service_undo_until := undo_until;
  raise notice '%: 1 row', cell;
  cell := 'service_role same-result replay preserves all times';
  execute 'update public.customer_leads
              set contact_result = ''unreachable'', contact_result_at = $2
            where id::text = $1
            returning contact_result_at, contact_first_at, contact_undo_until'
    into result_at, first_at, undo_until
    using lead_id, pg_catalog.clock_timestamp();
  if not found or result_at is distinct from service_result_at
     or first_at is distinct from service_first_at
     or undo_until is distinct from service_undo_until then
    raise exception 'GENIE_ACCESS_FAIL: service_role same-result replay preserves all times';
  end if;
  raise notice '%: all three times unchanged', cell;
  cell := 'service_role recordContactResult guarded second UPDATE';
  execute 'update public.customer_leads set contact_first_at = $3
            where id::text = $1 and outcome_token_hash = $2
              and outcome_token_expires_at > $3 and contact_first_at is null'
    using lead_id, 'genie-access-verify', pg_catalog.clock_timestamp();
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'GENIE_ACCESS_FAIL: service_role recordContactResult guarded second UPDATE (expected 0)';
  end if;
  raise notice '%: 0 rows, no error', cell;

  -- updateCustomerLead: compare-and-swap answers and sender, plus the
  -- notification_status guard. A failed state makes the reset observable.
  cell := 'service_role prepare notification reset';
  execute 'update public.customer_leads set notification_status = ''failed''
            where id::text = $1' using lead_id;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'GENIE_ACCESS_FAIL: service_role prepare notification reset'; end if;
  cell := 'service_role updateCustomerLead';
  updated_answers := pg_catalog.jsonb_set(
    old_answers, '{phone}', '"0900000001"'::jsonb);
  execute 'update public.customer_leads
              set answers = $3, location = ''台北市'', project_type = ''住宅設計'',
                  interior_area = ''20坪'', budget_range = ''測試'',
                  start_time = ''測試'', customer_name = ''權限測試'',
                  phone = ''0900000001'', notification_status = ''pending''
            where id::text = $1 and messenger_user_id = $2
              and answers = $4 and notification_status <> ''not_required''
            returning contact_result_at, contact_first_at, contact_undo_until'
    into result_at, first_at, undo_until
    using lead_id, sender_id, updated_answers, old_answers;
  if not found or result_at is distinct from service_result_at
     or first_at is distinct from service_first_at
     or undo_until is distinct from service_undo_until then
    raise exception 'GENIE_ACCESS_FAIL: service_role updateCustomerLead timestamps';
  end if;
  execute 'select phone, notification_status, answers
             from public.customer_leads where id::text = $1'
    into customer_phone, customer, stored_answers using lead_id;
  if customer_phone is distinct from '0900000001'
     or customer is distinct from 'pending'
     or stored_answers is distinct from updated_answers then
    raise exception 'GENIE_ACCESS_FAIL: service_role updateCustomerLead answers/phone/status';
  end if;
  raise notice 'service_role updateCustomerLead: 1 row, phone/answers/status changed';

  execute 'reset role';
  raise exception 'GENIE_ACCESS_OK: all checks passed (rolled back)';
exception when others then
  if sqlerrm like 'GENIE_ACCESS_OK:%' or sqlerrm like 'GENIE_ACCESS_FAIL:%' then
    raise;
  end if;
  raise exception 'GENIE_ACCESS_FAIL: % (SQLSTATE %, %)', cell, sqlstate, sqlerrm;
end;
$verify$;
