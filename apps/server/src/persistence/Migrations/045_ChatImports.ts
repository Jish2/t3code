import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_imports (
      import_id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_key TEXT NOT NULL,
      external_id TEXT NOT NULL,
      project_key TEXT NOT NULL,
      source_path TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      status_updated_at TEXT NOT NULL,
      source_updated_at TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_synced_at TEXT NOT NULL,
      source_available INTEGER NOT NULL,
      sync_error TEXT,
      entry_count INTEGER NOT NULL,
      source_mtime_ms REAL NOT NULL,
      source_size INTEGER NOT NULL,
      content_digest TEXT NOT NULL,
      linked_thread_id TEXT,
      UNIQUE (source_kind, source_key)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_import_entries (
      import_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      entry_json TEXT NOT NULL,
      PRIMARY KEY (import_id, ordinal),
      FOREIGN KEY (import_id) REFERENCES chat_imports(import_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_chat_imports_status_updated
    ON chat_imports(status, source_updated_at DESC, import_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_chat_imports_source_external
    ON chat_imports(source_kind, external_id)
  `;
});
