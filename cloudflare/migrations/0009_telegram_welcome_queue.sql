CREATE TABLE IF NOT EXISTS telegram_welcome_batches (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  window_ends_at INTEGER NOT NULL,
  available_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('collecting','ready','processing','review','sent','failed','skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  rate_reserved INTEGER NOT NULL DEFAULT 0,
  rate_hour_start INTEGER,
  safe_to_retry INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_welcome_collecting_chat
  ON telegram_welcome_batches(chat_id) WHERE status='collecting';
CREATE INDEX IF NOT EXISTS idx_telegram_welcome_batches_due
  ON telegram_welcome_batches(status,window_ends_at,available_at);

CREATE TABLE IF NOT EXISTS telegram_welcome_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  batch_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  username TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  join_method TEXT NOT NULL
    CHECK (join_method IN ('organic','invite_link','group_invitation','admin_added','join_request','unknown')),
  joined_at INTEGER NOT NULL,
  update_id INTEGER NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('message','chat_member')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_telegram_welcome_member_history
  ON telegram_welcome_events(chat_id,user_id,joined_at);
CREATE INDEX IF NOT EXISTS idx_telegram_welcome_events_batch
  ON telegram_welcome_events(batch_id,id);

CREATE TABLE IF NOT EXISTS telegram_welcome_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  text TEXT NOT NULL,
  entities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  telegram_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(batch_id,sequence)
);
CREATE INDEX IF NOT EXISTS idx_telegram_welcome_deliveries_due
  ON telegram_welcome_deliveries(batch_id,status,retry_at);

CREATE TABLE IF NOT EXISTS telegram_welcome_rate_limits (
  chat_id TEXT NOT NULL,
  hour_start INTEGER NOT NULL,
  announcement_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(chat_id,hour_start)
);
