/**
 * Claude Code version update for a VM *slot* (JSON + optional host npm).
 * Default is simulated: this control plane is not a guest hypervisor.
 * Set KIN_REAL_CC_UPDATE=1 to run `npm i -g @anthropic-ai/claude-code@ver` on the host.
 */
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { saveVmPatch } from './config.mjs'

const REGISTRY = 'https://registry.npmjs.org/@anthropic-ai/claude-code'

export async function fetchLatestClaudeCodeVersion() {
  const res = await fetch(REGISTRY)
  if (!res.ok) throw new Error(`npm registry ${res.status}`)
  const data = await res.json()
  return data['dist-tags']?.latest || null
}

export async function updateVmClaudeCode(vmPath, { version = 'latest' } = {}) {
  let target = version
  if (!target || target === 'latest') {
    target = await fetchLatestClaudeCodeVersion()
    if (!target) throw new Error('could not resolve latest claude-code version')
  }

  const real = process.env.KIN_REAL_CC_UPDATE === '1'
  const steps = [
    { step: 'resolve_version', status: 'ok', version: target },
  ]

  if (real) {
    const cmd = spawnSync('npm', ['install', '-g', `@anthropic-ai/claude-code@${target}`], {
      encoding: 'utf8',
      timeout: 180_000,
    })
    steps.push({
      step: 'install',
      status: cmd.status === 0 ? 'ok' : 'error',
      command: `npm install -g @anthropic-ai/claude-code@${target}`,
      stderr: String(cmd.stderr || '').slice(0, 400),
    })
    if (cmd.status !== 0) {
      throw new Error(`host npm install failed: ${(cmd.stderr || cmd.stdout || '').slice(0, 300)}`)
    }
    steps.push({ step: 'verify', status: 'ok', expected: target, scope: 'host' })
  } else {
    steps.push({ step: 'download_package', status: 'skipped', reason: 'simulated' })
    steps.push({
      step: 'install',
      status: 'simulated',
      command: `npm install -g @anthropic-ai/claude-code@${target}`,
      note: 'set KIN_REAL_CC_UPDATE=1 to install on the host; there is no guest VM',
    })
    steps.push({ step: 'verify', status: 'skipped', expected: target })
  }

  const status = real ? 'success' : 'simulated'
  const previous = (() => {
    try { return JSON.parse(fs.readFileSync(vmPath, 'utf8'))?.claude_code_version || null } catch { return null }
  })()

  const vm = saveVmPatch(vmPath, {
    claude_code_version: target,
    claude_code_update: {
      last_result: status,
      simulated: !real,
      steps,
      at: new Date().toISOString(),
    },
  })

  return {
    vm_id: vm.id,
    previous_version: previous,
    version: target,
    steps,
    status,
    simulated: !real,
  }
}
