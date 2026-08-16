# kin-gateway

Multi-VM Claude Code protocol gateway.

## Run

```bash
export KIN_API_KEY=sk-kin-...
export PORT=8787
export HOST=0.0.0.0
node gateway/server-v2.mjs
```

## API

- `POST /v1/messages` Anthropic (passthrough)
- `POST /v1/chat/completions` OpenAI
- `POST /v1/responses` Responses
- `GET /api/panel/*` admin panel

## Auth

`Authorization: Bearer <KIN_API_KEY>`

## Console

Legacy: `GET /console`
