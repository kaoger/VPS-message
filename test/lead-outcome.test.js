import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

process.env.DOTENV_CONFIG_PATH = 'test/nonexistent.env'
Object.assign(process.env, {
  NODE_ENV: 'production', PORT: '3000', DEMO_MODE: 'webform',
  META_APP_SECRET: 'test-app-secret', META_VERIFY_TOKEN: 'test-verify',
  META_PAGE_ACCESS_TOKEN: 'test-page-token', FORM_TOKEN_SECRET: 'x'.repeat(32),
  PUBLIC_BASE_URL: 'https://example.test', SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test', SUPABASE_SERVICE_ROLE_KEY: '', LOG_PATH: '',
})

const id = '11111111-2222-4333-8444-555555555555'
const token = crypto.randomBytes(32).toString('base64url')
const hash = crypto.createHash('sha256').update(token).digest('hex')
const row = {
  id, outcome_token_hash: hash,
  outcome_token_expires_at: new Date(Date.now() + 60_000).toISOString(),
  contact_first_at: null,
  customer_name: '測試姓名', phone: '0912345678', location: '高雄市',
}
const writes = []
const logs = []
const realFetch = globalThis.fetch
const realLog = console.log
let databaseError = false
let saveMiss = false
let invalidRequests = 0
console.log = (...args) => logs.push(args.join(' '))

globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(String(url))
  if (parsed.origin === 'https://example.supabase.co') {
    if (databaseError) return Response.json({ message: 'private database error' }, { status: 500 })
    assert.equal(parsed.pathname, '/rest/v1/customer_leads')
    const params = parsed.searchParams
    const selectedId = params.get('id')?.slice(3)
    if (options.method === 'GET') {
      return Response.json(selectedId === row.id ? {
        outcome_token_hash: row.outcome_token_hash,
        outcome_token_expires_at: row.outcome_token_expires_at,
      } : null)
    }
    assert.equal(options.method, 'PATCH')
    const body = JSON.parse(options.body)
    writes.push({ body, url: parsed })
    const valid = selectedId === row.id &&
      params.get('outcome_token_hash') === `eq.${row.outcome_token_hash}` &&
      params.get('outcome_token_expires_at')?.startsWith('gt.') &&
      Date.parse(row.outcome_token_expires_at) > Date.parse(params.get('outcome_token_expires_at').slice(3)) &&
      (!params.has('contact_first_at') || row.contact_first_at === null)
    if (!valid || saveMiss) return Response.json(null)
    Object.assign(row, body)
    return Response.json({ id: row.id })
  }
  if (parsed.hostname === '127.0.0.1') return realFetch(url, options)
  throw new Error('Unexpected network destination')
}

const { app } = await import('../src/server.js')
let server
let base
before(async () => {
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  console.log = realLog
  globalThis.fetch = realFetch
  if (server?.listening) await new Promise(resolve => server.close(resolve))
})

const query = (overrides = {}) => new URLSearchParams({ id, t: token, r: 'site_visit', ...overrides })
const get = (overrides = {}) => fetch(`${base}/lead/outcome?${query(overrides)}`)
const post = (overrides = {}) => fetch(`${base}/lead/outcome`, { method: 'POST', body: query(overrides) })
const assertFrameDenied = (response) => {
  assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'")
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
}

test('GET confirmation has no customer data and sends no PATCH', async () => {
  const beforeWrites = writes.length
  const response = await get()
  assert.equal(response.status, 200)
  assertFrameDenied(response)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  const html = await response.text()
  assert.match(html, /要記錄的結果：約丈量/)
  assert.match(html, /<button type="submit">確認<\/button>/)
  assert.match(html, /<meta name="robots" content="noindex">/)
  for (const personal of ['測試姓名', '0912345678', '高雄市']) assert.ok(!html.includes(personal))
  assert.equal(writes.length, beforeWrites)
})

