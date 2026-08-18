-- 001_init — KIN gateway persistent store (sub2api-inspired schema)

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT,
  key TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'active',
  max_concurrency INTEGER DEFAULT 2,
  quota_requests INTEGER DEFAULT 0,
  quota_used INTEGER DEFAULT 0,
  rpm INTEGER DEFAULT 0,
  expires_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  last_used_at TEXT,
  requests INTEGER DEFAULT 0,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  vm_id TEXT,
  email TEXT,
  max_concurrency INTEGER DEFAULT 2,
  requests INTEGER DEFAULT 0,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  unified_json TEXT,
  last_blocked_json TEXT,
  last_cli_rate_limit_json TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS account_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  at TEXT NOT NULL,
  source TEXT,
  util_5h REAL,
  util_7d REAL,
  status_5h TEXT,
  status_7d TEXT,
  claim TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alloc_account_at ON account_allocations(account_id, at DESC);

CREATE TABLE IF NOT EXISTS sticky_sessions (
  key TEXT PRIMARY KEY,
  account_id TEXT,
  vm_id TEXT,
  session_id TEXT,
  bound_at INTEGER,
  expires_at INTEGER,
  hits INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sticky_expires ON sticky_sessions(expires_at);

CREATE TABLE IF NOT EXISTS proxies (
  id TEXT PRIMARY KEY,
  scheme TEXT DEFAULT 'socks5',
  host TEXT,
  port INTEGER,
  username TEXT,
  password TEXT,
  url TEXT,
  status TEXT DEFAULT 'active',
  bound_vm_id TEXT,
  failures INTEGER DEFAULT 0,
  last_probe_at TEXT,
  last_probe_ok INTEGER,
  latency_ms INTEGER,
  disabled_reason TEXT,
  created_at TEXT,
  updated_at TEXT
);

-- VM records + OAuth credential mirror (write-through from vms/*.json)
CREATE TABLE IF NOT EXISTS vms (
  id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT,
  schedulable INTEGER DEFAULT 1,
  email TEXT,
  account_uuid TEXT,
  org_uuid TEXT,
  access_token TEXT,
  refresh_token TEXT,
  session_key TEXT,
  oauth_expires_at TEXT,
  oauth_source TEXT,
  proxy_id TEXT,
  claude_code_version TEXT,
  timezone TEXT,
  locale TEXT,
  vm_json TEXT NOT NULL,
  encrypted INTEGER DEFAULT 0,
  file_mtime_ms INTEGER,
  synced_at TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_vms_account ON vms(account_uuid);

-- Request logs — sub2api UsageLog counterpart (normal summaries)
CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  ts TEXT NOT NULL,
  log_mode TEXT,
  method TEXT,
  path TEXT,
  protocol TEXT,
  model TEXT,
  stream INTEGER,
  status INTEGER,
  duration_ms INTEGER,
  api_key_kind TEXT,
  api_key_id TEXT,
  vm_id TEXT,
  account_id TEXT,
  workspace TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  error_code TEXT,
  error_message TEXT,
  user_agent TEXT,
  ip TEXT,
  has_tools INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reqlog_ts ON request_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_reqlog_key ON request_logs(api_key_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_reqlog_vm ON request_logs(vm_id, ts DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reqlog_reqid ON request_logs(request_id);

-- Full redacted debug records (mode=debug only)
CREATE TABLE IF NOT EXISTS request_log_debug (
  request_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reqdbg_ts ON request_log_debug(ts DESC);

-- Backup records (sub2api BackupService counterpart)
CREATE TABLE IF NOT EXISTS backup_records (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind TEXT,
  status TEXT NOT NULL,
  file_path TEXT,
  file_name TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  db_bytes INTEGER,
  includes_json TEXT,
  error TEXT,
  note TEXT
);
