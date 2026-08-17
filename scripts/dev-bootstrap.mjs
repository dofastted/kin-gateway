#!/usr/bin/env node
/**
 * Local development bootstrap for kin-gateway.
 *
 * Provisions the minimal runtime state the gateway needs to boot locally:
 *   - gateway/config/test.key  (dev KIN_API_KEY, gitignored)
 *   - vms/active.json          (points at the dev seed VM)
 *   - vms/<id>.json            (a seed VM record with no OAuth credentials)
 *
 * It is idempotent: existing files are left untouched. Real Anthropic
 * credentials are never created here — import a sessionKey via the panel
 * (POST /api/panel/vms/import) or the console "导入" page to enable live
 * inference forwarding.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = path.resolve(__dirname, '..')
const GATEWAY = path.join(PROJECT, 'gateway')

const DEV_VM_ID = process.env.KIN_DEV_VM_ID || 'vm-dev-local'
const DEV_API_KEY = process.env.KIN_API_KEY || 'sk-kin-dev-local-key'

function ensureApiKey() {
  const keyFile = path.join(GATEWAY, 'config', 'test.key')
  if (fs.existsSync(keyFile)) return keyFile
  fs.mkdirSync(path.dirname(keyFile), { recursive: true })
  fs.writeFileSync(keyFile, DEV_API_KEY, { mode: 0o600 })
  console.log('[bootstrap] wrote dev API key ->', keyFile)
  return keyFile
}

function ensureDevVm() {
  const vmsDir = path.join(PROJECT, 'vms')
  fs.mkdirSync(vmsDir, { recursive: true })
  const vmPath = path.join(vmsDir, `${DEV_VM_ID}.json`)
  if (!fs.existsSync(vmPath)) {
    const now = new Date().toISOString()
    const vm = {
      id: DEV_VM_ID,
      name: 'Dev seed VM',
      status: 'running',
      kernel: 'unikernel-min',
      timezone: 'UTC',
      locale: 'en_US.UTF-8',
      note: 'Local dev seed. No OAuth — import a sessionKey to enable forwarding.',
      proxy: null,
      policy: { maxConcurrency: 2, weight: 1, inflight: 0 },
      claude: {},
      fingerprint: {
        device_id: crypto.randomUUID(),
        session_id: crypto.randomUUID(),
      },
      stats: {},
      claude_code_version: process.env.KIN_DEV_CC_VERSION || 'dev',
      created_at: now,
      updated_at: now,
      schedulable: true,
      schedule_disabled_reason: null,
      seed_policy: {
        telemetry_disabled: true,
        disable_nonessential_traffic: true,
        do_not_track: true,
        reject_client_settings: true,
        reject_client_metadata_identity: true,
        theme: 'dark',
        extra_env: {},
        settings_json_override: null,
      },
    }
    fs.writeFileSync(vmPath, JSON.stringify(vm, null, 2))
    console.log('[bootstrap] created dev seed VM ->', vmPath)
  }

  const activePath = path.join(vmsDir, 'active.json')
  if (!fs.existsSync(activePath)) {
    fs.writeFileSync(
      activePath,
      JSON.stringify({ active_vm: DEV_VM_ID, updated_at: new Date().toISOString() }, null, 2),
    )
    console.log('[bootstrap] set active VM ->', DEV_VM_ID)
  }
}

ensureApiKey()
ensureDevVm()
console.log('[bootstrap] ready. Start gateway: node gateway/server-v2.mjs')
