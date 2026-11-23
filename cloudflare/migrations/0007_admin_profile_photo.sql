CREATE TABLE IF NOT EXISTS admin_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  display_name TEXT NOT NULL DEFAULT 'Administrator',
  photo_mime TEXT,
  photo_base64 TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO admin_profile(id,display_name) VALUES(1,'Administrator');
