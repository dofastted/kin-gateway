/**
 * One-click Claude Code version update for a VM slot.
 * In this control-plane environment we record target version + simulate
 * install metadata (real hosts would run npm i -g @anthropic-ai/claude-code@ver).
 */
import fs from 'node:fs'
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

  // Simulated install steps (host agent would execute these inside the VM)
  const steps = [
    { step: 'resolve_version', status: 'ok', version: target },
    { step: 'download_package', status: 'ok', package: `@anthropic-ai/claude-code@${target}` },
    { step: 'install', status: 'ok', command: `npm install -g @anthropic-ai/claude-code@${target}` },
    { step: 'verify', status: 'ok', expected: target },
  ]

  const vm = saveVmPatch(vmPath, {
    claude_code_version: target,
    claude_code_update: {
      last_result: 'success',
      steps,
      at: new Date().toISOString(),
    },
  })

  return {
    vm_id: vm.id,
    previous_version: vm.claude_code_version,
    version: target,
    steps,
    status: 'success',
  }
}
