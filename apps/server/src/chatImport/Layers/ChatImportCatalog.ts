import {
  ChatImportInvalidStatusTransitionError,
  ChatImportNotFoundError,
  ChatImportOperationError,
  type ChatImportRefreshResult,
  type ChatImportStatus,
  type ChatImportSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ProviderSessionRuntimeRepository } from "../../persistence/ProviderSessionRuntime.ts";
import { ChatImportRepository } from "../../persistence/Services/ChatImports.ts";
import { ChatImportCatalog, type ChatImportCatalogShape } from "../Services/ChatImportCatalog.ts";
import { ChatImportSource } from "../Services/ChatImportSource.ts";

const SYNC_INTERVAL = "30 seconds";
const WATCH_DEBOUNCE_MS = 350;

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

export const ChatImportCatalogLive = Layer.effect(
  ChatImportCatalog,
  Effect.gen(function* () {
    const repository = yield* ChatImportRepository;
    const source = yield* ChatImportSource;
    const providerSessions = yield* ProviderSessionRuntimeRepository;
    const changes = yield* PubSub.unbounded<{
      readonly summary: ChatImportSummary;
      readonly revision: number;
    }>();
    const revision = yield* Ref.make(0);
    const refreshLock = yield* Semaphore.make(1);
    const runtimeContext = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(runtimeContext);

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
        (descriptor) => {
          const existing = existingBySourceKey.get(descriptor.sourceKey);
          const linkedThreadId = linkedThreadBySessionId.get(descriptor.externalId) ?? null;
          if (
            existing &&
            existing.sourceAvailable &&
            existing.syncError === null &&
            existing.sourceMtimeMs === descriptor.sourceMtimeMs &&
            existing.sourceSize === descriptor.sourceSize &&
            existing.linkedThreadId === linkedThreadId
          ) {
            return Effect.succeed({ kind: "unchanged" as const });
          }

          return source.load(descriptor).pipe(
            Effect.flatMap((loaded) =>
              repository.upsertSnapshot({
                ...loaded,
                firstSeenAt: existing?.firstSeenAt ?? now,
                lastSyncedAt: now,
                linkedThreadId,
              }),
            ),
            Effect.tap((result) =>
              result.change === "unchanged" ? Effect.void : publish(result.summary),
            ),
            Effect.map((result) => ({ kind: result.change })),
            Effect.catch((cause) => {
              if (!existing) {
                return Effect.succeed({ kind: "failed" as const });
              }
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
          );
        },
        { concurrency: 4 },
      );

      let unavailable = 0;
      for (const existing of existingRecords) {
        if (seenSourceKeys.has(existing.sourceKey) || !existing.sourceAvailable) {
          continue;
        }
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

    const start: ChatImportCatalogShape["start"] = Effect.gen(function* () {
      yield* refresh.pipe(
        Effect.tapError((cause) => Effect.logWarning("Initial Cursor chat import failed", cause)),
        Effect.ignore,
      );

      let watchRefreshScheduled = false;
      yield* source
        .watch(() => {
          if (watchRefreshScheduled) return;
          watchRefreshScheduled = true;
          runFork(
            Effect.sleep(WATCH_DEBOUNCE_MS).pipe(
              Effect.flatMap(() => refresh),
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
      yield* Effect.forever(
        Effect.sleep(SYNC_INTERVAL).pipe(
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
      setStatus,
      refresh,
      start,
      stream,
    } satisfies ChatImportCatalogShape;
  }),
);

export const ChatImportRunnerLive = Layer.effectDiscard(
  Effect.flatMap(Effect.service(ChatImportCatalog), (catalog) => catalog.start),
);
