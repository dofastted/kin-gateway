# kin-gateway

Multi-VM Claude Code forwarding gateway (text-completion proxy).

- Protocol: Anthropic Messages / OpenAI Chat / OpenAI Responses → host CLI slot (`sudo -u kincli claude -p`)
- Per-request `ExecutionContext`: scheduled VM, cli-home, OAuth, optional SOCKS (only if `proxy_cli_enabled`), quota account
- Auth: sessionKey import (Chrome TLS) → official CLI owns refresh; gateway harvests (`gateway/OAUTH.md`)
- Prepare: drop client tools / images; flatten system+messages to a single `-p` prompt; append Pi/Codex persona as official `system` text blocks
- Capabilities are honest: no client tool loop, no images, no Claude `session_id` resume, kernel is metadata-only
- Seed policy: per-VM settings.json sole source, telemetry controls, client settings rejection
- Panel API under `/api/panel/*`

Do not commit real API keys, OAuth tokens, or SOCKS credentials. Set `KIN_API_KEY` (or host-local `gateway/config/test.key`). Rotate any key that was ever committed.
