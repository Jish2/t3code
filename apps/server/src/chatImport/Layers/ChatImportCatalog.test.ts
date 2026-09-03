// @effect-diagnostics preferSchemaOverJson:off
import {
  ChatImportConflictError,
  ChatImportId,
  ChatImportSourceBusyError,
  CommandId,
  MessageId,
  type OrchestrationThread,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { layerTest as serverConfigLayerTest } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandIdConflictError } from "../../orchestration/Errors.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ChatImportRepositoryLive } from "../../persistence/Layers/ChatImports.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  type ProviderSessionRuntime,
  ProviderSessionRuntimeRepository,
} from "../../persistence/ProviderSessionRuntime.ts";
import { ChatImportRepository } from "../../persistence/Services/ChatImports.ts";
import { ChatImportCatalog } from "../Services/ChatImportCatalog.ts";
import { ChatImportSource } from "../Services/ChatImportSource.ts";
import { parseCursorTranscript } from "../CursorTranscriptParser.ts";
import { ChatImportCatalogLive } from "./ChatImportCatalog.ts";

const importId = ChatImportId.make("cursor:catalog-test");
const nativeThreadId = ThreadId.make("native-thread");
const timestamp = "2026-09-01T12:00:00.000Z";
const dispatchedCommands: Array<{ readonly type: string; readonly messages?: unknown }> = [];
const upsertedRuntimes: Array<
  Parameters<ProviderSessionRuntimeRepository["Service"]["upsert"]>[0]
> = [];
let runtimeByThread = Option.none<ProviderSessionRuntime>();
let projectedMessages: Array<{
  readonly id?: string;
  readonly role: string;
  readonly text: string;
}> = [
  { role: "user", text: "Earlier question" },
  { role: "assistant", text: "Earlier answer" },
];
let projectedActivities: Array<{ readonly kind: string; readonly payload: unknown }> = [];
let sourcePathAvailable = true;
let currentImportId = importId;
let currentExternalId = "session";
let currentSourceKey = "project/session/session.jsonl";
let currentSourcePath = "/tmp/session.jsonl";
let sourceVersion = 1;
let sourceTranscript = [
  JSON.stringify({ role: "user", message: { content: "Earlier question" } }),
  JSON.stringify({ role: "assistant", message: { content: "Earlier answer" } }),
  JSON.stringify({ type: "turn_ended", status: "success" }),
].join("\n");
let listedRuntimes: ReadonlyArray<ProviderSessionRuntime> = [
  {
    threadId: nativeThreadId,
    providerName: "cursor",
    providerInstanceId: null,
    adapterKey: "cursor",
    runtimeMode: "full-access",
    status: "stopped",
    lastSeenAt: timestamp,
    resumeCursor: { schemaVersion: 1, sessionId: "session" },
    runtimePayload: null,
  },
];
let adoptionThreadId: ThreadId | null = null;
let adoptionThreadExists = false;
let adoptionProjectAvailable = false;
let failAdoptionCreateOnce = false;

function selectIsolatedSource(suffix: string): ChatImportId {
  const id = ChatImportId.make(`cursor:catalog-${suffix}`);
  currentImportId = id;
  currentExternalId = `session-${suffix}`;
  currentSourceKey = `project/${suffix}/${suffix}.jsonl`;
  currentSourcePath = `/tmp/${suffix}.jsonl`;
  return id;
}

