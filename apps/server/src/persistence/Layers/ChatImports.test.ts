import { ChatImportId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ChatImportRepository } from "../Services/ChatImports.ts";
import { ChatImportRepositoryLive } from "./ChatImports.ts";

const layer = it.layer(ChatImportRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const id = ChatImportId.make("cursor:test-import");
const timestamp = "2026-09-01T12:00:00.000Z";

layer("ChatImportRepository", (it) => {
  it.effect("upserts content without changing the managed status", () =>
    Effect.gen(function* () {
      const repository = yield* ChatImportRepository;
      const first = yield* repository.upsertSnapshot({
        id,
        source: "cursor",
        sourceKey: "project/chat/chat.jsonl",
        externalId: "chat",
        projectKey: "project",
        sourcePath: "/tmp/chat.jsonl",
        title: "First title",
        sourceUpdatedAt: timestamp,
        firstSeenAt: timestamp,
        lastSyncedAt: timestamp,
        sourceMtimeMs: 1,
        sourceSize: 10,
        contentDigest: "first",
        linkedThreadId: null,
        entries: [
          {
            kind: "message",
            ordinal: 0,
            role: "user",
            blocks: [{ type: "text", text: "hello" }],
          },
        ],
      });
      assert.strictEqual(first.change, "discovered");

      const archived = yield* repository.setStatus({
        id,
        status: "archived",
        updatedAt: "2026-09-01T12:01:00.000Z",
      });
      assert.strictEqual(Option.getOrThrow(archived).status, "archived");

      const second = yield* repository.upsertSnapshot({
        id,
        source: "cursor",
        sourceKey: "project/chat/chat.jsonl",
        externalId: "chat",
        projectKey: "project",
        sourcePath: "/tmp/chat.jsonl",
        title: "Updated title",
        sourceUpdatedAt: "2026-09-01T12:02:00.000Z",
        firstSeenAt: timestamp,
        lastSyncedAt: "2026-09-01T12:02:00.000Z",
        sourceMtimeMs: 2,
        sourceSize: 20,
        contentDigest: "second",
        linkedThreadId: null,
        entries: [
          {
            kind: "message",
            ordinal: 0,
            role: "user",
            blocks: [{ type: "text", text: "hello again" }],
          },
        ],
      });
      assert.strictEqual(second.change, "updated");
      assert.strictEqual(second.summary.status, "archived");

      const detail = Option.getOrThrow(yield* repository.getById(id));
      assert.strictEqual(detail.title, "Updated title");
      assert.strictEqual(detail.status, "archived");
      assert.deepStrictEqual(detail.entries[0], {
        kind: "message",
        ordinal: 0,
        role: "user",
        blocks: [{ type: "text", text: "hello again" }],
      });
    }),
  );

  it.effect("hides imports linked to an existing native thread", () =>
    Effect.gen(function* () {
      const repository = yield* ChatImportRepository;
      const linkedId = ChatImportId.make("cursor:linked");
      yield* repository.upsertSnapshot({
        id: linkedId,
        source: "cursor",
        sourceKey: "project/linked/linked.jsonl",
        externalId: "linked",
        projectKey: "project",
        sourcePath: "/tmp/linked.jsonl",
        title: "Linked",
        sourceUpdatedAt: timestamp,
        firstSeenAt: timestamp,
        lastSyncedAt: timestamp,
        sourceMtimeMs: 1,
        sourceSize: 1,
        contentDigest: "linked",
        linkedThreadId: "thread-linked" as never,
        entries: [],
      });

      const listed = yield* repository.list({});
      assert.ok(listed.items.every((item) => item.id !== linkedId));
    }),
  );
});
