import { FLOW, SUMMARY_LABELS } from "./flow.js";

// Both Messenger and the web form use QUESTIONS_PATH / config/questions.json.
export const FORM_FIELDS = FLOW.map(step => ({
  key: step.key,
  label: step.text,
  type: step.options ? "choice" : step.key === "phone" ? "tel" : "text",
  options: step.options?.map(([title]) => title),
  ...(step.otherPayload ? {
    otherKey: step.key + "_other",
    otherWhen: step.options.find(([, payload]) => payload === step.otherPayload)?.[0],
    otherLabel: step.otherPrompt,
  } : {}),
  validate: step.validate,
  errorText: step.errorText,
}));

export function buildFormSummary(answers) {
  return [
    "以下是您填寫的資料：",
    "",
    ...FORM_FIELDS.map(f => `${SUMMARY_LABELS[f.key]}：${f.otherWhen === answers[f.key] ? answers[f.otherKey] || "" : answers[f.key] || ""}`),
    "",
    "感謝您完成填寫，請保留此需求摘要。",
  ].join("\n");
}

export function normalizeAnswers(body) {
  const out = {};
  for (const f of FORM_FIELDS) {
    out[f.key] = typeof body[f.key] === "string" ? body[f.key].trim() : "";
    if (f.otherKey) {
      out[f.otherKey] =
        typeof body[f.otherKey] === "string" ? body[f.otherKey].trim() : "";
    }
  }
  return out;
}

export function validateAnswers(answers) {
  for (const f of FORM_FIELDS) {
    if (f.type === "choice" || f.type === "text" || f.type === "tel") {
      if (!answers[f.key]) return `${f.label}尚未填寫`;
    }
    if (f.otherWhen && answers[f.key] === f.otherWhen) {
      if (!answers[f.otherKey]) return f.otherLabel || "請補上其他資訊";
    }
    if (answers[f.key]?.length > 200 || (f.otherKey && answers[f.otherKey]?.length > 200)) return "輸入內容過長";
    if (f.options && !f.options.includes(answers[f.key])) return "請選擇有效的選項";
    if (f.validate && !f.validate(answers[f.key])) return f.errorText || "格式不正確";
    if (f.pattern) {
      const re = new RegExp(f.pattern);
      if (!re.test(answers[f.key])) {
        return "電話格式似乎不正確，請輸入 09 開頭的 10 碼手機號碼";
      }
    }
  }
  return null;
}
