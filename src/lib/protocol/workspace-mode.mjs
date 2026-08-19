/**
 * Workspace ownership.
 *
 * client (default): tools / files / shell run on the caller's machine.
 *   Transport default is CRS HTTP (official Messages). CLI is fallback.
 * vm (opt-in): tools run inside the VM via the Claude Code process.
 *   Header: x-kin-workspace: vm
 */
export function resolveWorkspaceMode(req = {}, inbound = {}, clientClass = '') {
  const raw = String(
    req.headers?.['x-kin-workspace'] ||
    req.headers?.['x-kin-tool-exec'] ||
    inbound?.workspace ||
    '',
  ).trim().toLowerCase()
  if (raw === 'vm' || raw === 'server' || raw === 'slot') return 'vm'
  if (raw === 'client' || raw === 'local' || raw === 'host') return 'client'
  return 'client'
}

export function isOfficialClaudeClient(clientClass) {
  return clientClass === 'claude_code_official' || clientClass === 'claude_official_cli'
}
