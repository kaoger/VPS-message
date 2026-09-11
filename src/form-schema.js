/**
 * Demo web form field definitions (same 8 topics as Messenger flow).
 */
export const FORM_FIELDS = [
  {
    key: "service",
    label: "請問您需要哪一類服務？",
    type: "choice",
    options: ["新成屋裝潢", "舊屋翻新", "局部裝修", "商業空間", "其他服務"],
  },
  {
    key: "area",
    label: "請問您需要的服務地區是？",
    type: "choice",
    options: ["高雄市", "台南", "嘉義", "台中", "彰化", "雲林", "其他地區"],
    otherKey: "area_other",
    otherWhen: "其他地區",
    otherLabel: "請輸入地區名稱",
  },
  {
    key: "size",
    label: "請問您預計裝修的坪數大約是多少？",
    type: "choice",
    options: ["20 坪以下", "21–30 坪", "31–40 坪", "41–60 坪", "61 坪以上", "尚未確定"],
  },
  {
    key: "timeline",
    label: "請問您預計何時開始進行裝修？",
    type: "choice",
    options: ["一個月內", "1–3 個月", "3–6 個月", "半年以上", "尚未確定"],
  },
  {
    key: "budget",
    label: "請問您的預算範圍大約是？",
    type: "choice",
    options: ["50 萬以下", "50–100 萬", "100–200 萬", "200–300 萬", "300 萬以上", "尚未確定"],
  },
  {
    key: "name",
    label: "請留下您的姓名，方便我們稱呼您",
    type: "text",
    placeholder: "例如：王先生",
  },
  {
    key: "phone",
    label: "請留下聯絡電話（09 開頭 10 碼）",
    type: "tel",
    placeholder: "0912345678",
    pattern: "^09\\d{8}$",
  },
  {
    key: "contact_time",
    label: "請問方便聯絡時間？",
    type: "choice",
    options: ["上午 8–12 點", "下午 1–5 點", "晚上 6–9 點"],
  },
];

export function buildFormSummary(answers) {
  const area =
    answers.area === "其他地區" && answers.area_other
      ? answers.area_other
      : answers.area;
  return [
    "以下是您填寫的資料：",
    "",
    `服務類型：${answers.service || ""}`,
    `服務地區：${area || ""}`,
    `預計坪數：${answers.size || ""}`,
    `開始時間：${answers.timeline || ""}`,
    `預算範圍：${answers.budget || ""}`,
    `姓名：${answers.name || ""}`,
    `聯絡電話：${answers.phone || ""}`,
    `聯絡時段：${answers.contact_time || ""}`,
    "",
    "感謝您完成填寫，我們已收到資料，將由專人與您聯繫。",
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
    if (f.pattern) {
      const re = new RegExp(f.pattern);
      if (!re.test(answers[f.key])) {
        return "電話格式似乎不正確，請輸入 09 開頭的 10 碼手機號碼";
      }
    }
  }
  return null;
}
