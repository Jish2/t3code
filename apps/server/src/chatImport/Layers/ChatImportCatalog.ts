import {
  ChatImportConflictError,
  ChatImportInvalidStatusTransitionError,
  ChatImportNotFoundError,
  ChatImportOperationError,
  ChatImportSourceBusyError,
  CheckpointRef,
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ChatImportAdoptInput,
  type ChatImportId,
  type ChatImportRefreshResult,
  type ChatImportStatus,
  type ChatImportSummary,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/ProviderSessionRuntime.ts";
import {
  ChatImportRepository,
  type ChatImportSourceRecord,
} from "../../persistence/Services/ChatImports.ts";
import { cursorTranscriptTurns, type CursorCompletedTurn } from "../CursorTranscriptParser.ts";
import { makeCursorHookBridge, type CursorHookEvent } from "../CursorHookBridge.ts";
import { ChatImportCatalog, type ChatImportCatalogShape } from "../Services/ChatImportCatalog.ts";
import { ChatImportSource, type ChatImportSourceDescriptor } from "../Services/ChatImportSource.ts";

const SAFETY_SYNC_INTERVAL = "15 minutes";
const WATCH_DEBOUNCE_MS = 350;
const BUSY_WAIT_ATTEMPTS = 120;
const BUSY_WAIT_INTERVAL = "500 millis";
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
const CURSOR_INSTANCE = ProviderInstanceId.make("cursor");
const CURSOR_MODEL = DEFAULT_MODEL_BY_PROVIDER[CURSOR_DRIVER] ?? "auto";
const isChatImportOperationError = Schema.is(ChatImportOperationError);
const isChatImportNotFoundError = Schema.is(ChatImportNotFoundError);
const isChatImportSourceBusyError = Schema.is(ChatImportSourceBusyError);
const isChatImportConflictError = Schema.is(ChatImportConflictError);

function operationError(operation: string, cause: unknown): ChatImportOperationError {
  return new ChatImportOperationError({
    operation,
    message: cause instanceof Error ? cause.message : `Failed to ${operation}`,
  });
}

function cursorSessionId(resumeCursor: unknown): string | null {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return null;
  }
  const sessionId = "sessionId" in resumeCursor ? resumeCursor.sessionId : null;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
}

function isAllowedTransition(from: ChatImportStatus, to: ChatImportStatus): boolean {
  return (
    from === to ||
    (from === "inbox" && (to === "library" || to === "archived")) ||
    (from === "library" && to === "archived") ||
    (from === "archived" && to === "library")
  );
}

