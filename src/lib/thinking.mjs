/**
 * OpenAI reasoning ↔ Claude thinking mapping
 * Only for official Claude models that support thinking.
 */

const EFFORT_TO_BUDGET = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 32768,
}

export function openaiReasoningToClaudeThinking(body) {
  // OpenAI: reasoning_effort | reasoning: { effort }
  let effort = body.reasoning_effort
  if (!effort && body.reasoning && typeof body.reasoning === 'object') {
    effort = body.reasoning.effort
  }
  if (!effort) return null

  const e = String(effort).toLowerCase()
  if (e === 'none' || e === 'off') {
    return { type: 'disabled' }
  }

  const budget = EFFORT_TO_BUDGET[e]
  if (budget) {
    return { type: 'enabled', budget_tokens: budget }
  }
  // unknown effort → medium
  return { type: 'enabled', budget_tokens: EFFORT_TO_BUDGET.medium }
}

export function claudeThinkingToOpenAIReasoning(claude) {
  // Extract thinking text blocks if present
  const texts = []
  for (const b of claude.content || []) {
    if (b.type === 'thinking' && b.thinking) texts.push(b.thinking)
    if (b.type === 'redacted_thinking') texts.push('[redacted_thinking]')
  }
  if (!texts.length) return null
  return texts.join('\n')
}
