-- 006_official_billing — persist Anthropic official-standard cost per request
-- (sub2api usage_logs.total_cost counterpart). Additive columns only.

ALTER TABLE request_logs ADD COLUMN input_cost REAL;
ALTER TABLE request_logs ADD COLUMN output_cost REAL;
ALTER TABLE request_logs ADD COLUMN cache_read_cost REAL;
ALTER TABLE request_logs ADD COLUMN cache_creation_cost REAL;
ALTER TABLE request_logs ADD COLUMN total_cost REAL;
ALTER TABLE request_logs ADD COLUMN pricing_model TEXT;
CREATE INDEX IF NOT EXISTS idx_reqlog_account ON request_logs(account_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_reqlog_cost_ts ON request_logs(ts DESC);
