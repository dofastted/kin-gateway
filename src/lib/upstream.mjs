/**
 * Direct Anthropic HTTP upstream is DISABLED.
 * All inference must go through lib/cli-runner.mjs (VM Claude Code CLI).
 */
export async function callClaudeUpstream() {
  throw new Error('DIRECT_UPSTREAM_DISABLED: use crs-relay (default) or callClaudeCli fallback')
}
export async function streamClaudeUpstream() {
  throw new Error('DIRECT_UPSTREAM_DISABLED: use streamClaudeCli from cli-runner.mjs')
}
