import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSubject, buildScoreBlockHtml, buildKeyFieldsHtml, buildOutcomeLinksHtml, parseOutcomeBaseUrl } from '../supabase/functions/notify-lead/format.js'

const chen = {
  project_type: '新成屋裝潢', location: '高雄市', interior_area: '31–40 坪',
  start_time: '一個月內', budget_range: '100–200 萬',
  lead_score: 10, lead_grade: 'hot',
  lead_score_reasons: ['新成屋裝潢 +1', '高雄市 +2', '31–40 坪 +2', '一個月內 +3', '100–200 萬 +2'],
}

test('scored lead has grade in subject and five reasons in score block', () => {
  assert.equal(buildSubject(chen, {}, { modified: false }), '【🔥 高分】新客戶：新成屋裝潢／高雄市／31–40 坪')
  const html = buildScoreBlockHtml(chen)
  assert.ok(html.startsWith('<p>評分 10（高分）</p>'))
  assert.equal((html.match(/<li>/g) ?? []).length, 5)
  assert.ok(html.includes('100–200 萬 +2'))
})

test('missing score and grade show unconfigured text without a grade prefix', () => {
  const lead = { project_type: 'SERVICE_NEW_HOME', location: null, interior_area: null }
  assert.equal(buildSubject(lead, { SERVICE_NEW_HOME: '新成屋裝潢' }, { modified: false }), '新客戶：新成屋裝潢／未填／未填')
  assert.equal(buildScoreBlockHtml(lead), '<p>評分：尚未設定規則</p>')
})

test('modified parameter controls prefix and subject removes control and Unicode separators', () => {
  const lead = { ...chen, notified_at: '2026-09-27T00:00:00Z', location: '高雄\n市\r\u0000\u2028\u2029' }
  assert.equal(buildSubject(lead, {}, { modified: true }), '【已修改】【🔥 高分】新客戶：新成屋裝潢／高雄市／31–40 坪')
  assert.equal(buildSubject(lead, {}, { modified: false }), '【🔥 高分】新客戶：新成屋裝潢／高雄市／31–40 坪')
})

test('score reasons and fixed fields escape HTML and show missing values', () => {
  const score = buildScoreBlockHtml({ ...chen, lead_score_reasons: ['<script>alert(1)</script>'] })
  assert.ok(score.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(!score.includes('<script>'))
  const fields = buildKeyFieldsHtml({ ...chen, location: '<script>', budget_range: null }, {})
  assert.ok(fields.includes('地區</strong>：&lt;script&gt;'))
  assert.ok(fields.includes('預算</strong>：未填'))
  assert.equal((fields.match(/<li>/g) ?? []).length, 5)
})

test('outcome links contain four encoded choices and escape URL HTML', () => {
  const html = buildOutcomeLinksHtml('https://example.test/', 'id &?', 'token+&')
  assert.equal((html.match(/<a href=/g) ?? []).length, 4)
  for (const result of ['contacted', 'site_visit', 'not_interested', 'unreachable']) {
    assert.ok(html.includes(`r=${result}`))
  }
  assert.ok(html.includes('id=id%20%26%3F'))
  assert.ok(html.includes('t=token%2B%26'))
  assert.ok(html.includes('&amp;t='))
  assert.ok(!html.includes('<bad>'))
  assert.equal(buildOutcomeLinksHtml('', 'id', 'token'), '')
})

test('outcome base URL accepts only an HTTPS origin with at most one trailing slash', () => {
  assert.equal(parseOutcomeBaseUrl('https://bot.sameheart-design.com'), 'https://bot.sameheart-design.com')
  assert.equal(parseOutcomeBaseUrl('https://bot.sameheart-design.com/'), 'https://bot.sameheart-design.com')
  for (const value of [
    'http://bot.sameheart-design.com',
    'https://bot.sameheart-design.com/lead/outcome',
    'https://bot.sameheart-design.com?x=1',
    'https://bot.sameheart-design.com#part',
    'https://bot.sameheart-design.com//',
    '', 'garbage',
  ]) {
    assert.equal(parseOutcomeBaseUrl(value), null, value)
    assert.equal(buildOutcomeLinksHtml(value, 'id', 'token'), '', value)
  }
})