const layer = it.layer(
  ChatImportCatalogLive.pipe(
    Layer.provideMerge(ChatImportRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
    Layer.provide(
      Layer.succeed(ChatImportSource, {
        source: "cursor",
        discover: Effect.sync(() =>
          sourcePathAvailable
            ? [
                {
                  id: currentImportId,
                  source: "cursor" as const,
                  sourceKey: currentSourceKey,
                  externalId: currentExternalId,
                  projectKey: "project",
                  sourcePath: currentSourcePath,
                  sourceUpdatedAt: timestamp,
                  sourceMtimeMs: sourceVersion,
                  sourceSize: sourceTranscript.length,
                },
              ]
            : [],
        ),
        describePath: (sourcePath) =>
          Effect.succeed(
            sourcePathAvailable && sourcePath === currentSourcePath
              ? {
                  id: currentImportId,
                  source: "cursor" as const,
                  sourceKey: currentSourceKey,
                  externalId: currentExternalId,
                  projectKey: "project",
                  sourcePath: currentSourcePath,
                  sourceUpdatedAt: timestamp,
                  sourceMtimeMs: sourceVersion,
                  sourceSize: sourceTranscript.length,
                }
              : null,
          ),
        load: (descriptor) =>
          Effect.succeed({
            ...descriptor,
            title: "Imported session",
            contentDigest: `digest-${sourceVersion}`,
            entries: parseCursorTranscript(sourceTranscript, "Imported session").entries,
          }),
        watch: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderSessionRuntimeRepository)({
        upsert: (runtime) =>
          Effect.sync(() => {
            upsertedRuntimes.push(runtime);
          }),
        getByThreadId: () => Effect.succeed(runtimeByThread),
        list: () => Effect.succeed(listedRuntimes),
        deleteByThreadId: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) => {
          dispatchedCommands.push(command);
          if (
            command.type === "thread.create" &&
            adoptionThreadId !== null &&
            command.threadId === adoptionThreadId
          ) {
            if (failAdoptionCreateOnce) {
              failAdoptionCreateOnce = false;
              return Effect.fail(
                new OrchestrationCommandIdConflictError({
                  commandId: command.commandId,
                  receiptAggregateKind: "thread",
                  receiptAggregateId: "interrupted-thread",
                  commandAggregateKind: "thread",
                  commandAggregateId: command.threadId,
                }),
              );
            }
            adoptionThreadExists = true;
          }
          return Effect.succeed({ sequence: 1 });
        },
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getProjectShellById: (projectId) =>
          Effect.succeed(
            adoptionProjectAvailable
              ? Option.some({
                  id: projectId,
                  workspaceRoot: "/tmp",
                } as never)
              : Option.none(),
          ),
        getThreadDetailById: (threadId) =>
          Effect.succeed(
            adoptionThreadId !== null && threadId === adoptionThreadId
              ? adoptionThreadExists
                ? Option.some({
                    id: threadId,
                    projectId: "adoption-project",
                    messages: [],
                    activities: [],
                    runtimeMode: "full-access",
                    interactionMode: "default",
                  } as unknown as OrchestrationThread)
                : Option.none()
              : Option.some({
                  messages: projectedMessages,
                  activities: projectedActivities,
                } as unknown as OrchestrationThread),
          ),
      }),
    ),
    Layer.provide(
      serverConfigLayerTest(process.cwd(), { prefix: "t3-chat-import-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

layer("ChatImportCatalog", (it) => {
  it.effect("links native Cursor sessions instead of showing duplicate imports", () =>
    Effect.gen(function* () {
      sourcePathAvailable = true;
      runtimeByThread = Option.none();
      projectedActivities = [];
      const catalog = yield* ChatImportCatalog;
      const refresh = yield* catalog.refresh;
      assert.strictEqual(refresh.discovered, 1);

      const list = yield* catalog.list({});
      assert.deepStrictEqual(list.items, []);
      assert.deepStrictEqual(list.counts, { inbox: 0, library: 0, archived: 0 });

      const detail = yield* catalog.get({ id: importId });
      assert.strictEqual(detail.linkedThreadId, nativeThreadId);
      assert.deepStrictEqual(dispatchedCommands, []);
      yield* catalog.refresh;
      assert.strictEqual(dispatchedCommands.length, 0);
    }),
  );

  it.effect("reserves a linked Cursor chat for only one T3 turn at a time", () =>
    Effect.gen(function* () {
      upsertedRuntimes.length = 0;
      sourcePathAvailable = true;
      runtimeByThread = Option.none();
      projectedActivities = [];
      const catalog = yield* ChatImportCatalog;
      yield* catalog.refresh;
      const makeCommand = (suffix: string) =>
        ({
          type: "thread.turn.start",
          commandId: CommandId.make(`command-${suffix}`),
          threadId: nativeThreadId,
          message: {
            messageId: MessageId.make(`message-${suffix}`),
            role: "user",
            text: `Prompt ${suffix}`,
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("cursor"),
            model: "auto",
          },
          titleSeed: `Prompt ${suffix}`,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: timestamp,
        }) as const;
      const first = makeCommand("first");
      const second = makeCommand("second");

      yield* catalog.prepareLinkedTurnStart(first);
      assert.deepStrictEqual(upsertedRuntimes, [
        {
          threadId: nativeThreadId,
          providerName: "cursor",
          providerInstanceId: ProviderInstanceId.make("cursor"),
          adapterKey: "cursor",
          runtimeMode: "full-access",
          status: "stopped",
          lastSeenAt: timestamp,
          resumeCursor: { schemaVersion: 1, sessionId: "session" },
          runtimePayload: {
            modelSelection: { instanceId: "cursor", model: "auto" },
            sharedCursorSession: true,
          },
        },
      ]);
      const error = yield* catalog.prepareLinkedTurnStart(second).pipe(Effect.flip);
      assert.instanceOf(error, ChatImportSourceBusyError);

      yield* catalog.cancelPreparedTurn(first);
      yield* catalog.prepareLinkedTurnStart(second);
      yield* catalog.cancelPreparedTurn(second);
    }),
  );

  it.effect("recovers a startup reservation that never reached orchestration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        sourcePathAvailable = true;
        runtimeByThread = Option.none();
        projectedActivities = [];
        const catalog = yield* ChatImportCatalog;
        const repository = yield* ChatImportRepository;
        yield* catalog.refresh;
        yield* repository.updateContinuation({
          id: importId,
          syncState: "t3-active",
          pendingT3UserText: "Unsent prompt",
          pendingT3MessageId: MessageId.make("message-before-crash"),
          pendingT3TurnIndex: 1,
        });

        yield* catalog.start;

        const recovered = yield* repository.getSourceRecordById(importId);
        assert.isTrue(Option.isSome(recovered));
        if (Option.isSome(recovered)) {
          assert.strictEqual(recovered.value.syncState, "idle");
          assert.strictEqual(recovered.value.pendingT3UserText, null);
          assert.strictEqual(recovered.value.pendingT3MessageId, null);
          assert.strictEqual(recovered.value.pendingT3TurnIndex, null);
        }
      }),
    ),
  );

  it.effect("recovers a failed provider turn by its reserved message id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        sourcePathAvailable = true;
        runtimeByThread = Option.none();
        const pendingMessageId = MessageId.make("message-provider-failed");
        projectedMessages = [
          { role: "user", text: "Earlier question" },
          { role: "assistant", text: "Earlier answer" },
          { id: pendingMessageId, role: "user", text: "Failed prompt" },
        ];
        projectedActivities = [
          {
            kind: "provider.turn.start.failed",
            payload: {
              messageId: pendingMessageId,
              reservationOutcome: "not-admitted",
            },
          },
        ];
        const catalog = yield* ChatImportCatalog;
        const repository = yield* ChatImportRepository;
        yield* catalog.refresh;
        yield* repository.updateContinuation({
          id: importId,
          syncState: "t3-active",
          pendingT3UserText: "Failed prompt",
          pendingT3MessageId: pendingMessageId,
          pendingT3TurnIndex: 1,
        });

        yield* catalog.start;

        const recovered = yield* repository.getSourceRecordById(importId);
        assert.isTrue(Option.isSome(recovered));
        if (Option.isSome(recovered)) {
          assert.strictEqual(recovered.value.syncState, "idle");
          assert.strictEqual(recovered.value.pendingT3MessageId, null);
        }
      }),
    ),
  );

  it.effect("retains an ambiguous provider failure for transcript reconciliation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        sourcePathAvailable = true;
        runtimeByThread = Option.none();
        const pendingMessageId = MessageId.make("message-provider-unknown");
        projectedMessages = [
          { role: "user", text: "Earlier question" },
          { role: "assistant", text: "Earlier answer" },
          { id: pendingMessageId, role: "user", text: "Ambiguous prompt" },
        ];
        projectedActivities = [
          {
            kind: "provider.turn.start.failed",
            payload: {
              messageId: pendingMessageId,
              reservationOutcome: "unknown",
            },
          },
        ];
        const catalog = yield* ChatImportCatalog;
        const repository = yield* ChatImportRepository;
        yield* catalog.refresh;
        yield* repository.updateContinuation({
          id: importId,
          syncState: "t3-active",
          pendingT3UserText: "Ambiguous prompt",
          pendingT3MessageId: pendingMessageId,
          pendingT3TurnIndex: 1,
        });

        yield* catalog.start;

        const retained = yield* repository.getSourceRecordById(importId);
        assert.isTrue(Option.isSome(retained));
        if (Option.isSome(retained)) {
          assert.strictEqual(retained.value.syncState, "t3-active");
          assert.strictEqual(retained.value.pendingT3MessageId, pendingMessageId);
        }
        yield* repository.updateContinuation({
          id: importId,
          syncState: "idle",
          pendingT3UserText: null,
          pendingT3MessageId: null,
          pendingT3TurnIndex: null,
        });
      }),
    ),
  );

  it.effect("recovers an interrupted unknown send after restart reconciliation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        sourcePathAvailable = true;
        const pendingMessageId = MessageId.make("message-provider-interrupted");
        projectedMessages = [
          { role: "user", text: "Earlier question" },
          { role: "assistant", text: "Earlier answer" },
          { id: pendingMessageId, role: "user", text: "Interrupted prompt" },
        ];
        projectedActivities = [
          {
            kind: "provider.turn.start.failed",
            payload: {
              messageId: pendingMessageId,
              reservationOutcome: "unknown",
            },
          },
        ];
        runtimeByThread = Option.some({
          threadId: nativeThreadId,
          providerName: "cursor",
          providerInstanceId: ProviderInstanceId.make("cursor"),
          adapterKey: "cursor",
          runtimeMode: "full-access",
          status: "stopped",
          lastSeenAt: timestamp,
          resumeCursor: { schemaVersion: 1, sessionId: "session" },
          runtimePayload: {
            sharedCursorSession: true,
            turnAdmissionPhase: "unknown",
          },
        });
        const catalog = yield* ChatImportCatalog;
        const repository = yield* ChatImportRepository;
        yield* catalog.refresh;
        yield* repository.updateContinuation({
          id: importId,
          syncState: "t3-active",
          pendingT3UserText: "Interrupted prompt",
          pendingT3MessageId: pendingMessageId,
          pendingT3TurnIndex: 1,
        });

        yield* catalog.start;

        const recovered = yield* repository.getSourceRecordById(importId);
        assert.isTrue(Option.isSome(recovered));
        if (Option.isSome(recovered)) {
          assert.strictEqual(recovered.value.syncState, "idle");
          assert.strictEqual(recovered.value.pendingT3MessageId, null);
        }
      }),
    ),
  );

  it.effect("retains unknown reservations when exact startup refresh fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        sourcePathAvailable = true;
        const pendingMessageId = MessageId.make("message-source-unavailable");
        projectedMessages = [
          { role: "user", text: "Earlier question" },
          { role: "assistant", text: "Earlier answer" },
          { id: pendingMessageId, role: "user", text: "Unavailable prompt" },
        ];
        projectedActivities = [
          {
            kind: "provider.turn.start.failed",
            payload: {
              messageId: pendingMessageId,
              reservationOutcome: "unknown",
            },
          },
        ];
        runtimeByThread = Option.some({
          threadId: nativeThreadId,
          providerName: "cursor",
          providerInstanceId: ProviderInstanceId.make("cursor"),
          adapterKey: "cursor",
          runtimeMode: "full-access",
          status: "stopped",
          lastSeenAt: timestamp,
          resumeCursor: { schemaVersion: 1, sessionId: "session" },
          runtimePayload: {
            sharedCursorSession: true,
            turnAdmissionPhase: "unknown",
          },
        });
        const catalog = yield* ChatImportCatalog;
        const repository = yield* ChatImportRepository;
        yield* catalog.refresh;
        yield* repository.updateContinuation({
          id: importId,
          syncState: "t3-active",
          pendingT3UserText: "Unavailable prompt",
          pendingT3MessageId: pendingMessageId,
          pendingT3TurnIndex: 1,
        });
        sourcePathAvailable = false;

        yield* catalog.start;

        const retained = yield* repository.getSourceRecordById(importId);
        assert.isTrue(Option.isSome(retained));
        if (Option.isSome(retained)) {
          assert.strictEqual(retained.value.sourceAvailable, false);
          assert.strictEqual(retained.value.pendingT3MessageId, pendingMessageId);
        }
        sourcePathAvailable = true;
        yield* repository.updateContinuation({
          id: importId,
          syncState: "idle",
          pendingT3UserText: null,
          pendingT3MessageId: null,
          pendingT3TurnIndex: null,
        });
      }),
    ),
  );

  it.effect("rejects a mismatched active provider binding before reserving", () =>
    Effect.gen(function* () {
      sourcePathAvailable = true;
      projectedMessages = [
        { role: "user", text: "Earlier question" },
        { role: "assistant", text: "Earlier answer" },
      ];
      projectedActivities = [];
      runtimeByThread = Option.some({
        threadId: nativeThreadId,
        providerName: "cursor",
        providerInstanceId: ProviderInstanceId.make("cursor"),
        adapterKey: "cursor",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: timestamp,
        resumeCursor: { schemaVersion: 1, sessionId: "different-session" },
        runtimePayload: null,
      });
      const catalog = yield* ChatImportCatalog;
      const repository = yield* ChatImportRepository;
      yield* catalog.refresh;
      const command = {
        type: "thread.turn.start",
        commandId: CommandId.make("command-conflict"),
        threadId: nativeThreadId,
        message: {
          messageId: MessageId.make("message-conflict"),
          role: "user",
          text: "Conflicting prompt",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "auto",
        },
        titleSeed: "Conflicting prompt",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: timestamp,
      } as const;

      const error = yield* catalog.prepareLinkedTurnStart(command).pipe(Effect.flip);
      assert.instanceOf(error, ChatImportConflictError);
      const record = yield* repository.getSourceRecordById(importId);
      assert.isTrue(Option.isSome(record));
      if (Option.isSome(record)) {
        assert.strictEqual(record.value.syncState, "conflict");
        assert.strictEqual(record.value.pendingT3MessageId, null);
      }
    }),
  );

  it.effect("detects a concurrent Cursor turn and can safely keep the T3 history", () =>
    Effect.gen(function* () {
      const isolatedImportId = selectIsolatedSource("concurrent-turn");
      const isolatedThreadId = ThreadId.make("concurrent-turn-thread");
      sourcePathAvailable = true;
      sourceTranscript = [
        JSON.stringify({ role: "user", message: { content: "Earlier question" } }),
        JSON.stringify({ role: "assistant", message: { content: "Earlier answer" } }),
        JSON.stringify({ type: "turn_ended", status: "success" }),
      ].join("\n");
      sourceVersion += 1;
      runtimeByThread = Option.none();
      listedRuntimes = [
        {
          threadId: isolatedThreadId,
          providerName: "cursor",
          providerInstanceId: null,
          adapterKey: "cursor",
          runtimeMode: "full-access",
          status: "stopped",
          lastSeenAt: timestamp,
          resumeCursor: { schemaVersion: 1, sessionId: currentExternalId },
          runtimePayload: null,
        },
      ];
      projectedMessages = [
        { role: "user", text: "Earlier question" },
        { role: "assistant", text: "Earlier answer" },
      ];
      projectedActivities = [];
      const catalog = yield* ChatImportCatalog;
      const repository = yield* ChatImportRepository;
      yield* catalog.refresh;
      const t3Command = {
        type: "thread.turn.start",
        commandId: CommandId.make("command-racing-turn"),
        threadId: isolatedThreadId,
        message: {
          messageId: MessageId.make("message-racing-turn"),
          role: "user",
          text: "T3 prompt",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "auto",
        },
        titleSeed: "T3 prompt",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: timestamp,
      } as const;
      yield* catalog.prepareLinkedTurnStart(t3Command);

      sourceTranscript = [
        sourceTranscript,
        JSON.stringify({ role: "user", message: { content: "Cursor raced this prompt" } }),
        JSON.stringify({ role: "assistant", message: { content: "Cursor response" } }),
        JSON.stringify({ type: "turn_ended", status: "success" }),
      ].join("\n");
      sourceVersion += 1;
      const refresh = yield* catalog.refresh;
      assert.strictEqual(refresh.failed, 1);
      const conflicted = Option.getOrThrow(yield* repository.getSourceRecordById(isolatedImportId));
      assert.strictEqual(conflicted.syncState, "conflict");
      assert.strictEqual(conflicted.pendingT3MessageId, t3Command.message.messageId);

      const resolution = yield* catalog.resolveConflict({
        id: isolatedImportId,
        resolution: "keep-t3",
      });
      assert.strictEqual(resolution.threadId, isolatedThreadId);
      const detached = Option.getOrThrow(yield* repository.getSourceRecordById(isolatedImportId));
      assert.strictEqual(detached.linkedThreadId, null);
      assert.strictEqual(detached.syncState, "idle");
      assert.deepStrictEqual(yield* repository.listSyncedTurns(isolatedImportId), []);
    }),
  );

  it.effect("projects a completed Cursor-side turn into the linked native thread", () =>
    Effect.gen(function* () {
      const isolatedImportId = selectIsolatedSource("cursor-side-turn");
      const isolatedThreadId = ThreadId.make("cursor-side-turn-thread");
      sourcePathAvailable = true;
      sourceTranscript = [
        JSON.stringify({ role: "user", message: { content: "Earlier question" } }),
        JSON.stringify({ role: "assistant", message: { content: "Earlier answer" } }),
        JSON.stringify({ type: "turn_ended", status: "success" }),
      ].join("\n");
      sourceVersion += 1;
      listedRuntimes = [
        {
          threadId: isolatedThreadId,
          providerName: "cursor",
          providerInstanceId: null,
          adapterKey: "cursor",
          runtimeMode: "full-access",
          status: "stopped",
          lastSeenAt: timestamp,
          resumeCursor: { schemaVersion: 1, sessionId: currentExternalId },
          runtimePayload: null,
        },
      ];
      runtimeByThread = Option.none();
      projectedMessages = [
        { role: "user", text: "Earlier question" },
        { role: "assistant", text: "Earlier answer" },
      ];
      projectedActivities = [];
      const catalog = yield* ChatImportCatalog;
      const repository = yield* ChatImportRepository;
      yield* catalog.refresh;
      const commandOffset = dispatchedCommands.length;

      sourceTranscript = [
        sourceTranscript,
        JSON.stringify({ role: "user", message: { content: "Cursor follow-up" } }),
        JSON.stringify({ role: "assistant", message: { content: "Cursor answer" } }),
        JSON.stringify({ type: "turn_ended", status: "success" }),
      ].join("\n");
      sourceVersion += 1;
      const refreshed = yield* catalog.refresh;
      assert.strictEqual(refreshed.updated, 1);
      assert.deepStrictEqual(
        dispatchedCommands.slice(commandOffset).map((command) => command.type),
        ["thread.history.append", "thread.turn.diff.complete"],
      );
      const synchronized = yield* repository.listSyncedTurns(isolatedImportId);
      assert.strictEqual(synchronized[1]?.origin, "cursor");
    }),
  );

  it.effect("catches up completed Cursor turns before reserving a T3 send", () =>
    Effect.gen(function* () {
      const isolatedImportId = selectIsolatedSource("pre-send-catch-up");
      const isolatedThreadId = ThreadId.make("pre-send-catch-up-thread");
      sourcePathAvailable = true;
      sourceTranscript = [
        JSON.stringify({ role: "user", message: { content: "Earlier question" } }),
        JSON.stringify({ role: "assistant", message: { content: "Earlier answer" } }),
        JSON.stringify({ type: "turn_ended", status: "success" }),
      ].join("\n");
      sourceVersion += 1;
      listedRuntimes = [
        {
          threadId: isolatedThreadId,
          providerName: "cursor",
          providerInstanceId: null,
          adapterKey: "cursor",
          runtimeMode: "full-access",
          status: "stopped",
          lastSeenAt: timestamp,
          resumeCursor: { schemaVersion: 1, sessionId: currentExternalId },
          runtimePayload: null,
        },
      ];
      runtimeByThread = Option.none();
      projectedMessages = [
        { role: "user", text: "Earlier question" },
        { role: "assistant", text: "Earlier answer" },
      ];
      projectedActivities = [];
      const catalog = yield* ChatImportCatalog;
      const repository = yield* ChatImportRepository;
      yield* catalog.refresh;
      const commandOffset = dispatchedCommands.length;
      sourceTranscript = [
        sourceTranscript,
        JSON.stringify({ role: "user", message: { content: "Cursor before T3" } }),
        JSON.stringify({ role: "assistant", message: { content: "Caught up" } }),
        JSON.stringify({ type: "turn_ended", status: "success" }),
      ].join("\n");
      sourceVersion += 1;
      const command = {
        type: "thread.turn.start",
        commandId: CommandId.make("command-after-catch-up"),
        threadId: isolatedThreadId,
        message: {
          messageId: MessageId.make("message-after-catch-up"),
          role: "user",
          text: "Now send from T3",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "auto",
        },
        titleSeed: "Now send from T3",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: timestamp,
      } as const;
      yield* catalog.prepareLinkedTurnStart(command);

      assert.deepStrictEqual(
        dispatchedCommands.slice(commandOffset).map((entry) => entry.type),
        ["thread.history.append", "thread.turn.diff.complete"],
      );
      const synchronized = yield* repository.listSyncedTurns(isolatedImportId);
      assert.strictEqual(synchronized[1]?.origin, "cursor");
      const reserved = Option.getOrThrow(yield* repository.getSourceRecordById(isolatedImportId));
      assert.strictEqual(reserved.pendingT3TurnIndex, 2);
      yield* catalog.cancelPreparedTurn(command);
    }),
  );

  it.effect("reconciles a completed shared Cursor turn before session release", () =>
    Effect.gen(function* () {
      const isolatedImportId = selectIsolatedSource("completed-t3-turn");
      const isolatedThreadId = ThreadId.make("completed-t3-turn-thread");
      sourcePathAvailable = true;
      sourceTranscript = [
        JSON.stringify({ role: "user", message: { content: "Earlier question" } }),
        JSON.stringify({ role: "assistant", message: { content: "Earlier answer" } }),
        JSON.stringify({ type: "turn_ended", status: "success" }),
      ].join("\n");
      sourceVersion += 1;
      listedRuntimes = [
        {
          threadId: isolatedThreadId,
          providerName: "cursor",
          providerInstanceId: null,
          adapterKey: "cursor",
          runtimeMode: "full-access",
          status: "stopped",
          lastSeenAt: timestamp,
          resumeCursor: { schemaVersion: 1, sessionId: currentExternalId },
          runtimePayload: null,
        },
      ];
      runtimeByThread = Option.none();
      projectedMessages = [
        { role: "user", text: "Earlier question" },
        { role: "assistant", text: "Earlier answer" },
      ];
      projectedActivities = [];
      const catalog = yield* ChatImportCatalog;
      const repository = yield* ChatImportRepository;
      yield* catalog.refresh;
      const command = {
        type: "thread.turn.start",
        commandId: CommandId.make("command-completed-t3-turn"),
        threadId: isolatedThreadId,
        message: {
          messageId: MessageId.make("message-completed-t3-turn"),
          role: "user",
          text: "Continue from T3",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "auto",
        },
        titleSeed: "Continue from T3",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: timestamp,
      } as const;
      yield* catalog.prepareLinkedTurnStart(command);
      sourceTranscript = [
        sourceTranscript,
        JSON.stringify({ role: "user", message: { content: "Continue from T3" } }),
        JSON.stringify({ role: "assistant", message: { content: "Completed response" } }),
        JSON.stringify({ type: "turn_ended", status: "success" }),
      ].join("\n");
      sourceVersion += 1;

      yield* catalog.reconcileLinkedTurnCompletion(isolatedThreadId);

      const reconciled = Option.getOrThrow(yield* repository.getSourceRecordById(isolatedImportId));
      assert.strictEqual(reconciled.pendingT3MessageId, null);
      assert.strictEqual(reconciled.syncState, "idle");
      const synchronized = yield* repository.listSyncedTurns(isolatedImportId);
      assert.strictEqual(synchronized[1]?.origin, "t3");
    }),
  );

  it.effect("retries a partial invisible adoption using the persisted thread link", () =>
    Effect.gen(function* () {
      const isolatedImportId = selectIsolatedSource("partial-adoption");
      sourcePathAvailable = true;
      sourceTranscript = [
        JSON.stringify({ role: "user", message: { content: "Earlier question" } }),
        JSON.stringify({ role: "assistant", message: { content: "Earlier answer" } }),
        JSON.stringify({ type: "turn_ended", status: "success" }),
      ].join("\n");
      sourceVersion += 1;
      listedRuntimes = [];
      runtimeByThread = Option.none();
      adoptionThreadId = ThreadId.make("adoption-thread");
      adoptionThreadExists = false;
      adoptionProjectAvailable = true;
      failAdoptionCreateOnce = true;
      const catalog = yield* ChatImportCatalog;
      const repository = yield* ChatImportRepository;
      yield* catalog.refresh;

      const first = {
        id: isolatedImportId,
        projectId: "adoption-project" as never,
        threadId: adoptionThreadId,
        messageId: MessageId.make("adoption-message-first"),
        text: "Continue from T3",
        createdAt: timestamp,
      };
      yield* catalog.adopt(first).pipe(Effect.flip);
      const partial = Option.getOrThrow(yield* repository.getSourceRecordById(isolatedImportId));
      assert.strictEqual(partial.linkedThreadId, adoptionThreadId);
      assert.strictEqual(partial.pendingT3MessageId, null);

      const retried = yield* catalog.adopt({
        ...first,
        threadId: ThreadId.make("ignored-retry-thread"),
        messageId: MessageId.make("adoption-message-retry"),
      });
      assert.strictEqual(retried.threadId, adoptionThreadId);
      assert.isTrue(adoptionThreadExists);
      const synchronized = yield* repository.listSyncedTurns(isolatedImportId);
      assert.strictEqual(synchronized.length, 1);
      assert.strictEqual(synchronized[0]?.turnIndex, 0);
      assert.strictEqual(synchronized[0]?.origin, "cursor");
      assert.strictEqual(
        dispatchedCommands.findLast((command) => command.type === "thread.turn.start")?.type,
        "thread.turn.start",
      );
    }),
  );

  it.effect("rejects adoption into a different local workspace", () =>
    Effect.gen(function* () {
      const isolatedImportId = selectIsolatedSource("wrong-workspace");
      sourcePathAvailable = true;
      sourceVersion += 1;
      listedRuntimes = [];
      runtimeByThread = Option.none();
      adoptionThreadId = ThreadId.make("wrong-workspace-thread");
      adoptionThreadExists = false;
      adoptionProjectAvailable = true;
      failAdoptionCreateOnce = false;
      const catalog = yield* ChatImportCatalog;
      const repository = yield* ChatImportRepository;
      yield* catalog.refresh;
      yield* repository.updateContinuation({
        id: isolatedImportId,
        workspaceRoots: ["/expected-workspace"],
      });

      const error = yield* catalog
        .adopt({
          id: isolatedImportId,
          projectId: "wrong-workspace-project" as never,
          threadId: adoptionThreadId,
          messageId: MessageId.make("wrong-workspace-message"),
          text: "Do not send",
          createdAt: timestamp,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "ChatImportOperationError");
      const record = Option.getOrThrow(yield* repository.getSourceRecordById(isolatedImportId));
      assert.strictEqual(record.linkedThreadId, null);
      assert.strictEqual(record.pendingT3MessageId, null);
    }),
  );

  it.effect("clears an unlinked validation conflict after a healthy source refresh", () =>
    Effect.gen(function* () {
      const isolatedImportId = selectIsolatedSource("unlinked-recovery");
      sourcePathAvailable = true;
      sourceVersion += 1;
      listedRuntimes = [];
      const catalog = yield* ChatImportCatalog;
      const repository = yield* ChatImportRepository;
      yield* catalog.refresh;
      yield* repository.updateContinuation({
        id: isolatedImportId,
        syncState: "conflict",
        pendingT3UserText: "Unsent",
        pendingT3MessageId: MessageId.make("unlinked-conflict-message"),
        pendingT3TurnIndex: 1,
      });

      yield* catalog.refresh;
      const recovered = Option.getOrThrow(yield* repository.getSourceRecordById(isolatedImportId));
      assert.strictEqual(recovered.syncState, "idle");
      assert.strictEqual(recovered.pendingT3MessageId, null);
    }),
  );
});
