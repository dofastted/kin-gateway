import { applyBetaPolicyToHeader, shouldPassContext1mByPolicy } from '../protocol/model-policy.mjs'
import { CONTEXT_1M_BETA } from '../protocol/context-1m.mjs'

/**
 * Store / replay official Claude Code headers (CRS claudeCodeHeadersService analog).
 * Never stores Authorization / x-api-key / cookies.
 *
 * context-1m-2025-08-07 (sub2api OAuth):
 *   - Official Claude Code: pass if matrix betas.pass_context_1m or fallback whitelist
 *   - Unofficial/mimic: never inject or replay
 *   - Other models: filter (Haiku 400; Opus/Fable use native window)
 */
import fs from "node:fs"
import path from "node:path"

const KEEP = [
  "user-agent",
  "anthropic-version",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
  "x-app",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-timeout",
  "x-stainless-helper-method",
  "x-claude-code-session-id",
  "accept-language",
  "sec-fetch-mode",
]

const DEFAULTS = {
  "user-agent": "claude-cli/2.1.234 (external, cli)",
  "anthropic-version": "2023-06-01",
  "x-app": "cli",
  "x-stainless-lang": "js",
  "x-stainless-os": "Linux",
  "x-stainless-arch": "x64",
  "x-stainless-runtime": "node",
  "x-stainless-package-version": "0.112.1",
}

/** Betas that must not be replayed for unofficial clients. */
const REPLAY_DROP_BETAS = new Set([
  CONTEXT_1M_BETA,
])

function lowerHeaders(h = {}) {
  const out = {}
  for (const [k, v] of Object.entries(h || {})) {
    if (v == null || v === "") continue
    out[String(k).toLowerCase()] = Array.isArray(v) ? v.join(",") : String(v)
  }
  return out
}

/**
 * Remove specific beta tokens from a comma-separated anthropic-beta header.
 * Mirrors sub2api stripBetaToken.
 */
export function stripBetaTokens(header, dropSet = REPLAY_DROP_BETAS) {
  if (!header || typeof header !== "string") return header
  const parts = header.split(",")
    .map((p) => p.trim())
    .filter((p) => p && !dropSet.has(p))
  return parts.join(",")
}

/** Official: strip unless the matrix / fallback whitelist says pass. Unofficial callers should always strip. */
export function shouldStripContext1m(model = "") {
  return !shouldPassContext1mByPolicy(model)
}

export function extractClaudeCodeHeaders(reqHeaders = {}) {
  const src = lowerHeaders(reqHeaders)
  const out = {}
  for (const k of KEEP) {
    if (src[k] != null) out[k] = src[k]
  }
  return out
}

export function isOfficialClaudeUa(ua = "") {
  return /^claude-cli\//i.test(String(ua || ""))
}

function headerFile(homeDir) {
  return path.join(homeDir, ".claude", "kin-cc-headers.json")
}

export function storeAccountHeaders(homeDir, reqHeaders = {}) {
  if (!homeDir) return { stored: false }
  const extracted = extractClaudeCodeHeaders(reqHeaders)
  if (!isOfficialClaudeUa(extracted["user-agent"] || "")) return { stored: false }
  try {
    fs.mkdirSync(path.dirname(headerFile(homeDir)), { recursive: true })
    fs.writeFileSync(headerFile(homeDir), JSON.stringify({
      headers: extracted,
      updated_at: new Date().toISOString(),
    }, null, 2))
    return { stored: true }
  } catch {
    return { stored: false }
  }
}

export function loadStoredHeaders(homeDir) {
  if (!homeDir) return null
  try {
    const d = JSON.parse(fs.readFileSync(headerFile(homeDir), "utf8"))
    return d?.headers && typeof d.headers === "object" ? d.headers : null
  } catch {
    return null
  }
}

function applyReplayBetaPolicy(headers, model = "", isOfficial = false) {
  if (!headers || typeof headers !== "object") return headers
  const beta = headers["anthropic-beta"] || ""
  let cleaned
  try {
    cleaned = applyBetaPolicyToHeader(beta, model, { isOfficial })
  } catch {
    const drop1m = !isOfficial || !shouldPassContext1mByPolicy(model)
    cleaned = drop1m ? stripBetaTokens(beta) : beta
  }
  if (cleaned === beta) return headers
  const next = { ...headers }
  if (cleaned) next["anthropic-beta"] = cleaned
  else delete next["anthropic-beta"]
  return next
}

/** VM characteristics are the only fingerprint. Protocol betas may come from official inbound. */
export function resolveVmCharacteristicHeaders(identity = {}, reqHeaders = {}, homeDir = "", model = "") {
  const incoming = extractClaudeCodeHeaders(reqHeaders)
  if (isOfficialClaudeUa(incoming["user-agent"] || "")) storeAccountHeaders(homeDir, reqHeaders)
  const stored = loadStoredHeaders(homeDir) || {}
  const fp = identity.fingerprint || {}
  const protocol = {}
  if (incoming["anthropic-version"]) protocol["anthropic-version"] = incoming["anthropic-version"]
  if (incoming["anthropic-beta"]) protocol["anthropic-beta"] = incoming["anthropic-beta"]
  if (incoming["anthropic-dangerous-direct-browser-access"]) {
    protocol["anthropic-dangerous-direct-browser-access"] = incoming["anthropic-dangerous-direct-browser-access"]
  }
  const base = {
    ...DEFAULTS,
    ...stored,
    ...protocol,
    "user-agent": identity.userAgent || stored["user-agent"] || DEFAULTS["user-agent"],
    "x-app": fp.x_app || "cli",
    "x-stainless-lang": fp.stainless_lang || stored["x-stainless-lang"] || DEFAULTS["x-stainless-lang"],
    "x-stainless-os": fp.stainless_os || DEFAULTS["x-stainless-os"],
    "x-stainless-arch": fp.stainless_arch || DEFAULTS["x-stainless-arch"],
    "x-stainless-runtime": fp.stainless_runtime || DEFAULTS["x-stainless-runtime"],
    "x-stainless-runtime-version": fp.stainless_runtime_version || stored["x-stainless-runtime-version"] || DEFAULTS["x-stainless-runtime-version"],
    "x-stainless-package-version": fp.stainless_package_version || stored["x-stainless-package-version"] || DEFAULTS["x-stainless-package-version"],
  }
  // Official inbound: pass context-1m only for whitelist models. Unofficial never replays it.
  if (isOfficialClaudeUa(incoming["user-agent"] || "")) return applyReplayBetaPolicy(base, model, true)
  return applyReplayBetaPolicy(base, model)
}

/** Official inbound headers win; unofficial clients replay last official set (with unsafe betas stripped). */
export function resolveCrsHeaders(reqHeaders = {}, homeDir = "", identity = null, model = "") {
  if (identity) return resolveVmCharacteristicHeaders(identity, reqHeaders, homeDir, model)
  const incoming = extractClaudeCodeHeaders(reqHeaders)
  if (isOfficialClaudeUa(incoming["user-agent"] || "")) {
    storeAccountHeaders(homeDir, reqHeaders)
    return applyReplayBetaPolicy({ ...DEFAULTS, ...incoming }, model, true)
  }
  const stored = loadStoredHeaders(homeDir) || {}
  const incomingSafe = { ...incoming }
  delete incomingSafe["user-agent"]
  const merged = { ...DEFAULTS, ...stored, ...incomingSafe }
  return applyReplayBetaPolicy(merged, model)
}
