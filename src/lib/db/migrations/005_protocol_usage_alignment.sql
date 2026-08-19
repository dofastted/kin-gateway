-- 005_protocol_usage_alignment — align persisted protocol data with the
-- Sub2API usage_logs / account window model (additive columns only).

-- Per-request usage detail (sub2api usage_logs counterpart)
ALTER TABLE request_logs ADD COLUMN cache_creation_5m_tokens INTEGER;
ALTER TABLE request_logs ADD COLUMN cache_creation_1h_tokens INTEGER;
ALTER TABLE request_logs ADD COLUMN requested_model TEXT;
ALTER TABLE request_logs ADD COLUMN upstream_model TEXT;
ALTER TABLE request_logs ADD COLUMN model_mismatch INTEGER;
ALTER TABLE request_logs ADD COLUMN first_token_ms INTEGER;
ALTER TABLE request_logs ADD COLUMN stop_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_reqlog_requested_model ON request_logs(requested_model);

-- Cache token aggregation for dashboards (accounts / managed keys)
ALTER TABLE accounts ADD COLUMN cache_read_tokens INTEGER DEFAULT 0;
ALTER TABLE accounts ADD COLUMN cache_creation_tokens INTEGER DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN cache_read_tokens INTEGER DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN cache_creation_tokens INTEGER DEFAULT 0;

-- Structured account rate-limit / session window state
-- (sub2api account.rate_limited_at / rate_limit_reset_at / overload_until /
--  session_window_start / session_window_end / session_window_status)
ALTER TABLE account_runtime_states ADD COLUMN rate_limited_at INTEGER;
ALTER TABLE account_runtime_states ADD COLUMN rate_limit_reset_at INTEGER;
ALTER TABLE account_runtime_states ADD COLUMN overload_until INTEGER;
ALTER TABLE account_runtime_states ADD COLUMN session_window_start INTEGER;
ALTER TABLE account_runtime_states ADD COLUMN session_window_end INTEGER;
ALTER TABLE account_runtime_states ADD COLUMN session_window_status TEXT;
