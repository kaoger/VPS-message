import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claimLead, markNotification, createOutcomeToken, parseNotificationEmails, sendNotificationEmails } from '../supabase/functions/notify-lead/notify-core.js'
import crypto from 'node:crypto'

function fakeClient(initialRow) {
  const state = { row: initialRow && { ...initialRow }, reads: 0, writes: 0 }
  const client = {
    from(table) {
      assert.equal(table, 'customer_leads')
      let action = 'select'
      let columns = '*'
      let changes = null
      const filters = []
      const query = {
        select(value) { columns = value; return query },
        update(value) { action = 'update'; changes = value; return query },
        eq(column, value) { filters.push([column, value]); return query },
        is(column, value) { filters.push([column, value]); return query },
        async maybeSingle() {
          const matches = state.row && filters.every(([column, value]) => state.row[column] === value)
          if (action === 'update') {
            state.writes++
            if (matches) state.row = { ...state.row, ...changes }
          } else state.reads++
          if (!matches) return { data: null, error: null }
          const data = columns === '*' ? { ...state.row } : Object.fromEntries(
            columns.split(',').map((column) => [column, state.row[column]])
          )
          return { data, error: null }
        },
      }
      return query
    },
  }
  return { client, state }
}

const initial = () => ({
  id: 'lead-1', status: 'complete', notification_status: 'pending',
  notification_claim_id: null, notification_claimed_at: null, notified_at: null,
  answers: { name: '測試' },
})
const options = (id = 'claim-1') => ({ delays: [0], newId: () => id, now: () => '2026-09-28T00:00:00Z' })
const markOptions = { delays: [0] }

function fakeSender(results) {
  const calls = []
  const errors = []
  let active = false
  return {
    calls,
    errors,
    dependencies: {
      async fetchImpl(url, request) {
        assert.equal(active, false, 'Recipients must be sent sequentially')
        active = true
        calls.push({ url, ...request, body: JSON.parse(request.body) })
        await Promise.resolve()
        active = false
        const result = results[calls.length - 1]
        if (result instanceof Error) throw result
        assert.equal(typeof result, 'number', 'Unexpected extra send')
        return { ok: result >= 200 && result < 300, status: result }
      },
      logError: (...args) => errors.push(args),
    },
  }
}

const emailMessage = {
  apiKey: 'synthetic-resend-key', from: 'notify@example.test',
  subject: '新客戶通知', html: '<a href="https://example.test/lead/outcome?t=same-token">確認</a>',
}

test('single notification email keeps the existing one-recipient request', async () => {
  const sender = fakeSender([200])
  const recipients = parseNotificationEmails('owner@example.test')
  assert.deepEqual(recipients, ['owner@example.test'])
  assert.deepEqual(await sendNotificationEmails({ ...emailMessage, recipients }, sender.dependencies), recipients)
  assert.deepEqual(sender.calls, [{
    url: 'https://api.resend.com/emails', method: 'POST',
    headers: { Authorization: 'Bearer synthetic-resend-key', 'Content-Type': 'application/json' },
    body: { from: emailMessage.from, to: recipients, subject: emailMessage.subject, html: emailMessage.html },
  }])
  assert.deepEqual(sender.errors, [])
})

test('notification emails split commas and semicolons, trim, lowercase and deduplicate in order', () => {
  assert.deepEqual(parseNotificationEmails(' B@Y.com, ; a@X.com ;\tB@y.COM,\n C@z.com ; a@x.com, '), [
    'b@y.com', 'a@x.com', 'c@z.com',
  ])
})

test('invalid notification email entries are skipped', () => {
  assert.deepEqual(parseNotificationEmails('bad; a@@x.com, @x.com, a@, a@localhost, a@.com, a@x., a@x..com, a b@x.com; Valid@x.com'), [
    'valid@x.com',
  ])
})

test('empty parsed recipients or missing API key use the existing configuration error', async () => {
  const sender = fakeSender([])
  for (const value of [undefined, null, '', ' , ;\t\n', 'invalid; a@@x.com']) {
    const recipients = parseNotificationEmails(value)
    assert.deepEqual(recipients, [])
    await assert.rejects(sendNotificationEmails({ ...emailMessage, recipients }, sender.dependencies), {
      message: 'Missing RESEND_API_KEY or NOTIFICATION_EMAIL',
    })
  }
  await assert.rejects(sendNotificationEmails({ ...emailMessage, apiKey: '', recipients: ['a@x.com'] }, sender.dependencies), {
    message: 'Missing RESEND_API_KEY or NOTIFICATION_EMAIL',
  })
  assert.equal(sender.calls.length, 0)
})

