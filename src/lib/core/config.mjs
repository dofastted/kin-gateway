import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashKey } from './security.mjs'
import { atomicWriteJson } from '../vm/vm-file.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// this file lives at src/lib/core/ — the gateway root is src/
const ROOT = path.resolve(__dirname, '..', '..')
const PROJECT = path.resolve(process.env.KIN_PROJECT_ROOT || path.resolve(ROOT, '..'))

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
    // Admin/status snapshot of the *active* VM only.
    // Inference must use buildExecutionContext() — never this object.
    vm: {
      id: vm.id,
      name: vm.name,
      email: vm.claude?.email,
      account_uuid: vm.claude?.account_uuid || vm.id,
      org_uuid: vm.claude?.org_uuid || null,
      has_access: !!(vm.claude?.has_access || vm.claude?.access_token),
      proxy: vm.proxy || null,
      has_refresh: !!(vm.claude?.has_refresh || vm.claude?.refresh_token),
      expires_at: vm.claude?.expires_at,
      refresh_error: vm.claude?.refresh_error || null,
      max_concurrency: vm.policy?.maxConcurrency || 2,
      claude_code_version: vm.claude_code_version || 'unknown',
      timezone: vm.timezone || 'UTC',
      locale: vm.locale || 'en_US.UTF-8',
      kernel: vm.kernel || null,
      seed_policy: vm.seed_policy || null,
      path: path.join(PROJECT, 'vms', `${vm.id}.json`),
    },
    paths: {
      root: ROOT,
      project: PROJECT,
      captures: process.env.KIN_CAPTURES_DIR || path.join(ROOT, 'captures'),
      data: process.env.KIN_DATA_DIR || path.join(ROOT, 'data'),
    },
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

export function hydrateVmCfg(cfg, vm, projectRoot = cfg.paths?.project) {
  if (!cfg || !vm) return cfg
  const root = projectRoot || path.dirname(path.dirname(cfg.vm?.path || ''))
  cfg.vm = {
    id: vm.id,
    name: vm.name,
    email: vm.claude?.email,
    account_uuid: vm.claude?.account_uuid || vm.id,
    org_uuid: vm.claude?.org_uuid || null,
    has_access: !!(vm.claude?.has_access || vm.claude?.access_token),
    proxy: vm.proxy || null,
    has_refresh: !!(vm.claude?.has_refresh || vm.claude?.refresh_token),
    expires_at: vm.claude?.expires_at,
    refresh_error: vm.claude?.refresh_error || null,
    max_concurrency: vm.policy?.maxConcurrency || 2,
    claude_code_version: vm.claude_code_version || 'unknown',
    timezone: vm.timezone || 'UTC',
    locale: vm.locale || 'en_US.UTF-8',
    kernel: vm.kernel || null,
    seed_policy: vm.seed_policy || null,
    path: path.join(root, 'vms', `${vm.id}.json`),
  }
  return cfg
}

export function reloadActiveVm(cfg) {
  const project = cfg.paths.project
  const id = JSON.parse(fs.readFileSync(path.join(project, 'vms', 'active.json'), 'utf8')).active_vm
  const vm = JSON.parse(fs.readFileSync(path.join(project, 'vms', `${id}.json`), 'utf8'))
  return hydrateVmCfg(cfg, vm, project)
}

export function saveVmPatch(vmPath, patch) {
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  Object.assign(vm, patch)
  if (patch.claude_code_version) {
    vm.claude_code_version = patch.claude_code_version
    vm.claude_code_updated_at = new Date().toISOString()
  }
  atomicWriteJson(vmPath, vm, { mode: 0o600 })
  return vm
}
