import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  extractQuotedClaudeIds,
  isCatalogModelId,
  latestIdForFamily,
  resolveCliModel,
  setCliModelCatalogForTest,
  validateOfficialModel,
  fetchOfficialModels,
  clearModelsCache,
} from './models.mjs'

test('extractQuotedClaudeIds only keeps quoted CLI ids', () => {
  const buf = Buffer.from(
    'junk claude-sonnet-5.md "claude-sonnet-5" x "claude-opus-4-8" "claude-fable-5" "claude-haiku-4-5-20251001" "not-a-model" claude-haiku-',
    'utf8',
  )
  const ids = extractQuotedClaudeIds(buf).sort()
  assert.deepEqual(ids, [
    'claude-fable-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-8',
    'claude-sonnet-5',
  ])
})

test('isCatalogModelId rejects fragments', () => {
  assert.equal(isCatalogModelId('claude-sonnet-5'), true)
  assert.equal(isCatalogModelId('claude-3'), false)
  assert.equal(isCatalogModelId('claude-fable-5.md'), false)
  assert.equal(isCatalogModelId('claude-haiku-'), false)
})

test('alias resolves to latest non-fast CLI id', () => {
  const ids = ['claude-sonnet-4-6', 'claude-sonnet-5', 'claude-sonnet-5-fast', 'claude-opus-4-8', 'claude-opus-5']
  assert.equal(latestIdForFamily('sonnet', ids), 'claude-sonnet-5')
  assert.equal(latestIdForFamily('opus', ids), 'claude-opus-5')
  assert.equal(resolveCliModel('sonnet', ids).model, 'claude-sonnet-5')
  assert.equal(resolveCliModel('opus[1m]', ids).model, 'claude-opus-5[1m]')
})

test('validateOfficialModel only accepts CLI catalog', () => {
  setCliModelCatalogForTest([
    'claude-sonnet-5',
    'claude-opus-4-6',
    'claude-haiku-4-5-20251001',
    'claude-fable-5',
  ])
  assert.equal(validateOfficialModel('anthropic/claude-sonnet-5').ok, true)
  assert.equal(validateOfficialModel('anthropic/claude-sonnet-5').model, 'claude-sonnet-5')
  assert.equal(validateOfficialModel('openrouter/anthropic/claude-opus-4-6').model, 'claude-opus-4-6')
  assert.equal(validateOfficialModel('sonnet').model, 'claude-sonnet-5')
  assert.equal(validateOfficialModel('gpt-4o').ok, false)
  assert.equal(validateOfficialModel('claude-made-up-99').ok, false)
  assert.equal(validateOfficialModel('claude-opus-4-1').ok, false)
})

test('models module does not spoof Anthropic HTTP', () => {
  const src = fs.readFileSync(new URL('./models.mjs', import.meta.url), 'utf8')
  assert.equal(src.includes('api.anthropic.com'), false)
  assert.equal(src.includes('oauth-2025-04-20'), false)
  assert.equal(/user-agent.*claude-cli/.test(src), false)
})

test('fetchOfficialModels ignores tokens and reports CLI source', async () => {
  setCliModelCatalogForTest(['claude-haiku-4-5-20251001', 'claude-sonnet-5'])
  const r = await fetchOfficialModels('sk-should-be-ignored', { force: false })
  assert.equal(r.source, 'claude_cli_catalog')
  assert.equal(r.total, 2)
  assert.ok(r.data.some((m) => m.id === 'claude-sonnet-5'))
  clearModelsCache()
})
