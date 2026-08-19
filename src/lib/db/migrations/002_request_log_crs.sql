ALTER TABLE request_logs ADD COLUMN via TEXT;
ALTER TABLE request_logs ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE request_logs ADD COLUMN cache_creation_tokens INTEGER;
