import json
from pathlib import Path

health = json.loads(Path("/tmp/kin-health.json").read_text())
print("health_ok", health.get("ok"), "status", health.get("status") or health.get("runtime"))

needles = {
    "/opt/kin-gateway/src/lib/admin/pricing.mjs": "export function normalizeUsage",
    "/opt/kin-gateway/src/lib/transport/go-worker-client.mjs": "export function usageFromSseEvent",
    "/opt/kin-gateway/src/lib/admin/vm-test-chat.mjs": "function beginTestLog",
    "/opt/kin-gateway/src/server.mjs": "requestLog,",
}
for path, needle in needles.items():
    text = Path(path).read_text()
    print(path, "OK" if needle in text else "MISSING")
