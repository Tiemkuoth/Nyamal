ALTER TABLE integrations ADD COLUMN app_secret_enc TEXT;
ALTER TABLE integrations ADD COLUMN verify_token_enc TEXT;

CREATE TABLE IF NOT EXISTS inbound_messages (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  text TEXT NOT NULL,
  business_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inbound_messages_pending
  ON inbound_messages(status, next_attempt_at, received_at);
