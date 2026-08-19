CREATE TABLE IF NOT EXISTS account_runtime_states (
  account_id TEXT PRIMARY KEY,
  vm_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  cooldown_until INTEGER,
  cooldown_reason TEXT,
  model_states_json TEXT,
  last_used_at INTEGER,
  credential_generation INTEGER NOT NULL DEFAULT 0,
  refresh_status TEXT,
  worker_heartbeat_at INTEGER,
  worker_status_json TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_runtime_vm ON account_runtime_states(vm_id);
CREATE INDEX IF NOT EXISTS idx_account_runtime_cooldown ON account_runtime_states(cooldown_until);

CREATE TABLE IF NOT EXISTS request_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  vm_id TEXT,
  account_id TEXT,
  model TEXT,
  selection_reason TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  upstream_status INTEGER,
  error_scope TEXT,
  action TEXT,
  cooldown_until INTEGER,
  downstream_committed INTEGER NOT NULL DEFAULT 0,
  terminal_state TEXT,
  usage_json TEXT,
  wait_ms INTEGER,
  ttft_ms INTEGER,
  latency_ms INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_request_attempt_unique ON request_attempts(request_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_request_attempt_request ON request_attempts(request_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_request_attempt_account ON request_attempts(account_id, started_at DESC);

ALTER TABLE request_logs ADD COLUMN attempt_count INTEGER;
ALTER TABLE request_logs ADD COLUMN final_state TEXT;
ALTER TABLE request_logs ADD COLUMN final_account_id TEXT;
