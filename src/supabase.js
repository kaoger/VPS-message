import { createClient } from "@supabase/supabase-js";

let client = null;

function getClient() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment"
    );
  }

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/**
 * One INSERT into customer_leads when user taps 確認送出.
 * Do not call per question.
 */
export async function createCustomerLead({ senderId, answers }) {
  const supabase = getClient();

  const row = {
    source: "facebook",
    status: "complete",
    messenger_user_id: senderId,
    answers,
    location: answers.area ?? null,
    project_type: answers.service ?? null,
    interior_area: answers.size ?? null,
    budget_range: answers.budget ?? null,
    start_time: answers.timeline ?? null,
    customer_name: answers.name ?? null,
    phone: answers.phone ?? null,
    completed_at: new Date().toISOString(),
    notification_status: "pending",
  };

  const { data, error } = await supabase
    .from("customer_leads")
    .insert(row)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return data;
}

export function isSupabaseConfigured() {
  return Boolean(
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}
