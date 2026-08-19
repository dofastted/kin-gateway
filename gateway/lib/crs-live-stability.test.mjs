/**
 * Live SOCKS5 + CRS HTTP stability.
 * Does not use slot OAuth. Does not write credential files.
 * Enable with KIN_LIVE_NET=1.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const LIVE = process.env.KIN_LIVE_NET === '1'
const UID = 10001
const GID = 987
const SERVER_IP = '166.88.96.199'
const ROUNDS = 5

function httpsText({ hostname, path = '/', method = 'GET', headers = {}, body = null, uid = UID, gid = GID, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import https from 'node:https'
      const spec = JSON.parse(process.env.KIN_SPEC)
      const req = https.request({
        hostname: spec.hostname,
        path: spec.path,
        method: spec.method,
        headers: spec.headers || {},
        timeout: spec.timeoutMs || 15000,
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          process.stdout.write(JSON.stringify({
            status: res.statusCode,
            ip: res.headers['x-forwarded-for'] || null,
            body: Buffer.concat(chunks).toString('utf8').slice(0, 400),
          }))
        })
      })
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', (e) => { console.error(e.message); process.exit(2) })
      if (spec.body) req.write(spec.body)
      req.end()
    `], {
      uid,
      gid,
      env: {
        ...process.env,
        KIN_SPEC: JSON.stringify({ hostname, path, method, headers, body, timeoutMs }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`uid-https exit ${code}: ${err || out}`))
      try { resolve(JSON.parse(out)) } catch (e) { reject(new Error(`bad json: ${out} ${err}`)) }
    })
  })
}

function credMtimes() {
  const files = [
    '/opt/kin-gateway/vms/vm-01/cli-home/.claude/credentials.json',
    '/opt/kin-gateway/vms/vm-01/cli-home/.claude/.credentials.json',
  ]
  const out = {}
  for (const f of files) {
    try { out[f] = fs.statSync(f).mtimeMs } catch { out[f] = null }
  }
  return out
}

test('uid 10001 HTTPS egress is SOCKS, not the VPS IP', { skip: !LIVE }, async () => {
  const ips = []
  const times = []
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = Date.now()
    const r = await httpsText({ hostname: 'api.ipify.org', path: '/', headers: { accept: 'text/plain' } })
    times.push(Date.now() - t0)
    const ip = String(r.body || '').trim()
    assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/, `round ${i} body=${r.body}`)
    assert.notEqual(ip, SERVER_IP)
    ips.push(ip)
  }
  assert.equal(new Set(ips).size, 1, `egress IPs drifted: ${ips.join(',')}`)
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  assert.ok(avg < 8000, `egress too slow avg=${avg}ms`)
  console.log(JSON.stringify({ socks_egress_ip: ips[0], rtt_ms: times, avg_ms: Math.round(avg) }))
})

test('uid 10001 HTTP to api.anthropic.com is stable (fake token, no cred write)', { skip: !LIVE }, async () => {
  const before = credMtimes()
  const statuses = []
  const times = []
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = Date.now()
    const r = await httpsText({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        authorization: 'Bearer sk-ant-oat01-INVALID-STABILITY-TEST',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })
    times.push(Date.now() - t0)
    statuses.push(r.status)
    assert.ok(r.status === 401 || r.status === 403, `round ${i} unexpected ${r.status} ${r.body}`)
  }
  const after = credMtimes()
  assert.deepEqual(after, before)
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  assert.equal(new Set(statuses).size, 1)
  console.log(JSON.stringify({ anthropic_http: { statuses, rtt_ms: times, avg_ms: Math.round(avg) } }))
})
