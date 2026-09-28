import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadScoringConfig, scoreLead } from "../src/lead-score.js";
import { createCustomerLead, updateCustomerLead } from "../src/supabase.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SAMPLE_PATH = path.join(ROOT, "test/fixtures/lead-scoring.sample.json");
const EMPTY = { score: null, grade: null, reasons: null };
const chen = {
  service: "新成屋裝潢", area: "高雄市", size: "31–40 坪",
  timeline: "一個月內", budget: "100–200 萬", name: "陳先生（測試）",
  phone: "0900000000", contact_time: "晚上 6–9 點",
};

function withScoringPath(value, run) {
  const before = process.env.LEAD_SCORING_PATH;
  process.env.LEAD_SCORING_PATH = value;
  try { return run(); }
  finally {
    if (before === undefined) delete process.env.LEAD_SCORING_PATH;
    else process.env.LEAD_SCORING_PATH = before;
  }
}

test("empty production rules return three nulls", () => {
  withScoringPath("config/lead-scoring.json", () => {
    assert.deepEqual(loadScoringConfig(), { version: 1, fields: {}, grades: [] });
    assert.deepEqual(scoreLead(chen, loadScoringConfig()), EMPTY);
  });
});

test("sample rules score Mr. Chen 10, hot, with five reasons", () => {
  const config = JSON.parse(fs.readFileSync(SAMPLE_PATH, "utf8"));
  assert.deepEqual(scoreLead(Object.freeze({ ...chen }), config), {
    score: 10,
    grade: "hot",
    reasons: [
      "新成屋裝潢 +1", "高雄市 +2", "31–40 坪 +2",
      "一個月內 +3", "100–200 萬 +2",
    ],
  });
});

test("sample thresholds grade 4 as normal and 3 as low", () => {
  const config = JSON.parse(fs.readFileSync(SAMPLE_PATH, "utf8"));
  assert.equal(scoreLead({ area: "高雄市", size: "31–40 坪" }, config).grade, "normal");
  assert.equal(scoreLead({ timeline: "一個月內" }, config).grade, "low");
});

test("grades with no configured field scores still produce zero", () => {
  const sample = JSON.parse(fs.readFileSync(SAMPLE_PATH, "utf8"));
  assert.deepEqual(scoreLead(chen, { version: 1, fields: {}, grades: sample.grades }),
    { score: 0, grade: "low", reasons: [] });
});

test("unscored choices and other area yield zero, low, and no reasons", () => {
  const config = JSON.parse(fs.readFileSync(SAMPLE_PATH, "utf8"));
  assert.deepEqual(scoreLead({
    service: "局部裝修", area: "其他地區", area_other: "高雄市",
    size: "尚未確定", timeline: "尚未確定", budget: "尚未確定",
  }, config), { score: 0, grade: "low", reasons: [] });
});

test("invalid configurations become null rules and log only event names", () => {
  const base = JSON.parse(fs.readFileSync(SAMPLE_PATH, "utf8"));
  const cases = [
    { ...base, version: 2 },
    { ...base, fields: { ...base.fields, name: { "陳先生": 1 } } },
    { ...base, fields: { ...base.fields, size: { "31-40 坪": 2 } } },
    { ...base, fields: { ...base.fields, budget: { "100–200 萬": -1 } } },
    { ...base, fields: { ...base.fields, budget: { "100–200 萬": 101 } } },
    { ...base, grades: [{ ...base.grades[0], min: 501 }, ...base.grades.slice(1)] },
    { ...base, grades: [] },
    { ...base, grades: [...base.grades].reverse() },
    { ...base, grades: base.grades.slice(0, 2) },
    "{ bad json",
  ];
  const file = path.join(ROOT, "test/fixtures", `.lead-scoring-invalid-${randomUUID()}.json`);
  const previousLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  try {
    for (const item of cases) {
      fs.writeFileSync(file, typeof item === "string" ? item : JSON.stringify(item));
      withScoringPath(file, () => {
        assert.equal(loadScoringConfig(), null);
        assert.deepEqual(scoreLead(chen, loadScoringConfig()), EMPTY);
      });
    }
  } finally {
    console.log = previousLog;
    fs.unlinkSync(file);
  }
  assert.equal(logs.length, cases.length * 2);
  assert.ok(logs.every(line => line === "lead_score_config_invalid"));
});

test("missing scoring file returns null and logs no path", () => {
  const missing = path.join(ROOT, "test/fixtures", `missing-${randomUUID()}.json`);
  const previousLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  try {
    withScoringPath(missing, () => {
      assert.equal(loadScoringConfig(), null);
      assert.deepEqual(scoreLead(chen, loadScoringConfig()), EMPTY);
    });
  } finally { console.log = previousLog; }
  assert.deepEqual(logs, ["lead_score_config_missing", "lead_score_config_missing"]);
  assert.ok(logs.every(line => !line.includes(missing)));
});

