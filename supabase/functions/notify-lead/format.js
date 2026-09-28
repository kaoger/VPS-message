const gradeLabels = { hot: '🔥 高分', normal: '一般', low: '低' }
const scoreGradeLabels = { hot: '高分', normal: '一般', low: '低' }

export function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character] ?? character)
}

export function display(value, labels) {
  if (!value) return '未填寫'
  return labels[value] ?? value
}

function fieldValue(value, labels) {
  return value == null || value === '' ? '未填' : display(value, labels)
}

export function buildSubject(lead, labels, { modified = false } = {}) {
  const modifiedPrefix = modified ? '【已修改】' : ''
  const grade = gradeLabels[lead.lead_grade]
  const gradePart = grade ? `【${grade}】` : ''
  const fields = [lead.project_type, lead.location, lead.interior_area]
    .map((value) => fieldValue(value, labels))
  return `${modifiedPrefix}${gradePart}新客戶：${fields.join('／')}`.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')
}

export function buildScoreBlockHtml(lead) {
  if (typeof lead.lead_score !== 'number' || !Number.isFinite(lead.lead_score)) {
    return '<p>評分：尚未設定規則</p>'
  }
  const label = scoreGradeLabels[lead.lead_grade] ?? '未分級'
  const reasons = Array.isArray(lead.lead_score_reasons)
    ? lead.lead_score_reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')
    : ''
  return `<p>評分 ${escapeHtml(lead.lead_score)}（${escapeHtml(label)}）</p>` +
    (reasons ? `<ul>${reasons}</ul>` : '')
}

export function buildKeyFieldsHtml(lead, labels) {
  const fields = [
    ['服務', lead.project_type],
    ['地區', lead.location],
    ['坪數', lead.interior_area],
    ['開始時間', lead.start_time],
    ['預算', lead.budget_range],
  ]
  return '<ul>' + fields.map(([name, value]) =>
    `<li><strong>${name}</strong>：${escapeHtml(fieldValue(value, labels))}</li>`
  ).join('') + '</ul>'
}