test('successful recipients get separate requests with the same content and token, stored in order', async () => {
  const { client, state } = fakeClient(initial())
  const claim = await claimLead(client, 'lead-1', options())
  const recipients = parseNotificationEmails('a@x.com; b@y.com, c@z.com')
  const sender = fakeSender([200, 201, 200])
  const sentEmails = await sendNotificationEmails({ ...emailMessage, recipients }, sender.dependencies)
  assert.deepEqual(sentEmails, recipients)
  assert.deepEqual(sender.calls.map(({ body }) => body), recipients.map((email) => ({
    from: emailMessage.from, to: [email], subject: emailMessage.subject, html: emailMessage.html,
  })))
  assert.equal(await markNotification(client, 'lead-1', claim.claimId, 'sent', {
    notification_email: sentEmails.join(', '),
  }, markOptions), 'updated')
  assert.equal(state.row.notification_email, 'a@x.com, b@y.com, c@z.com')
  assert.equal(state.row.notification_status, 'sent')
  assert.deepEqual(sender.errors, [])
})

test('primary success and secondary failure stay sent and store only the successful recipient', async () => {
  const { client, state } = fakeClient(initial())
  const claim = await claimLead(client, 'lead-1', options())
  const sender = fakeSender([200, 403])
  const sentEmails = await sendNotificationEmails({
    ...emailMessage, recipients: parseNotificationEmails('a@x.com, b@y.com'),
  }, sender.dependencies)
  assert.deepEqual(sentEmails, ['a@x.com'])
  assert.equal(await markNotification(client, 'lead-1', claim.claimId, 'sent', {
    notification_email: sentEmails.join(', '),
  }, markOptions), 'updated')
  assert.equal(state.row.notification_status, 'sent')
  assert.equal(state.row.notification_email, 'a@x.com')
  assert.deepEqual(sender.errors, [['secondary_recipient_failed', 403]])
  assert.equal(sender.calls.length, 2)
})

test('secondary failure does not prevent later recipients from succeeding', async () => {
  const sender = fakeSender([200, 403, 200])
  assert.deepEqual(await sendNotificationEmails({
    ...emailMessage, recipients: ['a@x.com', 'b@y.com', 'c@z.com'],
  }, sender.dependencies), ['a@x.com', 'c@z.com'])
  assert.deepEqual(sender.errors, [['secondary_recipient_failed', 403]])
})

test('primary failure throws and marks failed even when a secondary recipient succeeds', async () => {
  const { client, state } = fakeClient(initial())
  const claim = await claimLead(client, 'lead-1', options())
  const sender = fakeSender([403, 200])
  await assert.rejects(async () => {
    try {
      await sendNotificationEmails({ ...emailMessage, recipients: ['a@x.com', 'b@y.com'] }, sender.dependencies)
    } catch (error) {
      assert.equal(await markNotification(client, 'lead-1', claim.claimId, 'failed', {}, markOptions), 'updated')
      throw error
    }
  }, { message: 'Resend request failed' })
  assert.equal(state.row.notification_status, 'failed')
  assert.equal(state.row.notification_email, undefined)
  assert.equal(sender.calls.length, 2)
  assert.deepEqual(sender.errors, [['Resend error status:', 403]])
})

test('secondary network error logs only status 0 and does not expose error details', async () => {
  const sender = fakeSender([200, new Error('private recipient b@y.com and token')])
  assert.deepEqual(await sendNotificationEmails({
    ...emailMessage, recipients: ['a@x.com', 'b@y.com'],
  }, sender.dependencies), ['a@x.com'])
  assert.deepEqual(sender.errors, [['secondary_recipient_failed', 0]])
})

test('primary network error still throws after attempting the secondary recipient', async () => {
  const sender = fakeSender([new Error('private request details'), 200])
  await assert.rejects(sendNotificationEmails({
    ...emailMessage, recipients: ['a@x.com', 'b@y.com'],
  }, sender.dependencies), { message: 'Resend request failed' })
  assert.equal(sender.calls.length, 2)
  assert.deepEqual(sender.errors, [['Resend error status:', 0]])
})

test('pending claim then mark sent', async () => {
  const { client, state } = fakeClient(initial())
  const claim = await claimLead(client, 'lead-1', options())
  assert.equal(claim.claimId, 'claim-1')
  assert.equal(claim.modified, false)
  assert.equal(claim.lead.notification_status, 'sending')
  assert.equal(state.row.notification_claim_id, 'claim-1')
  assert.equal(await markNotification(client, 'lead-1', claim.claimId, 'sent', {
    notified_at: '2026-09-28T00:01:00Z',
  }, markOptions), 'updated')
  assert.equal(state.row.notification_status, 'sent')
})

