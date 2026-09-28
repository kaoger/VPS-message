alter table public.customer_leads
  add column if not exists contact_result text
    check (contact_result in ('contacted', 'site_visit', 'not_interested', 'unreachable')),
  add column if not exists contact_result_at timestamptz,
  add column if not exists contact_first_at timestamptz,
  add column if not exists outcome_token_hash text,
  add column if not exists outcome_token_expires_at timestamptz;

notify pgrst, 'reload schema';
