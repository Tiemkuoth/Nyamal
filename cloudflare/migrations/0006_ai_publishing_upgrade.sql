ALTER TABLE ai_providers ADD COLUMN api_protocol TEXT NOT NULL DEFAULT 'openai-compatible';
ALTER TABLE ai_providers ADD COLUMN auth_header TEXT NOT NULL DEFAULT 'Authorization';
ALTER TABLE ai_providers ADD COLUMN auth_prefix TEXT NOT NULL DEFAULT 'Bearer ';
ALTER TABLE ai_providers ADD COLUMN model_list_path TEXT;
UPDATE ai_providers SET api_protocol='gemini',auth_header='x-goog-api-key',auth_prefix=''
WHERE kind='gemini';
ALTER TABLE ai_providers ADD COLUMN api_version TEXT;

ALTER TABLE ai_models ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE ai_models ADD COLUMN catalog_status TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE ai_models ADD COLUMN last_seen_at TEXT;
ALTER TABLE ai_models ADD COLUMN input_cost_per_million REAL;
ALTER TABLE ai_models ADD COLUMN output_cost_per_million REAL;

ALTER TABLE content_items ADD COLUMN category TEXT NOT NULL DEFAULT 'general';
ALTER TABLE content_items ADD COLUMN source_urls_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE content_items ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS publishing_policies (
  platform TEXT NOT NULL,
  category TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('manual','supervised','autonomous')),
  updated_by TEXT NOT NULL DEFAULT 'admin',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (platform, category)
);

CREATE TABLE IF NOT EXISTS content_publications (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  content_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('draft','awaiting_approval','approved','scheduled','queued','publishing','published','failed','rejected','cancelled')),
  scheduled_at TEXT,
  next_attempt_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  idempotency_key TEXT NOT NULL UNIQUE,
  remote_id TEXT,
  result_json TEXT,
  error_details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  UNIQUE (content_id, platform, content_version),
  FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_content_publications_due
  ON content_publications(status, scheduled_at, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_content_publications_content
  ON content_publications(content_id, content_version, platform);

CREATE TABLE IF NOT EXISTS publication_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id TEXT NOT NULL,
  content_version INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT,
  FOREIGN KEY (publication_id) REFERENCES content_publications(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_publication_approvals_item
  ON publication_approvals(publication_id, approved_at);

CREATE TABLE IF NOT EXISTS publication_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id TEXT NOT NULL,
  event TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (publication_id) REFERENCES content_publications(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_publication_events_item
  ON publication_events(publication_id, id);

INSERT OR IGNORE INTO content_publications
  (id,content_id,platform,content_version,status,scheduled_at,idempotency_key,published_at,result_json)
SELECT lower(hex(randomblob(16))),id,platform,1,
  CASE status
    WHEN 'awaiting_approval' THEN 'awaiting_approval'
    WHEN 'approved' THEN 'approved'
    WHEN 'queued' THEN 'queued'
    WHEN 'published' THEN 'published'
    WHEN 'rejected' THEN 'rejected'
    WHEN 'failed' THEN 'failed'
    WHEN 'cancelled' THEN 'cancelled'
    ELSE 'draft'
  END,
  scheduled_at,
  'legacy:' || id || ':' || platform,
  published_at,
  publish_result
FROM content_items
WHERE platform <> 'draft';
