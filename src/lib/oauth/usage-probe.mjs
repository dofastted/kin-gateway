/**
 * Account probe — VM UID only (CRS oauth/usage + fable).
 * Gateway process never calls Anthropic.
 */
import { probeVmUsage } from './crs-usage-probe.mjs'

export async function probeAccount(opts = {}) {
  if (opts && typeof opts === 'object' && (opts.exec || opts.homeDir || opts.vm)) {
    const exec = opts.exec || {
      vmId: opts.vm?.id,
      homeDir: opts.homeDir,
      oauth: opts.vm?.claude || { access_token: opts.accessToken },
      vm: opts.vm,
    }
    return probeVmUsage({
      exec,
      includeFable: opts.includeFable !== false,
      timeoutMs: opts.timeoutMs,
      identity: opts.identity || null,
    })
  }
  return {
    ok: false,
    source: 'vm-oauth-usage',
    error: 'probe_requires_vm_exec',
    probed_at: new Date().toISOString(),
  }
}
