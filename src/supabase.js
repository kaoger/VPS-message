import { createClient } from "@supabase/supabase-js";
import { scoreLeadForStorage } from "./lead-score.js";

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

function leadScoreColumns(answers) {
  const { score, grade, reasons } = scoreLeadForStorage(answers);
  // Cleared rules leave old scores unchanged on UPDATE instead of clearing them to null.
  if (score === null) return {};
  return { lead_score: score, lead_grade: grade, lead_score_reasons: reasons };
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
    ...leadScoreColumns(answers),
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

/** Atomically reserve the single automatic invitation allowed per Messenger ID. */
export async function claimAutomaticInvite({ senderId, kind }) {
  const { error } = await getClient().from("bot_invite_registry").insert({
    messenger_user_id: senderId,
    invite_kind: kind,
  });
  if (error?.code === "23505") return false;
  if (error) throw error;
  return true;
}

/** Release the reservation if delivery fails so a later message can retry. */
export async function releaseAutomaticInvite({ senderId }) {
  const { error } = await getClient().from("bot_invite_registry")
    .delete().eq("messenger_user_id", senderId);
  if (error) throw error;
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
  // Preserve the original submission timestamp and other workflow fields.
  const changes = {
    answers,
    location: answers.area === "其他地區" ? answers.area_other : answers.area ?? null,
    project_type: answers.service ?? null,
    interior_area: answers.size ?? null,
    budget_range: answers.budget ?? null,
    start_time: answers.timeline ?? null,
    customer_name: answers.name ?? null,
    phone: answers.phone ?? null,
    ...leadScoreColumns(answers),
  };
  const match = (query) => query.eq("id", id).eq("messenger_user_id", senderId)
    .eq("answers", JSON.stringify(previousAnswers));

  const { data, error } = await match(getClient().from("customer_leads")
    .update({ ...changes, notification_status: "pending" }))
    .neq("notification_status", "not_required").select("id").maybeSingle();
  if (error) throw error;
  if (data?.id) return data;

  const { data: fallback, error: fallbackError } = await match(getClient()
    .from("customer_leads").update(changes)).select("id").maybeSingle();
  if (fallbackError) throw fallbackError;
  return fallback;
}

export function isSupabaseConfigured() {
  return Boolean(
    process.env.SUPABASE_URL && (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)
  );
}

/** Fill only the missing thread ID; preserve all workflow and notification fields. */
export async function setLeadThreadId(id, threadId) {
  if (typeof threadId !== "string" || !/^[0-9]{1,30}$/.test(threadId)) throw new Error("Invalid thread ID");
  const { error } = await getClient().from("customer_leads")
    .update({ messenger_thread_id: threadId }).eq("id", id).is("messenger_thread_id", null);
  if (error) throw error;
}

/** Keyset pagination stays stable while backfill removes rows from the missing-ID set. */
export async function listLeadsWithoutThreadId({ afterId = null, limit = 100 } = {}) {
  let query = getClient().from("customer_leads").select("id,messenger_user_id")
    .not("messenger_user_id", "is", null).neq("messenger_user_id", "")
    .is("messenger_thread_id", null).order("id", { ascending: true }).limit(limit);
  if (afterId) query = query.gt("id", afterId);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function readOutcomeToken(id) {
  const { data, error } = await getClient().from("customer_leads")
    .select("outcome_token_hash,outcome_token_expires_at")
    .eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function recordContactResult({ id, hash, result, now }) {
  const match = (query) => query.eq("id", id)
    .eq("outcome_token_hash", hash)
    .gt("outcome_token_expires_at", now);
  const { data, error } = await match(getClient().from("customer_leads")
    .update({ contact_result: result, contact_result_at: now }))
    .select("id").maybeSingle();
  if (error) throw error;
  if (!data?.id) return false;

  // This second guarded write only fills the first contact time once.
  // A failure here must not turn an already saved result into an error page.
  try {
    await match(getClient().from("customer_leads")
      .update({ contact_first_at: now }))
      .is("contact_first_at", null)
      .select("id").maybeSingle();
  } catch { /* The result above is already saved. */ }
  return true;
}
