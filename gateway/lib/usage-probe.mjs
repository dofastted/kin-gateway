/**
 * Account probe — VM official Claude Code only.
 * Gateway does not fetch Anthropic usage endpoints and does not spoof the CLI UA.
 */
import { probeVmFromOfficialCli } from './cli-probe.mjs'

export async function probeAccount({
  homeDir,
  accessToken = null,
  refreshToken = null,
  expiresAt = null,
  hop = false,
  hopReason = null,
  timeoutMs,
} = {}) {
  return probeVmFromOfficialCli({
    homeDir,
    accessToken,
    refreshToken,
    expiresAt,
    hop,
    hopReason,
    timeoutMs,
  })
}
