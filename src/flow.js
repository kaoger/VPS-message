/**
 * Fixed 8-question Messenger flow.
 * Hardcoded — no Supabase question bank, no dynamic load.
 */

export const FLOW = [
  {
    key: "service",
    text: "請問您需要哪一類服務？",
    type: "quick_reply",
    options: [
      ["新成屋裝潢", "SERVICE_NEW_HOME"],
      ["舊屋翻新", "SERVICE_OLD_HOME"],
      ["局部裝修", "SERVICE_PARTIAL"],
      ["商業空間", "SERVICE_COMMERCIAL"],
      ["其他服務", "SERVICE_OTHER"],
    ],
  },
  {
    key: "area",
    text: "您好，請問您需要的服務地區是？",
    type: "quick_reply",
    options: [
      ["高雄市", "AREA_KAOHSIUNG"],
      ["台南", "AREA_TAINAN"],
      ["嘉義", "AREA_CHIAYI"],
      ["台中", "AREA_TAICHUNG"],
      ["彰化", "AREA_CHANGHUA"],
      ["雲林", "AREA_YUNLIN"],
      ["其他地區", "AREA_OTHER"],
    ],
    // When payload is AREA_OTHER, wait for free-text region name next.
    otherPayload: "AREA_OTHER",
    otherPrompt: "請直接輸入您的服務地區名稱：",
  },
  {
    key: "size",
    text: "請問您預計裝修的坪數大約是多少？",
    type: "quick_reply",
    options: [
      ["20 坪以下", "SIZE_UNDER_20"],
      ["21–30 坪", "SIZE_21_30"],
      ["31–40 坪", "SIZE_31_40"],
      ["41–60 坪", "SIZE_41_60"],
      ["61 坪以上", "SIZE_OVER_61"],
      ["尚未確定", "SIZE_UNKNOWN"],
    ],
  },
  {
    key: "timeline",
    text: "請問您預計何時開始進行裝修？",
    type: "quick_reply",
    options: [
      ["一個月內", "TIME_1M"],
      ["1–3 個月", "TIME_1_3M"],
      ["3–6 個月", "TIME_3_6M"],
      ["半年以上", "TIME_OVER_6M"],
      ["尚未確定", "TIME_UNKNOWN"],
    ],
  },
  {
    key: "budget",
    text: "請問您的預算範圍大約是？",
    type: "quick_reply",
    options: [
      ["50 萬以下", "BUDGET_UNDER_50"],
      ["50–100 萬", "BUDGET_50_100"],
      ["100–200 萬", "BUDGET_100_200"],
      ["200–300 萬", "BUDGET_200_300"],
      ["300 萬以上", "BUDGET_OVER_300"],
      ["尚未確定", "BUDGET_UNKNOWN"],
    ],
  },
  {
    key: "name",
    text: "謝謝您，請留下您的姓名，方便我們稱呼您。",
    type: "text",
  },
  {
    key: "phone",
    text: "請留下您的聯絡電話，方便專人與您聯繫。",
    type: "text",
    validate: (raw) => /^09\d{8}$/.test(String(raw || "").trim()),
    errorText:
      "電話格式似乎不正確，請輸入 09 開頭的 10 碼手機號碼，例如：0912345678",
  },
  {
    key: "contact_time",
    text: "請問方便聯絡時間？",
    type: "quick_reply",
    options: [
      ["上午 8–12 點", "CONTACT_AM"],
      ["下午 1–5 點", "CONTACT_PM"],
      ["晚上 6–9 點", "CONTACT_EVE"],
    ],
  },
];

/** Human labels for summary */
export const SUMMARY_LABELS = {
  service: "服務類型",
  area: "服務地區",
  size: "預計坪數",
  timeline: "開始時間",
  budget: "預算範圍",
  name: "姓名",
  phone: "聯絡電話",
  contact_time: "聯絡時段",
};

/** Summary shown before confirm (no final thank-you yet). */
export function buildSummary(answers) {
  const lines = [
    "以下是您填寫的資料：",
    "",
    `服務類型：${answers.service ?? ""}`,
    `服務地區：${answers.area ?? ""}`,
    `預計坪數：${answers.size ?? ""}`,
    `開始時間：${answers.timeline ?? ""}`,
    `預算範圍：${answers.budget ?? ""}`,
    `姓名：${answers.name ?? ""}`,
    `聯絡電話：${answers.phone ?? ""}`,
    `聯絡時段：${answers.contact_time ?? ""}`,
    "",
    "請確認資料是否正確：",
  ];
  return lines.join("\n");
}

/** Quick replies on the confirm screen */
export const CONFIRM_OPTIONS = [
  ["確認送出", "CONFIRM_SUBMIT"],
  ["重新填寫", "CONFIRM_RESTART"],
];

export const SUBMIT_SUCCESS_TEXT =
  "感謝您完成需求填寫，我們已收到資料，將由專人與您聯繫。";

/** Test-mode note (only for local /test if needed) */
export const IS_TEST_BUILD = true;

/** Resolve quick-reply payload → display title */
export function titleForPayload(stepDef, payload) {
  if (!stepDef?.options) return null;
  const hit = stepDef.options.find(([, p]) => p === payload);
  return hit ? hit[0] : null;
}