function sameStringArray(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizedMessage(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function providerTurnAdmissionPhase(runtimePayload: unknown): "unknown" | "admitted" | null {
  if (
    runtimePayload === null ||
    typeof runtimePayload !== "object" ||
    Array.isArray(runtimePayload) ||
    !("turnAdmissionPhase" in runtimePayload)
  ) {
    return null;
  }
  return runtimePayload.turnAdmissionPhase === "unknown" ||
    runtimePayload.turnAdmissionPhase === "admitted"
    ? runtimePayload.turnAdmissionPhase
    : null;
}

function providerTurnStartFailure(activity: { readonly kind: string; readonly payload: unknown }): {
  readonly messageId: string;
  readonly reservationOutcome: "not-admitted" | "unknown" | "admitted";
} | null {
  if (
    activity.kind !== "provider.turn.start.failed" ||
    activity.payload === null ||
    typeof activity.payload !== "object" ||
    Array.isArray(activity.payload) ||
    !("messageId" in activity.payload)
  ) {
    return null;
  }
  if (typeof activity.payload.messageId !== "string") return null;
  return {
    messageId: activity.payload.messageId,
    reservationOutcome:
      "reservationOutcome" in activity.payload &&
      (activity.payload.reservationOutcome === "not-admitted" ||
        activity.payload.reservationOutcome === "admitted")
        ? activity.payload.reservationOutcome
        : "unknown",
  };
}

function firstUserText(turn: CursorCompletedTurn): string | null {
  return turn.messages.find((message) => message.role === "user")?.text ?? null;
}

function importedMessageId(
  importId: string,
  turn: CursorCompletedTurn,
  messageIndex: number,
): MessageId {
  return MessageId.make(
    `cursor-import:${importId}:${String(turn.index).padStart(10, "0")}:${turn.hash.slice(0, 16)}:${String(messageIndex).padStart(4, "0")}`,
  );
}

function importedMessageCreatedAt(
  baseCreatedAt: string,
  totalTurnCount: number,
  turnIndex: number,
  messageIndex: number,
): string {
  const baseTime = DateTime.toEpochMillis(DateTime.makeUnsafe(baseCreatedAt));
  const turnTime = baseTime - (totalTurnCount - turnIndex) * 1_000;
  return DateTime.formatIso(DateTime.makeUnsafe(turnTime + messageIndex));
}

export const ChatImportCatalogLive = Layer.effect(
  ChatImportCatalog,
  Effect.gen(function* () {
    const repository = yield* ChatImportRepository;
    const source = yield* ChatImportSource;
    const providerSessions = yield* ProviderSessionRuntimeRepository;
    const orchestration = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const config = yield* ServerConfig;
    const hookBridge = makeCursorHookBridge({
      stateDir: config.stateDir,
      platform: yield* HostProcessPlatform,
    });
    const changes = yield* PubSub.unbounded<{
      readonly summary: ChatImportSummary;
      readonly revision: number;
    }>();
    const revision = yield* Ref.make(0);
    const refreshLock = yield* Semaphore.make(1);
    const continuationLocks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const getContinuationLock = (key: string) =>
      SynchronizedRef.modifyEffect(continuationLocks, (current) => {
        const existing = current.get(key);
        if (existing !== undefined) {
          return Effect.succeed([existing, current] as const);
        }
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(current);
            next.set(key, semaphore);
            return [semaphore, next] as const;
          }),
        );
      });
    const withContinuationLock = <A, E, R>(
      key: string,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.flatMap(getContinuationLock(key), (semaphore) => semaphore.withPermit(effect));
    const runtimeContext = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(runtimeContext);
    const runPromise = Effect.runPromiseWith(runtimeContext);

    const readCounts = repository.list({ limit: 1 }).pipe(
      Effect.map((result) => result.counts),
      Effect.mapError((cause) => operationError("read chat import counts", cause)),
    );

    const publish = (summary: ChatImportSummary) =>
      Ref.updateAndGet(revision, (current) => current + 1).pipe(
        Effect.flatMap((nextRevision) =>
          PubSub.publish(changes, { summary, revision: nextRevision }),
        ),
        Effect.asVoid,
      );

    const list: ChatImportCatalogShape["list"] = (input) =>
      repository
        .list(input)
        .pipe(Effect.mapError((cause) => operationError("list chat imports", cause)));

    const get: ChatImportCatalogShape["get"] = (input) =>
      repository.getById(input.id).pipe(
        Effect.mapError((cause) => operationError("read chat import", cause)),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new ChatImportNotFoundError({
                  id: input.id,
                  message: `Chat import ${input.id} was not found`,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );

    const getLinked: ChatImportCatalogShape["getLinked"] = (input) =>
      repository.getSourceRecordByLinkedThreadId(input.threadId).pipe(
        Effect.map(Option.getOrNull),
        Effect.mapError((cause) => operationError("read linked Cursor chat", cause)),
      );

    const setStatus: ChatImportCatalogShape["setStatus"] = (input) =>
      Effect.gen(function* () {
        const existing = yield* get({ id: input.id });
        if (!isAllowedTransition(existing.status, input.status)) {
          return yield* new ChatImportInvalidStatusTransitionError({
            id: input.id,
            from: existing.status,
            to: input.status,
            message: `Cannot move a chat import from ${existing.status} to ${input.status}`,
          });
        }
        if (existing.status === input.status) {
          return existing;
        }
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        const updated = yield* repository
          .setStatus({
            id: input.id,
            status: input.status,
            updatedAt,
          })
          .pipe(
            Effect.mapError((cause) => operationError("update chat import status", cause)),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new ChatImportNotFoundError({
                      id: input.id,
                      message: `Chat import ${input.id} was not found`,
                    }),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          );
        yield* publish(updated);
        return updated;
      });

    const updateContinuation = (
      input: Parameters<ChatImportRepository["Service"]["updateContinuation"]>[0],
    ) =>
      repository.updateContinuation(input).pipe(
        Effect.mapError((cause) => operationError("update Cursor chat continuation", cause)),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new ChatImportNotFoundError({
                  id: input.id,
                  message: `Chat import ${input.id} was not found`,
                }),
              ),
            onSome: (summary) => publish(summary).pipe(Effect.as(summary)),
          }),
        ),
      );

    const reserveTurn = (input: Parameters<ChatImportRepository["Service"]["reserveTurn"]>[0]) =>
      repository.reserveTurn(input).pipe(
        Effect.mapError((cause) => operationError("reserve Cursor chat continuation", cause)),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(false),
            onSome: (summary) => publish(summary).pipe(Effect.as(true)),
          }),
        ),
      );

    const appendImportedTurn = (
      record: ChatImportSourceRecord,
      turn: CursorCompletedTurn,
      totalTurnCount: number,
      createdAt: string,
    ) => {
      const turnId = TurnId.make(`cursor-import:${record.id}:${turn.hash.slice(0, 24)}`);
      const messages = turn.messages.map((message, messageIndex) => ({
        messageId: importedMessageId(record.id, turn, messageIndex),
        role: message.role,
        text: message.text,
        createdAt: importedMessageCreatedAt(createdAt, totalTurnCount, turn.index, messageIndex),
      }));
      const activities: OrchestrationThreadActivity[] = turn.activities.map(
        (activity, activityIndex) => ({
          id: EventId.make(
            `cursor-import:${record.id}:${turn.hash.slice(0, 16)}:activity:${activityIndex}`,
          ),
          tone: "tool" as const,
          kind: activity.kind,
          summary: activity.summary,
          payload: activity.payload,
          turnId,
          createdAt: importedMessageCreatedAt(
            createdAt,
            totalTurnCount,
            turn.index,
            messages.length + activityIndex,
          ),
        }),
      );
      activities.push({
        id: EventId.make(`cursor-import:${record.id}:${turn.hash.slice(0, 16)}:completed`),
        tone: "info",
        kind: "cursor.external-turn.completed",
        summary: "Imported Cursor turn completed",
        payload: {
          source: "cursor",
          turnIndex: turn.index,
          turnHash: turn.hash,
          status: turn.status,
          historicalDiff: "unavailable",
        },
        turnId,
        createdAt: importedMessageCreatedAt(
          createdAt,
          totalTurnCount,
          turn.index,
          messages.length + activities.length,
        ),
      });
      const linkedThreadId = record.linkedThreadId;
      if ((messages.length === 0 && activities.length === 0) || linkedThreadId === null) {
        return Effect.void;
      }
      return Effect.gen(function* () {
        yield* orchestration.dispatch({
          type: "thread.history.append",
          commandId: CommandId.make(
            `cursor-import:${record.id}:turn:${turn.index}:${turn.hash.slice(0, 16)}`,
          ),
          threadId: linkedThreadId,
          turnId,
          messages,
          activities,
          createdAt,
        });
        yield* orchestration.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(
            `cursor-import:${record.id}:diff:${turn.index}:${turn.hash.slice(0, 16)}`,
          ),
          threadId: linkedThreadId,
          turnId,
          completedAt: activities.at(-1)?.createdAt ?? createdAt,
          checkpointRef: CheckpointRef.make(`cursor-import:${record.id}:${turn.hash.slice(0, 24)}`),
          status: "missing",
          files: [],
          ...(messages.findLast((message) => message.role === "assistant")
            ? {
                assistantMessageId: messages.findLast((message) => message.role === "assistant")!
                  .messageId,
              }
            : {}),
          checkpointTurnCount: turn.index + 1,
          createdAt,
        });
      }).pipe(
        Effect.mapError((cause) => operationError("append imported Cursor turn", cause)),
        Effect.asVoid,
      );
    };

    const syncLinkedHistory = (
      record: ChatImportSourceRecord,
      entries: Parameters<typeof cursorTranscriptTurns>[0],
      createdAt: string,
    ) =>
      Effect.gen(function* () {
        if (record.linkedThreadId === null) {
          return;
        }
        const turns = cursorTranscriptTurns(entries);
        const synchronized = yield* repository
          .listSyncedTurns(record.id)
          .pipe(
            Effect.mapError((cause) => operationError("read synchronized Cursor turns", cause)),
          );
        const prefixMatches =
          synchronized.length <= turns.completed.length &&
          synchronized.every(
            (turn, index) =>
              turn.turnIndex === index && turn.turnHash === turns.completed[index]?.hash,
          );
        if (!prefixMatches) {
          yield* updateContinuation({ id: record.id, syncState: "conflict" });
          return yield* new ChatImportConflictError({
            id: record.id,
            message:
              "Cursor rewrote previously synchronized history. Resolve the conflict before sending another message.",
          });
        }

        let pendingT3UserText = record.pendingT3UserText;
        let pendingT3MessageId = record.pendingT3MessageId;
        let pendingT3TurnIndex = record.pendingT3TurnIndex;
        for (const turn of turns.completed.slice(synchronized.length)) {
          const userMessages = turn.messages.filter((message) => message.role === "user");
          const userText = firstUserText(turn);
          const isPendingT3Turn =
            pendingT3UserText !== null &&
            pendingT3TurnIndex === turn.index &&
            userMessages.length === 1 &&
            userText !== null &&
            normalizedMessage(userText) === normalizedMessage(pendingT3UserText);
          if (
            pendingT3UserText !== null &&
            pendingT3TurnIndex !== null &&
            turn.index >= pendingT3TurnIndex &&
            !isPendingT3Turn
          ) {
            yield* updateContinuation({ id: record.id, syncState: "conflict" });
            return yield* new ChatImportConflictError({
              id: record.id,
              message:
                "Cursor added a different turn while T3 was sending. Resolve the conflict before continuing.",
            });
          }
          if (!isPendingT3Turn) {
            yield* appendImportedTurn(record, turn, turns.completed.length, createdAt);
          }
          yield* repository
            .appendSyncedTurn(record.id, {
              turnIndex: turn.index,
              turnHash: turn.hash,
              origin: isPendingT3Turn ? "t3" : "cursor",
            })
            .pipe(
              Effect.mapError((cause) => operationError("record synchronized Cursor turn", cause)),
            );
          if (isPendingT3Turn) {
            pendingT3UserText = null;
            pendingT3MessageId = null;
            pendingT3TurnIndex = null;
          }
        }

        const nextState =
          pendingT3UserText !== null
            ? "t3-active"
            : record.cursorGenerationId !== null || turns.hasIncompleteTail
              ? "cursor-active"
              : "idle";
        if (
          record.syncState !== nextState ||
          pendingT3UserText !== record.pendingT3UserText ||
          pendingT3MessageId !== record.pendingT3MessageId ||
          pendingT3TurnIndex !== record.pendingT3TurnIndex
        ) {
          yield* updateContinuation({
            id: record.id,
            syncState: nextState,
            pendingT3UserText,
            pendingT3MessageId,
            pendingT3TurnIndex,
          });
        }
      });

    const baselineExistingNativeHistory = (
      record: ChatImportSourceRecord,
      entries: Parameters<typeof cursorTranscriptTurns>[0],
    ) =>
      Effect.gen(function* () {
        if (record.linkedThreadId === null) return;
        const thread = Option.getOrUndefined(
          yield* projections
            .getThreadDetailById(record.linkedThreadId)
            .pipe(Effect.mapError((cause) => operationError("read linked native history", cause))),
        );
        if (!thread || thread.messages.length === 0) return;
        const canonicalMessages = thread.messages.filter(
          (message) => message.role === "user" || message.role === "assistant",
        );
        const turns = cursorTranscriptTurns(entries);
        let canonicalIndex = 0;
        for (const turn of turns.completed) {
          const matches = turn.messages.every((message) => {
            const canonical = canonicalMessages[canonicalIndex];
            if (
              canonical === undefined ||
              canonical.role !== message.role ||
              normalizedMessage(canonical.text) !== normalizedMessage(message.text)
            ) {
              return false;
            }
            canonicalIndex += 1;
            return true;
          });
          if (!matches) return;
          yield* repository
            .appendSyncedTurn(record.id, {
              turnIndex: turn.index,
              turnHash: turn.hash,
              origin: "t3",
            })
            .pipe(
              Effect.mapError((cause) =>
                operationError("baseline synchronized Cursor turn", cause),
              ),
            );
        }
      });

    const refreshDescriptor = (
      descriptor: ChatImportSourceDescriptor,
      options?: {
        readonly workspaceRoots?: ReadonlyArray<string>;
        readonly linkedThreadBySessionId?: ReadonlyMap<string, ThreadId>;
      },
    ) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const existing = Option.getOrUndefined(
          yield* repository
            .getSourceRecordById(descriptor.id)
            .pipe(
              Effect.mapError((cause) => operationError("read Cursor transcript metadata", cause)),
            ),
        );
        const linkedThreadId =
          existing?.linkedThreadId ??
          options?.linkedThreadBySessionId?.get(descriptor.externalId) ??
          null;
        const workspaceRoots = options?.workspaceRoots ?? existing?.workspaceRoots ?? [];
        const metadataUnchanged =
          existing !== undefined &&
          existing.sourceAvailable &&
          existing.sourceMtimeMs === descriptor.sourceMtimeMs &&
          existing.sourceSize === descriptor.sourceSize &&
          existing.linkedThreadId === linkedThreadId;

        let change: "discovered" | "updated" | "unchanged" = "unchanged";
        if (!metadataUnchanged) {
          const result = yield* source.load(descriptor).pipe(
            Effect.flatMap((loaded) =>
              repository.upsertSnapshot({
                ...loaded,
                firstSeenAt: existing?.firstSeenAt ?? now,
                lastSyncedAt: now,
                linkedThreadId,
              }),
            ),
            Effect.mapError((cause) => operationError("load Cursor transcript", cause)),
          );
          change = result.change;
          if (result.change !== "unchanged") {
            yield* publish(result.summary);
          }
        }

        let current = Option.getOrUndefined(
          yield* repository
            .getSourceRecordById(descriptor.id)
            .pipe(
              Effect.mapError((cause) => operationError("read Cursor transcript metadata", cause)),
            ),
        );
        if (!current) {
          return { kind: "failed" as const };
        }
        if (!sameStringArray(current.workspaceRoots, workspaceRoots)) {
          yield* updateContinuation({ id: current.id, workspaceRoots });
          current = {
            ...current,
            workspaceRoots,
          };
          if (change === "unchanged") change = "updated";
        }
        if (current.linkedThreadId !== null) {
          const detail = yield* get({ id: current.id });
          const synchronized = yield* repository
            .listSyncedTurns(current.id)
            .pipe(
              Effect.mapError((cause) => operationError("read synchronized Cursor turns", cause)),
            );
          if (synchronized.length === 0) {
            yield* baselineExistingNativeHistory(current, detail.entries);
          }
          yield* syncLinkedHistory(current, detail.entries, now);
        } else if (current.syncState === "conflict") {
          const detail = yield* get({ id: current.id });
          const turns = cursorTranscriptTurns(detail.entries);
          yield* updateContinuation({
            id: current.id,
            syncState:
              current.cursorGenerationId !== null || turns.hasIncompleteTail
                ? "cursor-active"
                : "idle",
            pendingT3UserText: null,
            pendingT3MessageId: null,
            pendingT3TurnIndex: null,
          });
        }
        return { kind: change };
      });

    const refreshPath = (sourcePath: string, workspaceRoots?: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const descriptor = yield* source
          .describePath(sourcePath)
          .pipe(Effect.mapError((cause) => operationError("inspect Cursor transcript", cause)));
        if (descriptor === null) return null;
        const runtimeRecords = yield* providerSessions
          .list()
          .pipe(Effect.mapError((cause) => operationError("read provider sessions", cause)));
        const linkedThreadBySessionId = new Map(
          runtimeRecords.flatMap((runtime) => {
            const sessionId =
              runtime.providerName === "cursor" ? cursorSessionId(runtime.resumeCursor) : null;
            return sessionId ? [[sessionId, runtime.threadId] as const] : [];
          }),
        );
        yield* refreshDescriptor(descriptor, {
          ...(workspaceRoots ? { workspaceRoots } : {}),
          linkedThreadBySessionId,
        });
        return descriptor.id;
      }).pipe(refreshLock.withPermits(1));

    const refreshBase = Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const [descriptors, existingRecords, runtimeRecords] = yield* Effect.all([
        source.discover,
        repository.listSourceRecords(source.source),
        providerSessions.list(),
      ]).pipe(Effect.mapError((cause) => operationError("discover Cursor chat imports", cause)));
      const existingBySourceKey = new Map(
        existingRecords.map((record) => [record.sourceKey, record] as const),
      );
      const linkedThreadBySessionId = new Map(
        runtimeRecords.flatMap((runtime) => {
          const sessionId =
            runtime.providerName === "cursor" ? cursorSessionId(runtime.resumeCursor) : null;
          return sessionId ? [[sessionId, runtime.threadId] as const] : [];
        }),
      );
      const seenSourceKeys = new Set(descriptors.map((descriptor) => descriptor.sourceKey));
      const results = yield* Effect.forEach(
        descriptors,
        (descriptor) =>
          refreshDescriptor(descriptor, { linkedThreadBySessionId }).pipe(
            Effect.catch((cause) => {
              const existing = existingBySourceKey.get(descriptor.sourceKey);
              if (!existing) return Effect.succeed({ kind: "failed" as const });
              return repository
                .markSyncError({
                  id: existing.id,
                  lastSyncedAt: now,
                  syncError: cause instanceof Error ? cause.message : String(cause),
                })
                .pipe(
                  Effect.tap(Option.match({ onNone: () => Effect.void, onSome: publish })),
                  Effect.as({ kind: "failed" as const }),
                  Effect.orElseSucceed(() => ({ kind: "failed" as const })),
                );
            }),
          ),
        { concurrency: 4 },
      );

      let unavailable = 0;
      for (const existing of existingRecords) {
        if (seenSourceKeys.has(existing.sourceKey) || !existing.sourceAvailable) continue;
        const updated = yield* repository
          .markUnavailable({
            id: existing.id,
            lastSyncedAt: now,
            syncError: "Cursor transcript is no longer available at its original path.",
          })
          .pipe(Effect.mapError((cause) => operationError("mark chat import unavailable", cause)));
        yield* Option.match(updated, { onNone: () => Effect.void, onSome: publish });
        unavailable += 1;
      }

      const count = (kind: (typeof results)[number]["kind"]) =>
        results.filter((result) => result.kind === kind).length;
      return {
        discovered: count("discovered"),
        updated: count("updated"),
        unchanged: count("unchanged"),
        unavailable,
        failed: count("failed"),
      } satisfies ChatImportRefreshResult;
    });

    const refresh = refreshLock.withPermits(1)(refreshBase);

    const handleHookEvent = (event: CursorHookEvent) =>
      Effect.gen(function* () {
        const transcriptPath = event.transcript_path;
        if (transcriptPath === null) return;
        const descriptor = yield* source
          .describePath(transcriptPath)
          .pipe(Effect.mapError((cause) => operationError("inspect Cursor hook event", cause)));
        if (descriptor === null) return;
        yield* withContinuationLock(
          descriptor.id,
          Effect.gen(function* () {
            if (event.hook_event_name === "stop") {
              const existing = Option.getOrUndefined(
                yield* repository
                  .getSourceRecordById(descriptor.id)
                  .pipe(
                    Effect.mapError((cause) =>
                      operationError("read Cursor hook generation", cause),
                    ),
                  ),
              );
              if (
                existing !== undefined &&
                existing.cursorGenerationId !== null &&
                existing.cursorGenerationId !== event.generation_id
              ) {
                yield* refreshPath(transcriptPath, event.workspace_roots);
                return;
              }
              if (existing !== undefined) {
                yield* updateContinuation({
                  id: existing.id,
                  cursorGenerationId: null,
                  syncState:
                    existing.syncState === "conflict"
                      ? "conflict"
                      : existing.pendingT3UserText !== null
                        ? "t3-active"
                        : "idle",
                });
              }
              yield* refreshPath(transcriptPath, event.workspace_roots);
              return;
            }

            const importId = yield* refreshPath(transcriptPath, event.workspace_roots);
            if (importId === null) return;
            const record = Option.getOrUndefined(
              yield* repository
                .getSourceRecordById(importId)
                .pipe(
                  Effect.mapError((cause) => operationError("read Cursor hook transcript", cause)),
                ),
            );
            if (!record) return;
            yield* updateContinuation({
              id: record.id,
              cursorGenerationId: event.generation_id,
              syncState:
                record.syncState === "conflict"
                  ? "conflict"
                  : record.pendingT3UserText !== null
                    ? "t3-active"
                    : "cursor-active",
            });
          }),
        );
      });

    const reserveSourceTurn = (
      record: ChatImportSourceRecord,
      messageId: MessageId,
      text: string,
    ) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < BUSY_WAIT_ATTEMPTS; attempt += 1) {
          const reserved = yield* withContinuationLock(
            record.id,
            Effect.gen(function* () {
              const refreshed = yield* refreshPath(record.sourcePath, record.workspaceRoots).pipe(
                Effect.catch(() =>
                  updateContinuation({ id: record.id, syncState: "conflict" }).pipe(
                    Effect.flatMap(
                      () =>
                        new ChatImportConflictError({
                          id: record.id,
                          message:
                            "The Cursor source session could not be validated. Resolve the conflict before continuing.",
                        }),
                    ),
                  ),
                ),
              );
              if (refreshed !== record.id) {
                yield* updateContinuation({ id: record.id, syncState: "conflict" });
                return yield* new ChatImportConflictError({
                  id: record.id,
                  message:
                    "The Cursor source session could not be validated. Resolve the conflict before continuing.",
                });
              }
              const current = Option.getOrUndefined(
                yield* repository
                  .getSourceRecordById(record.id)
                  .pipe(
                    Effect.mapError((cause) => operationError("read Cursor sync state", cause)),
                  ),
              );
              if (!current) {
                return yield* new ChatImportNotFoundError({
                  id: record.id,
                  message: `Chat import ${record.id} was not found`,
                });
              }
              if (current.syncState === "conflict") {
                return yield* new ChatImportConflictError({
                  id: current.id,
                  message: "This Cursor chat has conflicting simultaneous edits.",
                });
              }
              if (!current.sourceAvailable || current.syncError !== null) {
                yield* updateContinuation({ id: current.id, syncState: "conflict" });
                return yield* new ChatImportConflictError({
                  id: current.id,
                  message: "The Cursor source session is unavailable or failed to synchronize.",
                });
              }
              if (current.pendingT3MessageId === messageId) return current;
              const detail = yield* get({ id: current.id });
              const turns = cursorTranscriptTurns(detail.entries);
              if (current.pendingT3MessageId !== null) {
                return yield* new ChatImportSourceBusyError({
                  id: current.id,
                  message: "A T3 message is already running for this Cursor chat.",
                });
              }
              if (
                turns.hasIncompleteTail ||
                current.cursorGenerationId !== null ||
                current.syncState === "cursor-active"
              ) {
                return null;
              }
              const acquired = yield* reserveTurn({
                id: current.id,
                pendingT3UserText: text,
                pendingT3MessageId: messageId,
                pendingT3TurnIndex: turns.completed.length,
              });
              if (!acquired) {
                return yield* new ChatImportSourceBusyError({
                  id: current.id,
                  message: "A T3 message is already running for this Cursor chat.",
                });
              }
              return {
                ...current,
                syncState: "t3-active" as const,
                pendingT3UserText: text,
                pendingT3MessageId: messageId,
                pendingT3TurnIndex: turns.completed.length,
              };
            }),
          );
          if (reserved !== null) return reserved;
          yield* Effect.sleep(BUSY_WAIT_INTERVAL);
        }
        return yield* new ChatImportSourceBusyError({
          id: record.id,
          message: "Cursor is still responding. T3 did not send another message.",
        });
      });

    const releaseSourceTurn = (recordId: ChatImportId, messageId: MessageId) =>
      withContinuationLock(
        recordId,
        Effect.gen(function* () {
          const current = Option.getOrUndefined(
            yield* repository
              .getSourceRecordById(recordId)
              .pipe(Effect.mapError((cause) => operationError("read Cursor sync state", cause))),
          );
          if (!current || current.pendingT3MessageId !== messageId) return;
          yield* updateContinuation({
            id: current.id,
            syncState:
              current.syncState === "conflict"
                ? "conflict"
                : current.cursorGenerationId !== null
                  ? "cursor-active"
                  : "idle",
            pendingT3UserText: null,
            pendingT3MessageId: null,
            pendingT3TurnIndex: null,
          });
        }),
      );

    const recoverStartupReservations = Effect.gen(function* () {
      const records = yield* repository
        .listSourceRecords(source.source)
        .pipe(
          Effect.mapError((cause) => operationError("read pending Cursor reservations", cause)),
        );
      yield* Effect.forEach(
        records,
        (record) =>
          Effect.gen(function* () {
            if (record.pendingT3MessageId === null) return;
            const refreshed = yield* refreshPath(record.sourcePath, record.workspaceRoots).pipe(
              Effect.option,
            );
            if (Option.isNone(refreshed) || refreshed.value !== record.id) return;
            const current = Option.getOrUndefined(
              yield* repository
                .getSourceRecordById(record.id)
                .pipe(
                  Effect.mapError((cause) =>
                    operationError("read refreshed Cursor reservation", cause),
                  ),
                ),
            );
            if (!current?.sourceAvailable || current.syncError !== null) return;
            const pendingMessageId = current.pendingT3MessageId;
            if (pendingMessageId === null) return;
            const detail = yield* get({ id: current.id });
            if (cursorTranscriptTurns(detail.entries).hasIncompleteTail) return;

            if (current.linkedThreadId !== null) {
              const thread = Option.getOrUndefined(
                yield* projections
                  .getThreadDetailById(current.linkedThreadId)
                  .pipe(
                    Effect.mapError((cause) =>
                      operationError("read pending Cursor orchestration turn", cause),
                    ),
                  ),
              );
              const matchingFailure = (thread?.activities ?? [])
                .map(providerTurnStartFailure)
                .find((failure) => failure?.messageId === String(pendingMessageId));
              const runtime = Option.getOrUndefined(
                yield* providerSessions
                  .getByThreadId({ threadId: current.linkedThreadId })
                  .pipe(
                    Effect.mapError((cause) =>
                      operationError("read pending Cursor startup runtime", cause),
                    ),
                  ),
              );
              const recoveredUnknownAttempt =
                runtime !== undefined &&
                providerTurnAdmissionPhase(runtime.runtimePayload) === "unknown" &&
                (runtime.status === "stopped" || runtime.status === "error");
              if (matchingFailure != null && matchingFailure.reservationOutcome === "admitted") {
                return;
              }
              if (matchingFailure?.reservationOutcome === "unknown" && !recoveredUnknownAttempt) {
                return;
              }
              const definitelyNotAdmitted =
                matchingFailure?.reservationOutcome === "not-admitted" || recoveredUnknownAttempt;
              if (
                !definitelyNotAdmitted &&
                thread?.messages.some((message) => message.id === pendingMessageId)
              ) {
                return;
              }
              if (
                !definitelyNotAdmitted &&
                runtime !== undefined &&
                runtime.status !== "stopped" &&
                runtime.status !== "error"
              ) {
                return;
              }
            }

            yield* releaseSourceTurn(current.id, pendingMessageId);
          }),
        { concurrency: 1, discard: true },
      );
    });

    const ensureSharedSessionBinding = (record: ChatImportSourceRecord, observedAt: string) =>
      Effect.gen(function* () {
        if (record.linkedThreadId === null) return;
        const existing = Option.getOrUndefined(
          yield* providerSessions
            .getByThreadId({ threadId: record.linkedThreadId })
            .pipe(Effect.mapError((cause) => operationError("read shared Cursor binding", cause))),
        );
        const existingPayload =
          existing?.runtimePayload !== null &&
          typeof existing?.runtimePayload === "object" &&
          !Array.isArray(existing.runtimePayload)
            ? existing.runtimePayload
            : {};
        const existingSessionId =
          existing?.providerName === CURSOR_DRIVER ? cursorSessionId(existing.resumeCursor) : null;
        if (
          existing !== undefined &&
          existing.status !== "stopped" &&
          existing.status !== "error" &&
          (existing.providerName !== CURSOR_DRIVER || existingSessionId !== record.externalId)
        ) {
          yield* updateContinuation({ id: record.id, syncState: "conflict" });
          return yield* new ChatImportConflictError({
            id: record.id,
            message:
              "This thread is using a different active provider session. Stop it before continuing the imported Cursor chat.",
          });
        }
        if (
          existingSessionId === record.externalId &&
          "sharedCursorSession" in existingPayload &&
          existingPayload.sharedCursorSession === true
        ) {
          return;
        }
        const cwd =
          "cwd" in existingPayload && typeof existingPayload.cwd === "string"
            ? existingPayload.cwd
            : record.workspaceRoots[0];
        yield* providerSessions
          .upsert({
            threadId: record.linkedThreadId,
            providerName: CURSOR_DRIVER,
            providerInstanceId: CURSOR_INSTANCE,
            adapterKey: CURSOR_DRIVER,
            runtimeMode: existing?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            status: existing?.status ?? "stopped",
            lastSeenAt: observedAt,
            resumeCursor: {
              schemaVersion: 1,
              sessionId: record.externalId,
            },
            runtimePayload: {
              ...existingPayload,
              ...(cwd ? { cwd } : {}),
              modelSelection: {
                instanceId: CURSOR_INSTANCE,
                model: CURSOR_MODEL,
              },
              sharedCursorSession: true,
            },
          })
          .pipe(Effect.mapError((cause) => operationError("repair shared Cursor binding", cause)));
      });

    const prepareLinkedTurnStart: ChatImportCatalogShape["prepareLinkedTurnStart"] = (command) =>
      Effect.gen(function* () {
        const record = Option.getOrUndefined(
          yield* repository
            .getSourceRecordByLinkedThreadId(command.threadId)
            .pipe(Effect.mapError((cause) => operationError("read linked Cursor chat", cause))),
        );
        if (!record) return;
        yield* ensureSharedSessionBinding(record, command.createdAt);
        yield* reserveSourceTurn(record, command.message.messageId, command.message.text);
      });

    const cancelPreparedTurn: ChatImportCatalogShape["cancelPreparedTurn"] = (command) =>
      repository.getSourceRecordByLinkedThreadId(command.threadId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (record) => releaseSourceTurn(record.id, command.message.messageId),
          }),
        ),
        Effect.ignore,
      );

    const reconcileLinkedTurnCompletion: ChatImportCatalogShape["reconcileLinkedTurnCompletion"] = (
      threadId,
    ) =>
      Effect.gen(function* () {
        const record = Option.getOrUndefined(
          yield* repository
            .getSourceRecordByLinkedThreadId(threadId)
            .pipe(
              Effect.mapError((cause) =>
                operationError("read completed linked Cursor turn", cause),
              ),
            ),
        );
        if (!record) return;
        yield* withContinuationLock(
          record.id,
          Effect.gen(function* () {
            for (let attempt = 0; attempt < BUSY_WAIT_ATTEMPTS; attempt += 1) {
              const refreshed = yield* refreshPath(record.sourcePath, record.workspaceRoots);
              if (refreshed !== record.id) {
                yield* updateContinuation({ id: record.id, syncState: "conflict" });
                return yield* new ChatImportConflictError({
                  id: record.id,
                  message:
                    "The completed Cursor turn could not be reconciled to its source transcript.",
                });
              }
              const current = Option.getOrUndefined(
                yield* repository
                  .getSourceRecordById(record.id)
                  .pipe(
                    Effect.mapError((cause) =>
                      operationError("read completed Cursor reconciliation", cause),
                    ),
                  ),
              );
              if (!current || current.pendingT3MessageId === null) return;
              if (current.syncState === "conflict") {
                return yield* new ChatImportConflictError({
                  id: current.id,
                  message: "The completed Cursor turn conflicted with the source transcript.",
                });
              }
              yield* Effect.sleep(BUSY_WAIT_INTERVAL);
            }
            return yield* new ChatImportSourceBusyError({
              id: record.id,
              message: "Cursor completed the turn, but its transcript has not settled yet.",
            });
          }),
        );
      });

    const dispatchAdoptedTurn = (input: {
      readonly adopt: ChatImportAdoptInput;
      readonly threadId: ThreadId;
    }) => {
      const command: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
        type: "thread.turn.start",
        commandId: CommandId.make(
          `cursor-import:${input.adopt.id}:message:${input.adopt.messageId}`,
        ),
        threadId: input.threadId,
        message: {
          messageId: input.adopt.messageId,
          role: "user",
          text: input.adopt.text,
          attachments: [],
        },
        modelSelection: {
          instanceId: CURSOR_INSTANCE,
          model: CURSOR_MODEL,
        },
        titleSeed: input.adopt.text.slice(0, 80),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: input.adopt.createdAt,
      };
      return prepareLinkedTurnStart(command).pipe(
        Effect.flatMap(() => orchestration.dispatch(command)),
        Effect.tapError(() => cancelPreparedTurn(command)),
        Effect.mapError((cause) =>
          isChatImportOperationError(cause) ||
          isChatImportNotFoundError(cause) ||
          isChatImportSourceBusyError(cause) ||
          isChatImportConflictError(cause)
            ? cause
            : operationError("start adopted Cursor turn", cause),
        ),
      );
    };

    const adopt: ChatImportCatalogShape["adopt"] = (input) =>
      Effect.gen(function* () {
        let sourceRecord = Option.getOrUndefined(
          yield* repository
            .getSourceRecordById(input.id)
            .pipe(Effect.mapError((cause) => operationError("read chat import", cause))),
        );
        if (!sourceRecord) {
          return yield* new ChatImportNotFoundError({
            id: input.id,
            message: `Chat import ${input.id} was not found`,
          });
        }
        const effectiveInput =
          sourceRecord.pendingT3MessageId !== null &&
          sourceRecord.pendingT3UserText !== null &&
          normalizedMessage(sourceRecord.pendingT3UserText) === normalizedMessage(input.text)
            ? { ...input, messageId: sourceRecord.pendingT3MessageId }
            : input;
        const needsThreadLink = sourceRecord.linkedThreadId === null;
        if (needsThreadLink) {
          yield* refreshPath(sourceRecord.sourcePath, sourceRecord.workspaceRoots);
          const stableRecord = yield* reserveSourceTurn(
            sourceRecord,
            effectiveInput.messageId,
            effectiveInput.text,
          );
          sourceRecord = {
            ...stableRecord,
            linkedThreadId: input.threadId,
          };
        }

        const threadId = sourceRecord.linkedThreadId;
        if (threadId === null) {
          return yield* operationError(
            "adopt Cursor chat",
            new Error("The Cursor chat link was not persisted."),
          );
        }
        const existingThread = Option.getOrUndefined(
          yield* projections
            .getThreadDetailById(threadId)
            .pipe(Effect.mapError((cause) => operationError("read adopted Cursor thread", cause))),
        );
        const projectId = existingThread?.projectId ?? input.projectId;
        const project = Option.getOrUndefined(
          yield* projections
            .getProjectShellById(projectId)
            .pipe(Effect.mapError((cause) => operationError("read adoption project", cause))),
        );
        if (!project) {
          return yield* operationError(
            "adopt Cursor chat",
            new Error(`Project ${input.projectId} was not found.`),
          );
        }
        if (
          sourceRecord.workspaceRoots.length > 0 &&
          !sourceRecord.workspaceRoots.includes(project.workspaceRoot)
        ) {
          return yield* operationError(
            "adopt Cursor chat",
            new Error(`Project ${project.id} does not use the original Cursor workspace.`),
          );
        }
        if (needsThreadLink) {
          yield* updateContinuation({
            id: input.id,
            linkedThreadId: threadId,
          });
        }
        const modelSelection = {
          instanceId: CURSOR_INSTANCE,
          model: CURSOR_MODEL,
        };
        if (!existingThread) {
          yield* orchestration
            .dispatch({
              type: "thread.create",
              commandId: CommandId.make(`cursor-import:${input.id}:create`),
              threadId,
              projectId,
              title: sourceRecord.title,
              modelSelection,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              branch: null,
              worktreePath: null,
              createdAt: sourceRecord.firstSeenAt,
            })
            .pipe(
              Effect.mapError((cause) => operationError("create adopted Cursor thread", cause)),
            );
        }
        yield* updateContinuation({
          id: input.id,
          workspaceRoots:
            sourceRecord.workspaceRoots.length > 0
              ? sourceRecord.workspaceRoots
              : [project.workspaceRoot],
        });
        const linkedRecord = Option.getOrUndefined(
          yield* repository
            .getSourceRecordById(input.id)
            .pipe(Effect.mapError((cause) => operationError("read adopted Cursor chat", cause))),
        );
        if (!linkedRecord) {
          return yield* new ChatImportNotFoundError({
            id: input.id,
            message: `Chat import ${input.id} was not found`,
          });
        }
        const detail = yield* get({ id: input.id });
        yield* syncLinkedHistory(linkedRecord, detail.entries, input.createdAt);
        yield* providerSessions
          .upsert({
            threadId,
            providerName: CURSOR_DRIVER,
            providerInstanceId: CURSOR_INSTANCE,
            adapterKey: CURSOR_DRIVER,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            status: "stopped",
            lastSeenAt: input.createdAt,
            resumeCursor: {
              schemaVersion: 1,
              sessionId: sourceRecord.externalId,
            },
            runtimePayload: {
              cwd: project.workspaceRoot,
              modelSelection,
              sharedCursorSession: true,
            },
          })
          .pipe(Effect.mapError((cause) => operationError("bind adopted Cursor session", cause)));
        yield* dispatchAdoptedTurn({ adopt: effectiveInput, threadId });
        return { threadId };
      }).pipe(
        Effect.tapError(() =>
          repository.getSourceRecordById(input.id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (record) =>
                  record.pendingT3MessageId === null
                    ? Effect.void
                    : releaseSourceTurn(input.id, record.pendingT3MessageId),
              }),
            ),
            Effect.ignore,
          ),
        ),
      );

    const resolveConflict: ChatImportCatalogShape["resolveConflict"] = (input) =>
      withContinuationLock(
        input.id,
        Effect.gen(function* () {
          const initial = Option.getOrUndefined(
            yield* repository
              .getSourceRecordById(input.id)
              .pipe(Effect.mapError((cause) => operationError("read Cursor conflict", cause))),
          );
          if (!initial) {
            return yield* new ChatImportNotFoundError({
              id: input.id,
              message: `Chat import ${input.id} was not found`,
            });
          }
          if (initial.linkedThreadId === null || initial.syncState !== "conflict") {
            return yield* operationError(
              "resolve Cursor conflict",
              new Error("This Cursor chat does not have an active conflict."),
            );
          }

          yield* refreshPath(initial.sourcePath, initial.workspaceRoots).pipe(
            Effect.catchTag("ChatImportConflictError", () => Effect.void),
          );
          const current = Option.getOrUndefined(
            yield* repository
              .getSourceRecordById(input.id)
              .pipe(
                Effect.mapError((cause) => operationError("read refreshed Cursor conflict", cause)),
              ),
          );
          if (!current || current.linkedThreadId === null) {
            return yield* new ChatImportNotFoundError({
              id: input.id,
              message: `Chat import ${input.id} was not found`,
            });
          }
          const linkedThreadId = current.linkedThreadId;

          if (input.resolution === "keep-t3") {
            yield* providerSessions
              .deleteByThreadId({ threadId: linkedThreadId })
              .pipe(
                Effect.mapError((cause) => operationError("detach shared Cursor session", cause)),
              );
            yield* repository
              .clearSyncedTurns(current.id)
              .pipe(
                Effect.mapError((cause) => operationError("clear Cursor synchronization", cause)),
              );
            yield* updateContinuation({
              id: current.id,
              linkedThreadId: null,
              syncState: "idle",
              pendingT3UserText: null,
              pendingT3MessageId: null,
              pendingT3TurnIndex: null,
              cursorGenerationId: null,
            });
            return { threadId: linkedThreadId };
          }

          const replacementThreadId = input.replacementThreadId;
          if (replacementThreadId === undefined) {
            return yield* operationError(
              "accept Cursor conflict",
              new Error("A replacement thread ID is required to accept the Cursor history."),
            );
          }
          const previousThread = Option.getOrUndefined(
            yield* projections
              .getThreadDetailById(linkedThreadId)
              .pipe(
                Effect.mapError((cause) => operationError("read conflicted native thread", cause)),
              ),
          );
          if (!previousThread) {
            return yield* operationError(
              "accept Cursor conflict",
              new Error(`Linked thread ${linkedThreadId} was not found.`),
            );
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* orchestration
            .dispatch({
              type: "thread.create",
              commandId: CommandId.make(
                `cursor-import:${current.id}:resolve:${replacementThreadId}`,
              ),
              threadId: replacementThreadId,
              projectId: previousThread.projectId,
              title: current.title,
              modelSelection: {
                instanceId: CURSOR_INSTANCE,
                model: CURSOR_MODEL,
              },
              runtimeMode: previousThread.runtimeMode,
              interactionMode: previousThread.interactionMode,
              branch: null,
              worktreePath: null,
              createdAt: now,
            })
            .pipe(
              Effect.mapError((cause) => operationError("create accepted Cursor thread", cause)),
            );
          yield* repository
            .clearSyncedTurns(current.id)
            .pipe(
              Effect.mapError((cause) => operationError("reset Cursor synchronization", cause)),
            );
          yield* updateContinuation({
            id: current.id,
            linkedThreadId: replacementThreadId,
            syncState: "conflict",
            pendingT3UserText: null,
            pendingT3MessageId: null,
            pendingT3TurnIndex: null,
            cursorGenerationId: null,
          });
          yield* providerSessions
            .deleteByThreadId({ threadId: linkedThreadId })
            .pipe(
              Effect.mapError((cause) => operationError("replace shared Cursor session", cause)),
            );
          const replacement = Option.getOrUndefined(
            yield* repository
              .getSourceRecordById(current.id)
              .pipe(
                Effect.mapError((cause) => operationError("read accepted Cursor history", cause)),
              ),
          );
          if (!replacement) {
            return yield* new ChatImportNotFoundError({
              id: current.id,
              message: `Chat import ${current.id} was not found`,
            });
          }
          const detail = yield* get({ id: current.id });
          yield* syncLinkedHistory(replacement, detail.entries, now);
          yield* ensureSharedSessionBinding({ ...replacement, syncState: "idle" }, now);
          return { threadId: replacementThreadId };
        }),
      );

    const liveSyncStatus: ChatImportCatalogShape["liveSyncStatus"] = hookBridge.status;
    const installLiveSync: ChatImportCatalogShape["installLiveSync"] = hookBridge.install.pipe(
      Effect.mapError((cause) => operationError("install Cursor live sync", cause)),
    );
    const uninstallLiveSync: ChatImportCatalogShape["uninstallLiveSync"] =
      hookBridge.uninstall.pipe(
        Effect.mapError((cause) => operationError("remove Cursor live sync", cause)),
      );

    const handleOrchestrationEvent = (event: OrchestrationEvent) =>
      Effect.gen(function* () {
        if (event.type !== "thread.activity-appended") return;
        const failure = providerTurnStartFailure(event.payload.activity);
        if (failure === null) return;
        const record = Option.getOrUndefined(
          yield* repository
            .getSourceRecordByLinkedThreadId(event.payload.threadId)
            .pipe(
              Effect.mapError((cause) =>
                operationError("read failed Cursor turn reservation", cause),
              ),
            ),
        );
        if (record?.pendingT3MessageId !== failure.messageId) return;
        if (failure.reservationOutcome === "not-admitted") {
          yield* releaseSourceTurn(record.id, record.pendingT3MessageId);
          return;
        }
        yield* refreshPath(record.sourcePath, record.workspaceRoots);
      });

    const start: ChatImportCatalogShape["start"] = Effect.gen(function* () {
      const domainEvents = yield* orchestration.subscribeDomainEvents;
      yield* refresh.pipe(
        Effect.tapError((cause) => Effect.logWarning("Initial Cursor chat import failed", cause)),
        Effect.ignore,
      );
      yield* recoverStartupReservations.pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Cursor chat reservation recovery failed", cause),
        ),
        Effect.ignore,
      );
      yield* Stream.runForEach(domainEvents, (event) =>
        handleOrchestrationEvent(event).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Cursor turn failure reconciliation failed", {
              cause,
            }),
          ),
        ),
      ).pipe(Effect.forkScoped);

      const pendingPaths = new Set<string>();
      let watchRefreshScheduled = false;
      let fullRefreshRequested = false;
      yield* source
        .watch((sourcePath) => {
          if (sourcePath === null) {
            fullRefreshRequested = true;
          } else {
            pendingPaths.add(sourcePath);
          }
          if (watchRefreshScheduled) return;
          watchRefreshScheduled = true;
          runFork(
            Effect.gen(function* () {
              yield* Effect.sleep(WATCH_DEBOUNCE_MS);
              while (fullRefreshRequested || pendingPaths.size > 0) {
                const paths = [...pendingPaths];
                pendingPaths.clear();
                const runFullRefresh = fullRefreshRequested;
                fullRefreshRequested = false;
                const reconciliation = runFullRefresh
                  ? refresh
                  : Effect.forEach(paths, (path) => refreshPath(path), {
                      concurrency: 4,
                      discard: true,
                    });
                yield* reconciliation;
              }
            }).pipe(
              Effect.ensuring(Effect.sync(() => (watchRefreshScheduled = false))),
              Effect.ignore,
            ),
          );
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Cursor chat import watcher unavailable", cause).pipe(
              Effect.as(() => undefined),
            ),
          ),
        );

      yield* hookBridge.start((event) =>
        runPromise(
          handleHookEvent(event).pipe(
            Effect.catchTag("ChatImportConflictError", () => Effect.void),
            Effect.tapError((cause) =>
              Effect.logWarning("Cursor live-sync hook event failed", { cause }),
            ),
          ),
        ),
      );

      yield* Effect.forever(
        Effect.sleep(SAFETY_SYNC_INTERVAL).pipe(
          Effect.flatMap(() => refresh),
          Effect.ignore,
        ),
      ).pipe(Effect.forkScoped);
    });

    const stream: ChatImportCatalogShape["stream"] = Stream.concat(
      Stream.fromEffect(
        Effect.all({ revision: Ref.get(revision), counts: readCounts }).pipe(
          Effect.map(({ revision: currentRevision, counts }) => ({
            kind: "snapshot" as const,
            revision: currentRevision,
            counts,
          })),
        ),
      ),
      Stream.fromPubSub(changes).pipe(
        Stream.mapEffect(({ summary, revision: changeRevision }) =>
          readCounts.pipe(
            Effect.map((counts) => ({
              kind: "upserted" as const,
              revision: changeRevision,
              summary,
              counts,
            })),
          ),
        ),
      ),
    );

    return {
      list,
      get,
      getLinked,
      setStatus,
      refresh,
      liveSyncStatus,
      installLiveSync,
      uninstallLiveSync,
      adopt,
      resolveConflict,
      prepareLinkedTurnStart,
      cancelPreparedTurn,
      reconcileLinkedTurnCompletion,
      start,
      stream,
    } satisfies ChatImportCatalogShape;
  }),
);

export const ChatImportRunnerLive = Layer.effectDiscard(
  Effect.flatMap(Effect.service(ChatImportCatalog), (catalog) => catalog.start),
);
