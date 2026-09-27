alter table public.customer_leads
  add column if not exists lead_score integer,
  add column if not exists lead_grade text check (lead_grade in ('hot','normal','low')),
  add column if not exists lead_score_reasons text[];
notify pgrst, 'reload schema';