test("loader rereads changed rules on every call", () => {
  const file = path.join(ROOT, "test/fixtures", `.lead-scoring-reload-${randomUUID()}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, fields: {}, grades: [] }));
    withScoringPath(file, () => {
      assert.deepEqual(scoreLead(chen, loadScoringConfig()), EMPTY);
      fs.writeFileSync(file, fs.readFileSync(SAMPLE_PATH));
      assert.equal(scoreLead(chen, loadScoringConfig()).score, 10);
    });
  } finally { fs.unlinkSync(file); }
});

test("Supabase INSERT and UPDATE include scored columns but omit them without a score", async () => {
  const previousFetch = globalThis.fetch;
  const previousPath = process.env.LEAD_SCORING_PATH;
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SECRET_KEY;
  const previousLog = console.log;
  const writes = [];
  const logs = [];
  process.env.SUPABASE_URL = "https://scoring-test.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "test-only-key";
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).startsWith("https://scoring-test.supabase.co/rest/v1/customer_leads"));
    assert.ok(["POST", "PATCH"].includes(options.method));
    writes.push({ method: options.method, body: JSON.parse(options.body), url: String(url) });
    return Response.json({ id: "test-lead" }, { status: options.method === "POST" ? 201 : 200 });
  };
  try {
    process.env.LEAD_SCORING_PATH = SAMPLE_PATH;
    await createCustomerLead({ senderId: "test-sender", answers: chen });
    await updateCustomerLead({ senderId: "test-sender", id: "test-lead", previousAnswers: chen,
      answers: { ...chen, area: "其他地區", area_other: "台南" } });
    assert.deepEqual(writes.map(write => write.method), ["POST", "PATCH"]);
    for (const write of writes.slice(0, 2)) {
      for (const key of ["lead_score", "lead_grade", "lead_score_reasons"]) {
        assert.ok(Object.hasOwn(write.body, key));
      }
    }
    assert.deepEqual([writes[0].body.lead_score, writes[0].body.lead_grade, writes[0].body.lead_score_reasons],
      [10, "hot", ["新成屋裝潢 +1", "高雄市 +2", "31–40 坪 +2", "一個月內 +3", "100–200 萬 +2"]]);
    assert.equal(writes[1].body.lead_score, 8);
    assert.equal(writes[1].body.lead_grade, "hot");
    assert.equal(writes[1].body.lead_score_reasons.length, 4);
    assert.equal(writes[1].body.notification_status, "pending");
    assert.ok(writes[1].url.includes("notification_status=neq.not_required"));

    process.env.LEAD_SCORING_PATH = "config/lead-scoring.json";
    await createCustomerLead({ senderId: "test-sender", answers: chen });
    await updateCustomerLead({ senderId: "test-sender", id: "test-lead", previousAnswers: chen,
      answers: chen });
    assert.deepEqual(writes.slice(2).map(write => write.method), ["POST", "PATCH"]);
    for (const write of writes.slice(2, 4)) {
      for (const key of ["lead_score", "lead_grade", "lead_score_reasons"]) {
        assert.equal(Object.hasOwn(write.body, key), false);
      }
    }

    process.env.LEAD_SCORING_PATH = SAMPLE_PATH;
    console.log = (...args) => logs.push(args.join(" "));
    const failingAnswers = () => {
      const value = { ...chen };
      let reads = 0;
      Object.defineProperty(value, "service", { enumerable: true, get() {
        reads++;
        if (reads === 2) throw new Error("private scoring failure");
        return chen.service;
      } });
      return value;
    };
    await createCustomerLead({ senderId: "test-sender", answers: failingAnswers() });
    await updateCustomerLead({ senderId: "test-sender", id: "test-lead", previousAnswers: chen,
      answers: failingAnswers() });
    for (const write of writes.slice(4, 6)) {
      for (const key of ["lead_score", "lead_grade", "lead_score_reasons"]) {
        assert.equal(Object.hasOwn(write.body, key), false);
      }
    }
    assert.deepEqual(logs, ["lead_score_fail", "lead_score_fail"]);
  } finally {
    globalThis.fetch = previousFetch;
    console.log = previousLog;
    for (const [key, value] of [["LEAD_SCORING_PATH", previousPath], ["SUPABASE_URL", previousUrl], ["SUPABASE_SECRET_KEY", previousKey]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("zero-row first CAS retries without notification status for not_required or NULL", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SECRET_KEY;
  const writes = [];
  process.env.SUPABASE_URL = "https://scoring-test.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "test-only-key";
  globalThis.fetch = async (url, options) => {
    writes.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json(writes.length === 1 ? [] : [{ id: "test-lead" }]);
  };
  try {
    const result = await updateCustomerLead({ senderId: "test-sender", id: "test-lead",
      previousAnswers: chen, answers: chen });
    assert.deepEqual(result, { id: "test-lead" });
    assert.equal(writes[0].body.notification_status, "pending");
    assert.ok(writes[0].url.includes("notification_status=neq.not_required"));
    assert.equal(Object.hasOwn(writes[1].body, "notification_status"), false);
    assert.ok(!writes[1].url.includes("notification_status=neq.not_required"));
    assert.ok(writes.every(write => write.url.includes("id=eq.test-lead") &&
      write.url.includes("messenger_user_id=eq.test-sender") && write.url.includes("answers=eq.")));
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of [["SUPABASE_URL", previousUrl], ["SUPABASE_SECRET_KEY", previousKey]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("two zero-row CAS updates return null for a version conflict", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SECRET_KEY;
  const writes = [];
  process.env.SUPABASE_URL = "https://scoring-test.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "test-only-key";
  globalThis.fetch = async (url, options) => {
    writes.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json([]);
  };
  try {
    assert.equal(await updateCustomerLead({ senderId: "test-sender", id: "test-lead",
      previousAnswers: chen, answers: chen }), null);
    assert.equal(writes.length, 2);
    assert.equal(writes[0].body.notification_status, "pending");
    assert.equal(Object.hasOwn(writes[1].body, "notification_status"), false);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of [["SUPABASE_URL", previousUrl], ["SUPABASE_SECRET_KEY", previousKey]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
