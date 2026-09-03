import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE chat_imports
    ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'idle'
  `;

  yield* sql`
    ALTER TABLE chat_imports
    ADD COLUMN workspace_roots_json TEXT NOT NULL DEFAULT '[]'
  `;

  yield* sql`
    ALTER TABLE chat_imports
    ADD COLUMN pending_t3_user_text TEXT
  `;

  yield* sql`
    ALTER TABLE chat_imports
    ADD COLUMN pending_t3_message_id TEXT
  `;

  yield* sql`
    ALTER TABLE chat_imports
    ADD COLUMN pending_t3_turn_index INTEGER
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_import_synced_turns (
      import_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      turn_hash TEXT NOT NULL,
      origin TEXT NOT NULL,
      PRIMARY KEY (import_id, turn_index),
      FOREIGN KEY (import_id) REFERENCES chat_imports(import_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_chat_imports_linked_thread
    ON chat_imports(linked_thread_id)
  `;
});
