import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { FORM_FIELDS as original } from "../fixtures/original-form-fields.js";

test("two-question chat test configuration cannot change the eight web-form questions or summary", () => {
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { FORM_FIELDS, buildFormSummary, validateAnswers } from './src/form-schema.js';
    import { renderFormPage } from './src/form-page.js';
    import { FLOW } from './src/flow.js';
    const answers = { service:'新成屋裝潢',area:'高雄市',size:'20 坪以下',timeline:'一個月內',budget:'50 萬以下',name:'測試',phone:'0912345678',contact_time:'上午 8–12 點' };
    console.log(JSON.stringify({fields:FORM_FIELDS, chatSteps:FLOW.length, summary:buildFormSummary(answers), error:validateAnswers(answers), incomplete:validateAnswers({service:answers.service,area:answers.area}),html:renderFormPage({token:'test'})}));
  `], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, QUESTIONS_PATH: "config/questions.q1-test.json" },
    encoding: "utf8",
  }));
  assert.equal(result.chatSteps, 2);
  assert.deepEqual(result.fields, original);
  assert.equal((result.html.match(/<section class="card" data-step>/g) || []).length, 8);
  assert.doesNotMatch(result.html, /【測試】/);
  assert.doesNotMatch(result.summary, /undefined/);
  assert.match(result.summary, /聯絡電話：0912345678/);
  assert.equal(result.error, null);
  assert.ok(result.incomplete);
});
