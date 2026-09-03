import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_ChatImportCursorGeneration", (it) => {
  it.effect("repairs databases that recorded the original continuation migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 45 });
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
        CREATE TABLE chat_import_synced_turns (
          import_id TEXT NOT NULL,
          turn_index INTEGER NOT NULL,
          turn_hash TEXT NOT NULL,
          origin TEXT NOT NULL,
          PRIMARY KEY (import_id, turn_index),
          FOREIGN KEY (import_id) REFERENCES chat_imports(import_id) ON DELETE CASCADE
        )
      `;
      yield* sql`
        CREATE INDEX idx_chat_imports_linked_thread
        ON chat_imports(linked_thread_id)
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (46, 'ChatImportContinuation')
      `;

      yield* runMigrations();

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(chat_imports)
      `;
      assert.ok(columns.some((column) => column.name === "cursor_generation_id"));
      yield* sql`SELECT cursor_generation_id FROM chat_imports`;
    }),
  );
});
