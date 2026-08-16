# kin-gateway

Multi-VM Claude Code forwarding gateway.

- Protocol: Anthropic Messages / OpenAI Chat / OpenAI Responses → VM-local Claude Code CLI
- Seed policy: per-VM settings.json sole source, telemetry controls, client settings rejection
- Panel API under `/api/panel/*`

Do not commit real OAuth tokens or SOCKS credentials.
