# kin-gateway

Multi-VM Claude Code forwarding gateway.

- Protocol: Anthropic Messages / OpenAI Chat / OpenAI Responses → VM-local official Claude Code (`claude -p`)
- Prepare: drop fields the CLI does not accept; append Pi/Codex/ChatGPT persona as official `system` text blocks; do not inject billing/identity (VM already is Claude Code)
- Seed policy: per-VM settings.json sole source, telemetry controls, client settings rejection
- Panel API under `/api/panel/*`

Do not commit real OAuth tokens or SOCKS credentials.