test('old worker cannot mark a newer claim after customer edit', async () => {
  const { client, state } = fakeClient(initial())
  const w1 = await claimLead(client, 'lead-1', options('w1'))
  state.row = { ...state.row, notification_status: 'pending', answers: { name: '新版' } }
  const w3 = await claimLead(client, 'lead-1', options('w3'))
  assert.equal(w3.modified, true)
  assert.deepEqual(w3.lead.answers, { name: '新版' })
  assert.equal(await markNotification(client, 'lead-1', w1.claimId, 'sent', {}, markOptions), 'stale')
  assert.equal(state.row.notification_status, 'sending')
  assert.equal(state.row.notification_claim_id, 'w3')
  assert.equal(await markNotification(client, 'lead-1', w3.claimId, 'failed', {}, markOptions), 'updated')
  assert.equal(state.row.notification_status, 'failed')
})

test('sent, failed, and sending rows are not claimed or changed', async () => {
  for (const status of ['sent', 'failed', 'sending']) {
    const { client, state } = fakeClient({ ...initial(), notification_status: status })
    const before = structuredClone(state.row)
    assert.equal(await claimLead(client, 'lead-1', options()), null)
    assert.deepEqual(state.row, before)
    assert.equal(state.writes, 0)
  }
})

test('missing row returns null after lookup retries', async () => {
  const { client, state } = fakeClient(null)
  const sleeps = []
  assert.equal(await claimLead(client, 'lead-1', {
    ...options(), delays: [0, 5, 10], sleep: async (ms) => sleeps.push(ms),
  }), null)
  assert.equal(state.reads, 3)
  assert.equal(state.writes, 0)
  assert.deepEqual(sleeps, [5, 10])
})

test('second claim after another pending transition is modified', async () => {
  const { client, state } = fakeClient(initial())
  assert.equal((await claimLead(client, 'lead-1', options('first'))).modified, false)
  state.row.notification_status = 'pending'
  const second = await claimLead(client, 'lead-1', options('second'))
  assert.equal(second.modified, true)
  assert.equal(second.claimId, 'second')
})

test('pending row with notified_at but no claim id is modified', async () => {
  const { client } = fakeClient({
    ...initial(), notified_at: '2026-09-27T00:00:00Z',
  })
  const claim = await claimLead(client, 'lead-1', options())
  assert.equal(claim.modified, true)
})

test('outcome token is 32 random bytes encoded as base64url with SHA-256 hash', async () => {
  const first = await createOutcomeToken()
  const second = await createOutcomeToken()
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(Buffer.from(first.token, 'base64url').length, 32)
  assert.equal(first.hash, crypto.createHash('sha256').update(first.token).digest('hex'))
  assert.notEqual(first.token, second.token)
})

test('sent update stores notification and token columns in one write', async () => {
  const { client, state } = fakeClient(initial())
  const claim = await claimLead(client, 'lead-1', options())
  const { hash } = await createOutcomeToken()
  const before = state.writes
  assert.equal(await markNotification(client, 'lead-1', claim.claimId, 'sent', {
    notified_at: '2026-09-28T00:00:00Z',
    outcome_token_hash: hash,
    outcome_token_expires_at: '2026-10-12T00:00:00Z',
  }, markOptions), 'updated')
  assert.equal(state.writes, before + 1)
  assert.equal(state.row.notification_status, 'sent')
  assert.equal(state.row.outcome_token_hash, hash)
  assert.equal(state.row.outcome_token_expires_at, '2026-10-12T00:00:00Z')
})

test('recording contact result on a sent lead does not claim or resend it', async () => {
  const { client, state } = fakeClient(initial())
  const claim = await claimLead(client, 'lead-1', options())
  assert.equal(await markNotification(client, 'lead-1', claim.claimId, 'sent', {
    notified_at: '2026-09-28T00:01:00Z',
  }, markOptions), 'updated')
  await client.from('customer_leads').update({
    contact_result: 'contacted',
    contact_result_at: '2026-09-28T00:02:00Z',
  }).eq('id', 'lead-1').select('id').maybeSingle()
  const before = structuredClone(state.row)
  const writes = state.writes
  assert.equal(await claimLead(client, 'lead-1', options('again')), null)
  assert.deepEqual(state.row, before)
  assert.equal(state.writes, writes)
})
