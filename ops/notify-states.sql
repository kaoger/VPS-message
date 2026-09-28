-- 執行前可先跑以下預覽查詢，確認只會動到 notification_status 的 CHECK 約束：
-- select con.conname, pg_get_constraintdef(con.oid) as definition
-- from pg_constraint as con
-- where con.conrelid = 'public.customer_leads'::regclass
--   and con.contype = 'c'
-- order by con.conname;

begin;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint as con
    where con.conrelid = 'public.customer_leads'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%notification_status%'
  loop
    execute format('alter table public.customer_leads drop constraint %I', constraint_name);
  end loop;
end $$;

alter table public.customer_leads
  drop constraint if exists customer_leads_notification_status_check;

alter table public.customer_leads
  add constraint customer_leads_notification_status_check
  check (notification_status in ('pending', 'sending', 'sent', 'failed', 'not_required'));

alter table public.customer_leads
  add column if not exists notification_claimed_at timestamptz,
  add column if not exists notification_claim_id uuid;

commit;

notify pgrst, 'reload schema';
