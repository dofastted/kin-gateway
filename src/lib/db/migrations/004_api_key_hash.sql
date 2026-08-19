ALTER TABLE api_keys ADD COLUMN key_hash TEXT;
ALTER TABLE api_keys ADD COLUMN key_prefix TEXT;
ALTER TABLE api_keys ADD COLUMN key_suffix TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash) WHERE key_hash IS NOT NULL;
