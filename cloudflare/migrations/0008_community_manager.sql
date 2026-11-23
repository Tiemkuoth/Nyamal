CREATE TABLE IF NOT EXISTS community_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO community_settings(id, settings_json)
VALUES (1, '{"autonomy_level":3,"welcome_enabled":true,"welcome_message":"Welcome, {name}! 👋 We’re glad you’re here. I’m Nyamal, the AI community assistant. {community}","community_description":"","community_rules":"","knowledge_base":"","telegram_group_replies":"mention_only","social_auto_replies":true,"link_protection":true,"trusted_domains":[],"blocked_domains":[],"auto_delete_blocked_telegram_links":false,"notify_admin":true,"max_auto_replies_per_sender_per_hour":6}');

CREATE TABLE IF NOT EXISTS community_incidents (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('moderation','response','escalation')),
  risk TEXT NOT NULL CHECK (risk IN ('safe','suspicious','high_risk','confirmed_malicious','sensitive')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','dismissed','deleted','failed')),
  reason TEXT NOT NULL,
  message_text TEXT NOT NULL DEFAULT '',
  proposed_response TEXT,
  sender_id TEXT,
  community_id TEXT,
  message_id TEXT,
  action TEXT NOT NULL DEFAULT 'none',
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_community_incidents_review
  ON community_incidents(status, created_at DESC);

CREATE TABLE IF NOT EXISTS community_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_id TEXT,
  remote_id TEXT,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_community_activity_recent
  ON community_activity(created_at DESC, event_type);
