# kin-gateway

Claude Code VM gateway — clients talk OpenAI/Anthropic-compatible APIs; upstream runs **only** through per-VM official `claude` CLI (no direct Anthropic HTTP from the gateway process).

## Features

- Protocol: `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/models`
- Upstream: VM-local Claude Code CLI (`stream-json` true streaming)
- Auth: `Authorization: Bearer` **or** `x-api-key` (RikkaHub / Anthropic clients)
- Anthropic SSE: official `event:` + `data:` frames (thinking passthrough)
- Sticky routing, account quota safety (95%), proxy pool (optional)
- Admin panel API + static console

## Quick start

```bash
cd gateway
npm install
export KIN_API_KEY=sk-kin-your-key
export KIN_ADMIN_USER=admin
export KIN_ADMIN_PASSWORD=change-me
export PORT=8787
export PUBLIC_BASE_URL=https://your.domain
# Point config at a VM credential directory (see vms/)
node server-v2.mjs
```

## Client config

| Client | Base URL | Auth |
|--------|----------|------|
| OpenAI-compatible | `https://your.domain/v1` | Bearer `KIN_API_KEY` |
| Anthropic / RikkaHub Claude | `https://your.domain/v1` | `x-api-key: KIN_API_KEY` |

Models: official Claude names only (e.g. `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`).

## Architecture

```
Client → kin-gateway (protocol + route)
      → VM home + OAuth
      → claude CLI (-p / stream-json)
      → Anthropic
```

Direct `fetch(api.anthropic.com)` from the gateway is **disabled** (`lib/upstream.mjs`).

## Version

`v0.3.0` — CLI-upstream + true stream + thinking passthrough + Anthropic SSE event field + x-api-key.

## License

Private / internal use unless otherwise stated.
