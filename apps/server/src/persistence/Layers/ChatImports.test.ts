import { ChatImportId, MessageId, ThreadId } from "@t3tools/contracts";
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

  it.effect("round-trips continuation state and synchronized turns", () =>
    Effect.gen(function* () {
      const repository = yield* ChatImportRepository;
      const continuationId = ChatImportId.make("cursor:continuation");
      const threadId = ThreadId.make("thread-continuation");
      yield* repository.upsertSnapshot({
        id: continuationId,
        source: "cursor",
        sourceKey: "project/continuation/continuation.jsonl",
        externalId: "continuation",
        projectKey: "project",
        sourcePath: "/tmp/continuation.jsonl",
        title: "Continuation",
        sourceUpdatedAt: timestamp,
        firstSeenAt: timestamp,
        lastSyncedAt: timestamp,
        sourceMtimeMs: 1,
        sourceSize: 1,
        contentDigest: "continuation",
        linkedThreadId: null,
        entries: [],
      });
      yield* repository.updateContinuation({
        id: continuationId,
        linkedThreadId: threadId,
        syncState: "t3-active",
        workspaceRoots: ["/tmp/project"],
        pendingT3UserText: "Continue",
        pendingT3MessageId: MessageId.make("pending-message"),
        pendingT3TurnIndex: 2,
        cursorGenerationId: "cursor-generation",
      });
      yield* repository.appendSyncedTurn(continuationId, {
        turnIndex: 1,
        turnHash: "hash-1",
        origin: "cursor",
      });
      yield* repository.appendSyncedTurn(continuationId, {
        turnIndex: 0,
        turnHash: "hash-0",
        origin: "t3",
      });

      const record = Option.getOrThrow(
        yield* repository.getSourceRecordByPath("/tmp/continuation.jsonl"),
      );
      assert.strictEqual(record.linkedThreadId, threadId);
      assert.strictEqual(record.syncState, "t3-active");
      assert.deepStrictEqual(record.workspaceRoots, ["/tmp/project"]);
      assert.strictEqual(record.pendingT3UserText, "Continue");
      assert.strictEqual(record.pendingT3MessageId, "pending-message");
      assert.strictEqual(record.pendingT3TurnIndex, 2);
      assert.strictEqual(record.cursorGenerationId, "cursor-generation");
      assert.deepStrictEqual(yield* repository.listSyncedTurns(continuationId), [
        { turnIndex: 0, turnHash: "hash-0", origin: "t3" },
        { turnIndex: 1, turnHash: "hash-1", origin: "cursor" },
      ]);
      yield* repository.clearSyncedTurns(continuationId);
      assert.deepStrictEqual(yield* repository.listSyncedTurns(continuationId), []);
      assert.isTrue(
        Option.isNone(
          yield* repository.reserveTurn({
            id: continuationId,
            pendingT3UserText: "Overtake",
            pendingT3MessageId: MessageId.make("overtaking-message"),
            pendingT3TurnIndex: 3,
          }),
        ),
      );
      yield* repository.updateContinuation({
        id: continuationId,
        syncState: "idle",
        pendingT3UserText: null,
        pendingT3MessageId: null,
        pendingT3TurnIndex: null,
      });
      assert.isTrue(
        Option.isSome(
          yield* repository.reserveTurn({
            id: continuationId,
            pendingT3UserText: "Reserved",
            pendingT3MessageId: MessageId.make("reserved-message"),
            pendingT3TurnIndex: 3,
          }),
        ),
      );
      assert.isTrue(
        Option.isNone(
          yield* repository.reserveTurn({
            id: continuationId,
            pendingT3UserText: "Second",
            pendingT3MessageId: MessageId.make("second-message"),
            pendingT3TurnIndex: 3,
          }),
        ),
      );
    }),
  );
});
