/**
 * Single seam for how the official Claude CLI is launched.
 * Production default is unchanged: `sudo -u kincli -E [ -- ] claude …`
 * Tests set KIN_CLI_LAUNCHER=direct (+ KIN_DISABLE_PRIVDROP=1) to skip sudo/chown/pkill.
 */
import { spawn as nodeSpawn } from 'node:child_process'

export function shouldPrivdrop(env = process.env) {
  if (env.KIN_DISABLE_PRIVDROP === '1' || env.KIN_DISABLE_PRIVDROP === 'true') return false
  if (env.KIN_CLI_LAUNCHER === 'direct') return false
  return true
}

/**
 * @param {{ style?: 'hop' | 'runner' }} opts
 *   hop    = `sudo -u kincli -E claude`      (client-cli-hop)
 *   runner = `sudo -u kincli -E -- claude`   (cli-runner / cli-probe)
 * @returns {{ cmd: string, argvPrefix: string[], privdrop: boolean }}
 */
export function resolveClaudeLauncher({ style = 'hop' } = {}, env = process.env) {
  const cli = env.CLAUDE_CLI_PATH || 'claude'
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

/** argv that will be passed to spawn(cmd, argv) for a Claude invocation. */
export function claudeSpawnSpec(args, { style = 'hop', env = process.env } = {}) {
  const l = resolveClaudeLauncher({ style }, env)
  return { cmd: l.cmd, argv: [...l.argvPrefix, ...args], privdrop: l.privdrop }
}

export function spawnClaudeProcess(args, spawnOpts, { style = 'hop', env = process.env } = {}) {
  const spec = claudeSpawnSpec(args, { style, env })
  return nodeSpawn(spec.cmd, spec.argv, spawnOpts)
}