test('POST updates only result fields and first contact timestamp once', async () => {
  const first = await post()
  assert.equal(first.status, 200)
  assertFrameDenied(first)
  assert.match(await first.text(), /已記錄：約丈量/)
  assert.equal(writes.length, 2)
  assert.deepEqual(Object.keys(writes[0].body).sort(), ['contact_result', 'contact_result_at'])
  assert.deepEqual(Object.keys(writes[1].body), ['contact_first_at'])
  for (const write of writes) {
    assert.equal(write.url.searchParams.get('outcome_token_hash'), `eq.${hash}`)
    assert.ok(write.url.searchParams.get('outcome_token_expires_at')?.startsWith('gt.'))
    assert.equal('notification_status' in write.body, false)
  }
  assert.equal(writes[1].url.searchParams.get('contact_first_at'), 'is.null')
  const firstAt = row.contact_first_at
  assert.ok(firstAt)
  const second = await post({ r: 'contacted' })
  assert.equal(second.status, 200)
  assert.equal(row.contact_result, 'contacted')
  assert.equal(row.contact_first_at, firstAt)
  assert.equal('notification_status' in writes.at(-1).body, false)
})

test('all invalid inputs, expired links and database failures share identical 404 page', async () => {
  const responses = []
  const wrongToken = crypto.randomBytes(32).toString('base64url')
  responses.push(await get({ t: wrongToken }))
  responses.push(await post({ t: wrongToken }))
  const expiry = row.outcome_token_expires_at
  row.outcome_token_expires_at = new Date(Date.now() - 1000).toISOString()
  responses.push(await get())
  responses.push(await post())
  row.outcome_token_expires_at = expiry
  responses.push(await get({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }))
  responses.push(await post({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }))
  responses.push(await get({ r: 'bad' }))
  responses.push(await post({ r: 'bad' }))
  responses.push(await get({ t: '' }))
  responses.push(await post({ t: '' }))
  responses.push(await post({ id: 'bad' }))
  databaseError = true
  responses.push(await get())
  responses.push(await post())
  databaseError = false
  const dbKey = process.env.SUPABASE_SECRET_KEY
  process.env.SUPABASE_SECRET_KEY = ''
  try {
    responses.push(await get())
    responses.push(await post())
  }
  finally { process.env.SUPABASE_SECRET_KEY = dbKey }
  const bodies = await Promise.all(responses.map(async response => {
    assert.equal(response.status, 404)
    assertFrameDenied(response)
    return response.text()
  }))
  invalidRequests += responses.length
  assert.equal(new Set(bodies).size, 1)
  assert.match(bodies[0], /連結無效或已過期/)
  assert.match(bodies[0], /name="robots" content="noindex"/)
  assert.ok(!logs.join('\n').includes(token))
  assert.ok(!logs.join('\n').includes(id))
})

test('invalid request 61 is limited while valid GET and POST still work', async () => {
  let response
  while (invalidRequests < 60) {
    response = await get({ r: 'bad' })
    invalidRequests++
    assert.equal(response.status, 404)
  }
  assert.equal(response.status, 404)
  response = await get({ r: 'bad' })
  invalidRequests++
  assert.equal(response.status, 429)
  assertFrameDenied(response)
  assert.ok(response.headers.get('retry-after'))
  const validGet = await get()
  assert.equal(validGet.status, 200)
  assertFrameDenied(validGet)
  const beforeResultWrites = writes.filter(write => 'contact_result' in write.body).length
  const validPost = await post({ r: 'unreachable' })
  assert.equal(validPost.status, 200)
  assertFrameDenied(validPost)
  assert.equal(row.contact_result, 'unreachable')
  assert.equal(writes.filter(write => 'contact_result' in write.body).length, beforeResultWrites + 1)
  for (let i = 0; i < 100; i++) {
    const valid = i % 2 ? await post({ r: 'contacted' }) : await get()
    assert.equal(valid.status, 200)
  }
  assert.equal(row.contact_result, 'contacted')
  assert.equal(writes.filter(write => 'contact_result' in write.body).length, beforeResultWrites + 51)
  saveMiss = true
  try {
    const unsaved = await post()
    assert.equal(unsaved.status, 404)
    assertFrameDenied(unsaved)
  } finally { saveMiss = false }
  const form = await fetch(`${base}/form/submit`, { method: 'POST', body: new URLSearchParams({ token: 'invalid' }) })
  assert.equal(form.status, 400)
  assert.equal(form.headers.get('x-frame-options'), null)
})
