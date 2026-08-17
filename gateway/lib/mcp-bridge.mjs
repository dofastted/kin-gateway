#!/usr/bin/env node
/**
 * Stdio MCP server that does NOT execute tools.
 * tools/call is recorded to KIN_MCP_CALL_FILE and then hangs until the parent kills us.
 * The gateway returns that call to the HTTP client as official tool_use.
 */
import fs from 'node:fs'
import readline from 'node:readline'

function loadTools() {
  try {
    if (process.env.KIN_MCP_TOOLS_FILE && fs.existsSync(process.env.KIN_MCP_TOOLS_FILE)) {
      return JSON.parse(fs.readFileSync(process.env.KIN_MCP_TOOLS_FILE, 'utf8'))
    }
    if (process.env.KIN_MCP_TOOLS) return JSON.parse(process.env.KIN_MCP_TOOLS)
  } catch {}
  return []
}

const tools = Array.isArray(loadTools()) ? loadTools() : []
const callFile = process.env.KIN_MCP_CALL_FILE || ''

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function toMcpTool(t) {
  const name = t?.name || t?.function?.name
  if (!name) return null
  const description = t.description || t.function?.description || name
  const inputSchema = t.input_schema || t.inputSchema || t.function?.parameters || { type: 'object', properties: {} }
  return { name, description, inputSchema }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!String(line || '').trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method, params } = msg
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'kinclient', version: '1.0.0' },
      },
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: { tools: tools.map(toMcpTool).filter(Boolean) },
    })
    return
  }
  if (method === 'tools/call' || method === 'tools/callTool') {
    const rec = {
      name: params?.name,
      arguments: params?.arguments || params?.input || {},
      mcp_id: id,
      at: new Date().toISOString(),
    }
    try {
      if (callFile) fs.writeFileSync(callFile, JSON.stringify(rec), { mode: 0o600 })
    } catch {}
    // Block — parent captures tool_use from CLI stream and kills the hop.
    return
  }
  if (id != null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } })
  }
})
