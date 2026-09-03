import type {
  ChatImportAdoptInput,
  ChatImportAdoptResult,
  ChatImportDetail,
  ChatImportGetInput,
  ChatImportGetLinkedInput,
  ChatImportListInput,
  ChatImportListResult,
  ChatImportRefreshResult,
  ChatImportResolveConflictInput,
  ChatImportResolveConflictResult,
  ChatImportRpcError,
  ChatImportLiveSyncStatus,
  ChatImportSetStatusInput,
  ChatImportStreamItem,
  ChatImportSummary,
  OrchestrationCommand,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

export interface ChatImportCatalogShape {
  readonly list: (
    input: ChatImportListInput,
  ) => Effect.Effect<ChatImportListResult, ChatImportRpcError>;
  readonly get: (input: ChatImportGetInput) => Effect.Effect<ChatImportDetail, ChatImportRpcError>;
  readonly getLinked: (
    input: ChatImportGetLinkedInput,
  ) => Effect.Effect<ChatImportSummary | null, ChatImportRpcError>;
  readonly setStatus: (
    input: ChatImportSetStatusInput,
  ) => Effect.Effect<ChatImportSummary, ChatImportRpcError>;
  readonly refresh: Effect.Effect<ChatImportRefreshResult, ChatImportRpcError>;
  readonly liveSyncStatus: Effect.Effect<ChatImportLiveSyncStatus, ChatImportRpcError>;
  readonly installLiveSync: Effect.Effect<ChatImportLiveSyncStatus, ChatImportRpcError>;
  readonly uninstallLiveSync: Effect.Effect<ChatImportLiveSyncStatus, ChatImportRpcError>;
  readonly adopt: (
    input: ChatImportAdoptInput,
  ) => Effect.Effect<ChatImportAdoptResult, ChatImportRpcError>;
  readonly resolveConflict: (
    input: ChatImportResolveConflictInput,
  ) => Effect.Effect<ChatImportResolveConflictResult, ChatImportRpcError>;
  readonly prepareLinkedTurnStart: (
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
  ) => Effect.Effect<void, ChatImportRpcError>;
  readonly cancelPreparedTurn: (
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
  ) => Effect.Effect<void, never>;
  readonly reconcileLinkedTurnCompletion: (
    threadId: Extract<OrchestrationCommand, { type: "thread.turn.start" }>["threadId"],
  ) => Effect.Effect<void, ChatImportRpcError>;
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly stream: Stream.Stream<ChatImportStreamItem, ChatImportRpcError>;
}

export class ChatImportCatalog extends Context.Service<ChatImportCatalog, ChatImportCatalogShape>()(
  "t3/chatImport/Services/ChatImportCatalog",
) {}
