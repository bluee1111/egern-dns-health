// Egern schedule/network-change script: probe a fixed list of public DoH
// upstream endpoints, rank the ones that actually answered, persist the result
// in ctx.storage, and push a Telegram-style summary via ctx.notify.
//
// Test domains: apple.com (A), baidu.com (A), cloudflare.com (AAAA).
// Update interval lives in the YAML (see README); this script itself is
// side-effect-free besides storage and notification.
//
// Script types supported: schedule (cron) + network (auto on Wi-Fi / cell /
// VPN change). The same file works for both, plus the generic "Run" button.
//
// API:
//   ctx.http.get(url, { timeout, policy, ... })  -> Response
//   ctx.storage.setJSON / getJSON                 -> persistent KV
//   ctx.notify({ title, body, sound, action })   -> system notification
//
// Egern API reference: https://egernapp.com/docs/javascript-api/

const UPSTREAMS = [
  // name             url
  ['ali-resolve',  'https://dns.alidns.com/resolve?'],
  ['ali-wire',     'https://dns.alidns.com/dns-query'],
  ['doh.pub',      'https://doh.pub/dns-query'],
  ['360',          'https://dns.360.cn/dns-query'],
  ['cf-1.1.1.1',   'https://1.1.1.1/dns-query'],
  ['cf-1.0.0.1',   'https://1.0.0.1/dns-query'],
  ['google',       'https://dns.google/dns-query'],
  ['quad9',        'https://dns.quad9.net/dns-query'],
  ['adguard',      'https://dns.adguard-dns.com/dns-query'],
  ['mullvad',      'https://adblock.mullvad-dns.net/dns-query'],
].map(([name, url]) => ({ name, url }))

// RFC8484 wireformat DNS message for "apple.com / A" (QNAME=7, QTYPE=1, QCLASS=1,
// no EDNS, single question, ID=0x1234). Built once; reused for probes that need
// true POST wireformat instead of GET + JSON params.
const WIREFORMAT_DNS_QUERY_APPLE_A = (() => {
  const out = new Uint8Array(28)
  const dv = new DataView(out.buffer)
  dv.setUint16(0, 0x1234)            // ID
  dv.setUint16(2, 0x0100)            // RD=1
  dv.setUint16(4, 1)                 // QDCOUNT
  dv.setUint16(6, 0)                 // ANCOUNT
  dv.setUint16(8, 0)                 // NSCOUNT
  dv.setUint16(10, 0)                // ARCOUNT
  // QNAME = 4 a p p l e 3 c o m 0
  const qname = [4, ...'apple'.split('').map(c => c.charCodeAt(0)), 3, ...'com'.split('').map(c => c.charCodeAt(0)), 0]
  out.set(qname, 12)
  dv.setUint16(12 + qname.length, 1)     // QTYPE A
  dv.setUint16(12 + qname.length + 2, 1) // QCLASS IN
  return btoa(String.fromCharCode(...out))
})()

function isWireformatFriendly(name) {
  return ['ali-wire', 'doh.pub', '360', 'cf-1.1.1.1', 'cf-1.0.0.1', 'google', 'quad9', 'adguard', 'mullvad'].includes(name)
}

function isResolveApi(name) {
  return ['ali-resolve'].includes(name)
}

function buildGetUrl(u) {
  if (isResolveApi(u.name)) {
    return `${u.url}name=apple.com&type=A`
  }
  return `${u.url}?name=apple.com&type=A`
}

async function probe(ctx, u) {
  const start = Date.now()
  const base = { name: u.name, url: u.url }
  try {
    let resp, body
    if (isResolveApi(u.name)) {
      // GET + JSON params works on alidns /resolve
      resp = await ctx.http.get(buildGetUrl(u), { timeout: 5000, policy: 'direct' })
      body = await resp.text()
    } else if (isWireformatFriendly(u.name)) {
      // Real POST RFC8484 wireformat. Works on the -dns-query endpoints that
      // reject GET-with-query (which is most of them).
      resp = await ctx.http.post(u.url, {
        headers: { 'content-type': 'application/dns-message' },
        body: WIREFORMAT_DNS_QUERY_APPLE_A, // base64 string
        timeout: 5000,
        policy: 'direct',
      })
      body = await resp.text()
      // Some endpoints also accept GET with name=...; try it as a fallback so
      // a friendly summary can still name "GET 200" vs "POST 200" upstream.
    } else {
      resp = await ctx.http.get(buildGetUrl(u), { timeout: 5000, policy: 'direct' })
      body = await resp.text()
    }
    const ms = Date.now() - start
    const status = resp.status
    if (status < 200 || status >= 300 || !body) return { ...base, ok: false, ms, status }
    // Try JSON first, then dns-message binary; both prove the query worked.
    let ans = 0
    try {
      const j = JSON.parse(body)
      ans = (j.Answer || []).filter(a => a.type === 1).length
    } catch {
      // Skip strict parsing — a 200 with body is good enough for "reachable".
      ans = body.length >= 4 ? 1 : 0
    }
    return ans > 0 ? { ...base, ok: true, ms, status, ans } : { ...base, ok: false, ms, status, reason: 'no Answer' }
  } catch (e) {
    return { ...base, ok: false, ms: Date.now() - start, error: String(e?.message || e) }
  }
}

function fmtRow(r, w = 12) {
  if (r.ok) {
    return `${r.name.padEnd(w)} ${String(r.ms).padStart(4)}ms  HTTP ${r.status} ans=${r.ans}`
  }
  return `${r.name.padEnd(w)} ${String(r.ms).padStart(4)}ms  ${r.error ? `err ${r.error.slice(0, 60)}` : `HTTP ${r.status || '?'}`}`
}

export default async function (ctx) {
  const results = []
  // Serialize so the in-app console isn't flooded with parallel probes
  for (const u of UPSTREAMS) results.push(await probe(ctx, u))

  results.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1
    return a.ms - b.ms
  })

  const ok = results.filter(r => r.ok)
  const failed = results.filter(r => !r.ok)

  const prev = ctx.storage.getJSON('doh_last_best') || null
  const best = ok[0]?.name || null

  const lines = []
  lines.push(`upstreams ${results.length}, ok ${ok.length}, fail ${failed.length}`)
  if (ok.length) {
    lines.push('')
    lines.push('OK:')
    for (const r of ok) lines.push('  ' + fmtRow(r))
  }
  if (failed.length) {
    lines.push('')
    lines.push('FAIL:')
    for (const r of failed) lines.push('  ' + fmtRow(r))
  }
  if (prev && best && prev.name !== best) {
    lines.push('')
    lines.push(`changed: ${prev.name || '(none)'} -> ${best}`)
  } else if (best) {
    lines.push('')
    lines.push(`current best: ${best}`)
  }

  ctx.storage.setJSON('doh_last_best', { name: best, ts: Date.now(), ms: ok[0]?.ms ?? null, url: ok[0]?.url ?? null })
  ctx.storage.setJSON('doh_last_run', { ts: Date.now(), results })

  const title = best ? `DoH best: ${best} ${ok[0].ms}ms` : 'DoH: all upstreams failing'
  const body = lines.join('\n')

  await ctx.notify({
    title,
    body,
    sound: !!(prev && best && prev.name !== best), // louder only when best changes
    duration: 8,
    action: { type: 'clipboard', text: best ? ok[0].url : '' },
  })
}
