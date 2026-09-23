import { createClient } from "@supabase/supabase-js";

let client = null;

function getClient() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or server-side Supabase key in environment"
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
    location: answers.area === "其他地區" ? answers.area_other : answers.area ?? null,
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
  if (!data?.id) throw new Error("Insert returned no lead");
  return data;
}

export async function readCustomerLead({ senderId, id }) {
  let query = getClient().from("customer_leads").select("id,answers")
    .eq("messenger_user_id", senderId);
  query = id ? query.eq("id", id) : query.order("completed_at", { ascending: false }).limit(1);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data;
}

export async function updateCustomerLead({ senderId, id, previousAnswers, answers }) {
  // Compare-and-swap protects against stale forms, even across server restarts.
  // Never reset workflow status or the original submission timestamp.
  const { data, error } = await getClient().from("customer_leads").update({
    answers,
    location: answers.area === "其他地區" ? answers.area_other : answers.area ?? null,
    project_type: answers.service ?? null,
    interior_area: answers.size ?? null,
    budget_range: answers.budget ?? null,
    start_time: answers.timeline ?? null,
    customer_name: answers.name ?? null,
    phone: answers.phone ?? null,
    notification_status: "pending",
  }).eq("id", id).eq("messenger_user_id", senderId)
    .eq("answers", JSON.stringify(previousAnswers)).select("id").maybeSingle();
  if (error) throw error;
  return data;
}

export function isSupabaseConfigured() {
  return Boolean(
    process.env.SUPABASE_URL && (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)
  );
}
