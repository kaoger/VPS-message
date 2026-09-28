import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claimLead, markNotification } from '../supabase/functions/notify-lead/notify-core.js'

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
