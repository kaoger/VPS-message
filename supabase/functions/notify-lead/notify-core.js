const defaultDelays = [0, 150, 400, 900, 1600]
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function createOutcomeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  return { token, hash }
}

export async function claimLead(client, id, {
  delays = defaultDelays,
  sleep = defaultSleep,
  now = () => new Date().toISOString(),
  newId = () => crypto.randomUUID(),
} = {}) {
  for (const delay of delays) {
    if (delay) await sleep(delay)

    const { data: existing, error: readError } = await client
      .from('customer_leads')
      .select('id,status,notification_status,notification_claim_id,notified_at')
      .eq('id', id)
      .maybeSingle()
    if (readError) throw new Error('Lead lookup failed')
    if (!existing) continue
    if (existing.status !== 'complete' || existing.notification_status !== 'pending') return null

    const claimId = newId()
    let query = client.from('customer_leads')
      .update({
        notification_status: 'sending',
        notification_claimed_at: now(),
        notification_claim_id: claimId,
      })
      .eq('id', id)
      .eq('notification_status', 'pending')
    query = existing.notification_claim_id === null
      ? query.is('notification_claim_id', null)
      : query.eq('notification_claim_id', existing.notification_claim_id)
    const { data: lead, error: claimError } = await query.select('*').maybeSingle()
    if (claimError) throw new Error('Lead claim failed')
    return lead ? { lead, claimId, modified: existing.notification_claim_id !== null || existing.notified_at != null } : null
  }
  return null
}

export async function markNotification(client, id, claimId, status, extra = {}, {
  delays = defaultDelays,
  sleep = defaultSleep,
} = {}) {
  for (const delay of delays) {
    if (delay) await sleep(delay)
    try {
      const { data, error } = await client.from('customer_leads')
        .update({ notification_status: status, ...extra })
        .eq('id', id)
        .eq('notification_status', 'sending')
        .eq('notification_claim_id', claimId)
        .select('id')
        .maybeSingle()
      if (!error) return data?.id ? 'updated' : 'stale'
    } catch { /* retry transient update errors */ }
  }
  return 'error'
}
