const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.5+, no install needed

// DB_PATH lets tests use ":memory:" while normal runs persist to data.db
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'data.db'));

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,       -- "salt:key" (scrypt), never the password itself
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,       -- SHA-256 of the cookie token
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL        -- unix time in ms
  );

  CREATE TABLE IF NOT EXISTS subjects (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    target  REAL NOT NULL DEFAULT 80
  );

  CREATE TABLE IF NOT EXISTS components (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    weight     REAL NOT NULL,          -- percent of the final grade
    score      REAL,                   -- NULL = not graded yet
    max_score  REAL NOT NULL DEFAULT 100
  );
`);

// Databases created before accounts existed have no subjects.user_id column.
// Add it so the app still starts; those old rows belong to nobody and stay hidden.
const subjectColumns = db.prepare('PRAGMA table_info(subjects)').all().map((c) => c.name);
if (!subjectColumns.includes('user_id')) {
  db.exec('ALTER TABLE subjects ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_subjects_user ON subjects(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_components_subject ON components(subject_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');

module.exports = db;
