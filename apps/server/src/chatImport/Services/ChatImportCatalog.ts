import type {
  ChatImportDetail,
  ChatImportGetInput,
  ChatImportListInput,
  ChatImportListResult,
  ChatImportRefreshResult,
  ChatImportRpcError,
  ChatImportSetStatusInput,
  ChatImportStreamItem,
  ChatImportSummary,
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
  readonly setStatus: (
    input: ChatImportSetStatusInput,
  ) => Effect.Effect<ChatImportSummary, ChatImportRpcError>;
  readonly refresh: Effect.Effect<ChatImportRefreshResult, ChatImportRpcError>;
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly stream: Stream.Stream<ChatImportStreamItem, ChatImportRpcError>;
}

export class ChatImportCatalog extends Context.Service<ChatImportCatalog, ChatImportCatalogShape>()(
  "t3/chatImport/Services/ChatImportCatalog",
) {}
