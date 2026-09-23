import crypto from "node:crypto";
import { createCustomerLead, readCustomerLead, updateCustomerLead, isSupabaseConfigured } from "./supabase.js";
import { signFormToken } from "./form-token.js";

const memory = new Map();
const TTL = 2 * 60 * 60 * 1000;
setInterval(() => {
  for (const [id, row] of memory) if (row.expires <= Date.now()) memory.delete(id);
}, 60_000).unref();

function version(answers) {
  return crypto.createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(answers).sort(([a], [b]) => a.localeCompare(b))))).digest("hex");
}
export function editToken(psid, row) {
  return signFormToken(psid, TTL / 1000, { id: String(row.id), storage: row.storage, version: version(row.answers) });
}
export async function loadLead(psid, edit = null) {
  if (edit?.storage === "memory" || (!edit && !isSupabaseConfigured())) {
    const rows = [...memory.values()].filter(r => r.senderId === psid && r.expires > Date.now());
    return edit ? rows.find(r => r.id === edit.id) || null : rows.at(-1) || null;
  }
  if (!isSupabaseConfigured()) throw new Error("Database unavailable");
  const row = await readCustomerLead({ senderId: psid, id: edit?.id });
  return row ? { ...row, storage: "db" } : null;
}
export async function saveLead(psid, answers, edit = null) {
  // An opaque revision inside the existing answers JSON also invalidates old
  // forms when the customer submits identical values or later reverts a change.
  const savedAnswers = { ...answers, _revision: crypto.randomUUID() };
  if (edit) {
    const previous = await loadLead(psid, edit);
    if (!previous || version(previous.answers) !== edit.version) return null;
    if (edit.storage === "db") {
      const updated = await updateCustomerLead({ senderId: psid, id: edit.id, previousAnswers: previous.answers, answers: savedAnswers });
      return updated ? { ...updated, answers: savedAnswers, storage: "db" } : null;
    }
    // No await between checking the current revision and replacing memory state.
    const current = memory.get(edit.id);
    if (!current || version(current.answers) !== edit.version) return null;
    const row = { ...current, answers: savedAnswers, expires: Date.now() + TTL };
    memory.set(row.id, row);
    return row;
  }
  if (isSupabaseConfigured()) {
    const row = await createCustomerLead({ senderId: psid, answers: savedAnswers });
    return { ...row, answers: savedAnswers, storage: "db" };
  }
  const row = { id: crypto.randomUUID(), senderId: psid, answers: savedAnswers, storage: "memory", expires: Date.now() + TTL };
  memory.set(row.id, row);
  return row;
}

export function isCurrentVersion(row, edit) {
  return row && version(row.answers) === edit.version;
}
