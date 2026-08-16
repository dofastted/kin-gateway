import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashKey } from './security.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PROJECT = path.resolve(ROOT, '..')

export function loadConfig() {
  const keyFile = path.join(ROOT, 'config', 'test.key')
  const apiKey = process.env.KIN_API_KEY || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : null)
  if (!apiKey) throw new Error('KIN_API_KEY not set')

  const active = JSON.parse(fs.readFileSync(path.join(PROJECT, 'vms', 'active.json'), 'utf8'))
  const vm = JSON.parse(fs.readFileSync(path.join(PROJECT, 'vms', `${active.active_vm}.json`), 'utf8'))

  const port = Number(process.env.PORT || 8787)
  const host = process.env.HOST || '0.0.0.0'
  const publicHost = process.env.PUBLIC_HOST || process.env.HOST || '127.0.0.1'

  const cfg = {
    port,
    host,
    public_host: publicHost,
    base_url: process.env.PUBLIC_BASE_URL || `${process.env.PUBLIC_SCHEME || 'http'}://${publicHost}${String(process.env.PUBLIC_SCHEME||'http')==='https' ? '' : ':'+port}`,
    api_key: apiKey,
    api_key_hash: hashKey(apiKey),
    // rewrite pipeline — DEFAULT OFF (passthrough preferred)
    rewrite: {
      enabled: process.env.KIN_REWRITE === '1' || process.env.KIN_REWRITE === 'true',
      model_map: false, // aliases disabled — official Claude names only
    },
    intercept: {
      // empty rules = no-op; rules can be loaded from config/intercept-rules.json
      rules: loadInterceptRules(path.join(ROOT, 'config', 'intercept-rules.json')),
    },
    limits: {
      max_body_bytes: Number(process.env.KIN_MAX_BODY || 2 * 1024 * 1024),
      upstream_timeout_ms: Number(process.env.KIN_UPSTREAM_TIMEOUT || 120000),
      rate_capacity: Number(process.env.KIN_RATE_CAP || 60),
      rate_refill: Number(process.env.KIN_RATE_REFILL || 1),
    },
    vm: {
      id: vm.id,
      name: vm.name,
      email: vm.claude?.email,
      account_uuid: vm.claude?.account_uuid || vm.id,
      org_uuid: vm.claude?.org_uuid || null,
      access_token: vm.claude?.access_token,
      proxy: vm.proxy || null,
      refresh_token: vm.claude?.refresh_token,
      expires_at: vm.claude?.expires_at,
      max_concurrency: vm.policy?.maxConcurrency || 2,
      claude_code_version: vm.claude_code_version || 'unknown',
      path: path.join(PROJECT, 'vms', `${vm.id}.json`),
    },
    paths: { root: ROOT, project: PROJECT, captures: path.join(ROOT, 'captures') },
  }
  return cfg
}

function loadInterceptRules(file) {
  try {
    if (!fs.existsSync(file)) return []
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(data) ? data : data.rules || []
  } catch {
    return []
  }
}

export function saveVmPatch(vmPath, patch) {
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  Object.assign(vm, patch)
  if (patch.claude_code_version) {
    vm.claude_code_version = patch.claude_code_version
    vm.claude_code_updated_at = new Date().toISOString()
  }
  fs.writeFileSync(vmPath, JSON.stringify(vm, null, 2), { mode: 0o600 })
  return vm
}
