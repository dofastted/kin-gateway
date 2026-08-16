import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareForVmClaude, classifySystemText, remapCodexTools } from './prepare-cli.mjs'

test('strips official identity/billing, keeps official CWD + user', () => {
  const { prompt, decisions, body } = prepareForVmClaude({
    model: 'claude-sonnet-5',
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.233.bf9; cc_entrypoint=sdk-cli;' },
      { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
      { type: 'text', text: 'CWD: /tmp/cli-test\nDate: 2026-08-16' },
    ],
    messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
  })
  assert.match(prompt, /CWD: \/tmp\/cli-test/)
  assert.match(prompt, /Reply with exactly: pong/)
  assert.doesNotMatch(prompt, /x-anthropic-billing-header/)
  assert.doesNotMatch(prompt, /Claude Agent SDK/)
  assert.ok(decisions.some((d) => d.action === 'strip_official_identity'))
  assert.equal(body.system[0].type, 'text')
  assert.equal(body.system[0].cache_control.type, 'ephemeral')
})

test('strips official interactive-agent system, keeps CWD from Primary working directory', () => {
  const { prompt, decisions } = prepareForVmClaude({
    model: 'claude-sonnet-5',
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.233.bf9; cc_entrypoint=sdk-cli;' },
      { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
      {
        type: 'text',
        text: 'You are an interactive agent that helps users with software engineering tasks. Use the instructions below.\n\n# Environment\n - Primary working directory: /tmp/cli-cc\n',
      },
    ],
    messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
    tools: [{ name: 'Bash' }, { name: 'Read' }],
  })
  assert.match(prompt, /CWD: \/tmp\/cli-cc/)
  assert.match(prompt, /Reply with exactly: pong/)
  assert.doesNotMatch(prompt, /interactive agent that helps users/)
  assert.doesNotMatch(prompt, /x-anthropic-billing-header/)
  assert.ok(decisions.some((d) => d.action === 'strip_official_identity'))
  assert.ok(decisions.some((d) => d.action === 'drop_client_tools'))
  assert.ok(prompt.length < 400)
})

test('Pi 人设 becomes official system block + CWD, not deleted', () => {
  const { prompt, decisions, body } = prepareForVmClaude({
    model: 'claude-sonnet-5',
    system: [
      {
        type: 'text',
        text: 'You are an expert coding assistant operating inside pi, a coding agent harness.\nCurrent working directory: /tmp/pi-verify',
      },
    ],
    messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
    thinking: { type: 'enabled' },
    tools: [{ name: 'read_file' }],
  })
  assert.match(prompt, /operating inside pi/)
  assert.match(prompt, /CWD: \/tmp\/pi-verify/)
  assert.match(prompt, /Reply with exactly: pong/)
  assert.doesNotMatch(prompt, /x-anthropic-billing-header/)
  assert.ok(decisions.some((d) => d.action === 'append_persona_as_official_system'))
  assert.ok(decisions.some((d) => d.action === 'append_official_cwd'))
  assert.ok(body.system.every((b) => b.type === 'text' && b.cache_control?.type === 'ephemeral'))
  assert.ok(decisions.some((d) => d.action === 'drop_client_tools'))
})

test('benign context is appended as official system field', () => {
  const { prompt, body } = prepareForVmClaude({
    model: 'claude-sonnet-5',
    system: 'Repo is at /work/app. Use tests first.',
    messages: [{ role: 'user', content: 'fix the bug' }],
  })
  assert.match(prompt, /Repo is at \/work\/app/)
  assert.match(prompt, /fix the bug/)
  assert.doesNotMatch(prompt, /\[Context\]/)
  assert.doesNotMatch(prompt, /You are Claude Code/)
  assert.equal(body.system[0].type, 'text')
  assert.equal(body.system[0].cache_control.type, 'ephemeral')
})

test('classify', () => {
  assert.equal(classifySystemText('x-anthropic-billing-header: cc_version=1'), 'official')
  assert.equal(classifySystemText('CWD: /tmp/x\nDate: 2026-08-16'), 'official_cwd')
  assert.equal(classifySystemText('operating inside pi, a coding agent harness'), 'foreign_identity')
  assert.equal(classifySystemText('You are an interactive agent that helps users with software engineering tasks. MORE'), 'official')
  assert.equal(classifySystemText('Use the repo at /tmp/app'), 'keep')
})

test('codex tool remap', () => {
  const out = remapCodexTools([{ name: 'apply_patch' }, { function: { name: 'read_file' } }])
  assert.equal(out[0].name, 'Bash')
  assert.equal(out[1].function.name, 'Read')
})
