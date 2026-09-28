import { createClient } from 'npm:@supabase/supabase-js@2'
import { buildSubject, buildScoreBlockHtml, buildKeyFieldsHtml, buildOutcomeLinksHtml, escapeHtml, display, parseOutcomeBaseUrl } from './format.js'
import { claimLead, markNotification, createOutcomeToken } from './notify-core.js'

type LeadRecord = {
  id: string
  source: string
  status: string
  location: string | null
  property_status: string | null
  project_type: string | null
  interior_area: string | null
  budget_range: string | null
  start_time: string | null
  customer_name: string | null
  phone: string | null
  answers: Record<string, string> | null
  notification_status: string
  notification_claim_id: string | null
  notified_at: string | null
  updated_at: string | null
  lead_score: number | null
  lead_grade: string | null
  lead_score_reasons: string[] | null
}

type OutputField = { label: string; answerKey: string; sortOrder: number }

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  (() => { try { const key = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')?.['default']; if (key) return key } catch {} throw new Error('Missing SUPABASE_SECRET_KEYS.default') })(),
)

const resendApiKey = Deno.env.get('RESEND_API_KEY')
const notificationEmail = Deno.env.get('NOTIFICATION_EMAIL')
const emailFrom = Deno.env.get('EMAIL_FROM') || (() => { throw new Error('Missing EMAIL_FROM') })()
const webhookSecret = Deno.env.get('WEBHOOK_SECRET')
const configuredOutcomeBaseUrl = Deno.env.get('OUTCOME_BASE_URL')
const outcomeBaseUrl = parseOutcomeBaseUrl(configuredOutcomeBaseUrl)
if (configuredOutcomeBaseUrl !== undefined && !outcomeBaseUrl) console.error('outcome_base_url_invalid')
const FLOW_KEY = 'interior_design_lead_v1'

const valueLabels: Record<string, string> = {
  AREA_KAOHSIUNG: '高雄', AREA_TAINAN: '台南', AREA_CHIAYI: '嘉義', AREA_TAICHUNG: '台中', AREA_CHANGHUA: '彰化', AREA_YUNLIN: '雲林',
  SERVICE_NEW_HOME: '新成屋裝潢', SERVICE_OLD_HOME: '舊屋翻新', SERVICE_PARTIAL: '局部裝修', SERVICE_COMMERCIAL: '商業空間', SERVICE_OTHER: '其他服務',
  SIZE_UNDER_20: '20 坪以下', SIZE_21_30: '21–30 坪', SIZE_31_40: '31–40 坪', SIZE_41_60: '41–60 坪', SIZE_61_PLUS: '61 坪以上', SIZE_UNKNOWN: '尚未確定',
  BUDGET_UNDER_50: '50 萬以下', BUDGET_50_100: '50–100 萬', BUDGET_100_200: '100–200 萬', BUDGET_200_300: '200–300 萬', BUDGET_300_PLUS: '300 萬以上', BUDGET_UNKNOWN: '尚未確定',
  TIME_WITHIN_MONTH: '一個月內', TIME_1_3_MONTHS: '1–3 個月', TIME_3_6_MONTHS: '3–6 個月', TIME_6_PLUS_MONTHS: '半年以上', TIME_UNKNOWN: '尚未確定',
}

const fallbackOutputFields: OutputField[] = [
  { label: '姓名', answerKey: 'name', sortOrder: 1 },
  { label: '電話', answerKey: 'phone', sortOrder: 2 },
  { label: '地區', answerKey: 'area', sortOrder: 3 },
  { label: '服務類型', answerKey: 'service', sortOrder: 4 },
  { label: '坪數', answerKey: 'size', sortOrder: 5 },
  { label: '預算', answerKey: 'budget', sortOrder: 6 },
  { label: '開始時間', answerKey: 'timeline', sortOrder: 7 },
]

function leadValue(lead: LeadRecord, key: string) {
  return lead.answers?.[key] ?? ({
    name: lead.customer_name,
    phone: lead.phone,
    area: lead.location,
    service: lead.project_type,
    size: lead.interior_area,
    budget: lead.budget_range,
    timeline: lead.start_time,
  } as Record<string, string | null>)[key]
}

async function loadOutputFields() {
  const { data, error } = await supabaseAdmin
    .from('flow_output_fields')
    .select('label, sort_order, questions!inner(answer_key), flows!inner(flow_key, status)')
    .eq('active', true)
    .eq('flows.flow_key', FLOW_KEY)
    .eq('flows.status', 'active')
    .order('sort_order')

  if (error || !data?.length) return fallbackOutputFields

  return data
    .map((row: any) => ({
      label: row.label,
      answerKey: row.questions?.answer_key,
      sortOrder: Number(row.sort_order),
    }))
    .filter((row: OutputField) => row.label && row.answerKey)
}

async function loadValueLabels() {
  const { data, error } = await supabaseAdmin
    .from('question_options')
    .select('label, value')

  if (error) {
    console.error('question option labels load failed')
    return valueLabels
  }

  return {
    ...valueLabels,
    ...Object.fromEntries(
      (data ?? [])
        .filter((row) => row.value && row.label)
        .map((row) => [row.value, row.label]),
    ),
  }
}

function htmlForLead(lead: LeadRecord, fields: OutputField[], labels: Record<string, string>) {
  const items = fields
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((field) =>
      '<li><strong>' + escapeHtml(field.label) + '</strong>：' +
      escapeHtml(display(leadValue(lead, field.answerKey), labels)) + '</li>'
    )
    .join('')

  const sourceLabel = lead.source?.toLowerCase() === 'facebook' ? 'Facebook' : 'Instagram'
  return '<h2>有新的完成案件</h2><p>來源：' + sourceLabel + '</p><ul>' + items + '</ul>'
}

Deno.serve(async (request) => {
  let claimedId: { id: string; claimId: string } | null = null
  try {
    if (!webhookSecret || request.headers.get('x-webhook-secret') !== webhookSecret) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }

    const payload = await request.json()
    const id = payload?.record?.id

    if (typeof id !== 'string' || !id) {
      return new Response(JSON.stringify({ skipped: true }), {
        headers: { 'content-type': 'application/json' },
      })
    }

    const claim = await claimLead(supabaseAdmin, id)
    if (!claim) {
      return new Response(JSON.stringify({ skipped: true }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    const { lead, claimId, modified } = claim as { lead: LeadRecord; claimId: string; modified: boolean }
    claimedId = { id, claimId }

    if (!resendApiKey || !notificationEmail) {
      throw new Error('Missing RESEND_API_KEY or NOTIFICATION_EMAIL')
    }

    const [outputFields, labels] = await Promise.all([
      loadOutputFields(),
      loadValueLabels(),
    ])

    const outcome = outcomeBaseUrl ? await createOutcomeToken() : null

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + resendApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: emailFrom,
        to: [notificationEmail],
        subject: buildSubject(lead, labels, { modified }),
        html: buildScoreBlockHtml(lead) + buildKeyFieldsHtml(lead, labels) + htmlForLead(lead, outputFields, labels) +
          (outcome ? buildOutcomeLinksHtml(outcomeBaseUrl, lead.id, outcome.token) : ''),
      }),
    })

    if (!response.ok) {
      console.error('Resend error status:', response.status)
      throw new Error('Resend request failed')
    }

    const sentAt = new Date()
    const markResult = await markNotification(supabaseAdmin, lead.id, claimId, 'sent', {
      notification_email: notificationEmail,
      notified_at: sentAt.toISOString(),
      ...(outcome ? {
        outcome_token_hash: outcome.hash,
        outcome_token_expires_at: new Date(sentAt.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      } : {}),
    })

    if (markResult === 'stale') console.error('notification_mark_stale')
    if (markResult === 'error') {
      throw new Error('Email sent but failed to persist notification status')
    }

    return new Response(JSON.stringify({ sent: true }), {
      headers: { 'content-type': 'application/json' },
    })
  } catch {
    if (claimedId) {
      try {
        const markResult = await markNotification(supabaseAdmin, claimedId.id, claimedId.claimId, 'failed')
        if (markResult === 'stale') console.error('notification_mark_stale')
        if (markResult === 'error') console.error('notification status update failed')
      }
      catch { console.error('notification failure status update failed') }
    }
    console.error('notify-lead failed')
    return new Response(JSON.stringify({ error: 'Notification failed' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }
})
