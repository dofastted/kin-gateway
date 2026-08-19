/**
 * OpenAI image_url content parts → Claude image content blocks
 */

export function openaiImagePartToClaude(part) {
  // OpenAI: { type: 'image_url', image_url: { url: 'data:image/png;base64,...' | 'https://...' } }
  if (!part || part.type !== 'image_url') return null
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
  if (!url) return null

  if (url.startsWith('data:')) {
    const m = url.match(/^data:([^;]+);base64,(.+)$/s)
    if (!m) return null
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: m[1] || 'image/png',
        data: m[2],
      },
    }
  }

  // remote URL — Claude supports type:url on some endpoints
  return {
    type: 'image',
    source: {
      type: 'url',
      url,
    },
  }
}

/** Convert OpenAI message content (string | array) to Claude content (string | blocks) */
export function openaiContentToClaudeContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')

  const blocks = []
  for (const p of content) {
    if (typeof p === 'string') {
      if (p) blocks.push({ type: 'text', text: p })
      continue
    }
    if (p?.type === 'text' || p?.type === 'input_text') {
      blocks.push({ type: 'text', text: p.text || '' })
      continue
    }
    if (p?.type === 'image_url') {
      const img = openaiImagePartToClaude(p)
      if (img) blocks.push(img)
      continue
    }
  }

  // pure text → keep as string for simplicity
  if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text
  if (!blocks.length) return ''
  return blocks
}
