/**
 * Single seam for how the official Claude CLI is launched.
 * Docker runtime: exec inside the per-VM container (host network).
 * Env is passed via `docker exec -e` — spawn env does not enter the guest.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { containerName } from './vm-runtime.mjs'

const PASS_ENV = [
  'TZ', 'LANG', 'LC_ALL',
  'MAX_THINKING_TOKENS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_DISABLE_AUTOUPDATE',
  'DO_NOT_TRACK', 'DISABLE_TELEMETRY',
  'CI', 'NO_COLOR', 'TERM',
  'KIN_CLIENT_CWD', 'KIN_CLIENT_OS', 'KIN_CLIENT_HOME',
  'KIN_CLIENT_USER', 'KIN_CLIENT_HOSTNAME', 'KIN_CLIENT_ARCH',
]

export function shouldPrivdrop(env = process.env) {
  if (env.KIN_DISABLE_PRIVDROP === '1' || env.KIN_DISABLE_PRIVDROP === 'true') return false
  if (env.KIN_CLI_LAUNCHER === 'direct') return false
  if (env.KIN_VM_RUNTIME === 'docker') return false
  return true
}

function containerFromHome(homeDir) {
  const m = String(homeDir || '').match(/\/vms\/(vm-[^/]+)\//)
  if (m) return containerName(m[1])
  return null
}

function dockerExecPrefix(env = process.env) {
  const prefix = [
    'exec', '-i',
    '-w', '/home/kincli',
    '-e', 'HOME=/home/kincli',
    '-e', 'CLAUDE_HOME=/home/kincli',
    '-e', 'CLAUDE_CONFIG_DIR=/home/kincli/.claude',
    '-e', 'PATH=/usr/local/lib/nodejs/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  ]
  for (const key of PASS_ENV) {
    if (env[key] == null || env[key] === '') continue
    prefix.push('-e', `${key}=${env[key]}`)
  }
  return prefix
}

export function resolveClaudeLauncher({ style = 'hop', homeDir = null } = {}, env = process.env) {
  const cli = env.CLAUDE_CLI_PATH || 'claude'
  if (env.KIN_VM_RUNTIME === 'docker') {
    const cname = env.KIN_VM_CONTAINER || containerFromHome(homeDir) || containerFromHome(env.HOME || env.CLAUDE_HOME)
    if (cname) {
      return {
        cmd: 'docker',
        argvPrefix: [...dockerExecPrefix(env), cname, cli === '/usr/bin/claude' ? 'claude' : cli],
        privdrop: false,
        container: cname,
      }
    }
  }
  if (!shouldPrivdrop(env)) {
    if (/\.(mjs|cjs|js)$/i.test(cli)) {
      return { cmd: process.execPath, argvPrefix: [cli], privdrop: false }
    }
    return { cmd: cli, argvPrefix: [], privdrop: false }
  }
  if (style === 'runner') {
    return { cmd: 'sudo', argvPrefix: ['-u', 'kincli', '-E', '--', 'claude'], privdrop: true }
  }
  return { cmd: 'sudo', argvPrefix: ['-u', 'kincli', '-E', 'claude'], privdrop: true }
}

export function claudeSpawnSpec(args, { style = 'hop', env = process.env, homeDir = null } = {}) {
  const l = resolveClaudeLauncher({ style, homeDir: homeDir || env.HOME || env.CLAUDE_HOME }, env)
  return { cmd: l.cmd, argv: [...l.argvPrefix, ...args], privdrop: l.privdrop, container: l.container || null }
}

export function spawnClaudeProcess(args, spawnOpts, { style = 'hop', env = process.env } = {}) {
  const merged = { ...env, ...(spawnOpts?.env || {}) }
  const homeDir = merged.HOME || merged.CLAUDE_HOME
  const spec = claudeSpawnSpec(args, { style, env: merged, homeDir })
  return nodeSpawn(spec.cmd, spec.argv, spawnOpts)
}
