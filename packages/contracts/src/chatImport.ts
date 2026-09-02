import * as Schema from "effect/Schema";

import {
  ChatImportId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const ChatImportSourceKind = Schema.Literal("cursor");
export type ChatImportSourceKind = typeof ChatImportSourceKind.Type;

export const ChatImportStatus = Schema.Literals(["inbox", "library", "archived"]);
export type ChatImportStatus = typeof ChatImportStatus.Type;

export const ChatImportCounts = Schema.Struct({
  inbox: NonNegativeInt,
  library: NonNegativeInt,
  archived: NonNegativeInt,
});
export type ChatImportCounts = typeof ChatImportCounts.Type;

export const ChatImportContentBlock = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("tool-call"),
    name: TrimmedNonEmptyString,
    input: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("tool-result"),
    content: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("unknown"),
    payload: Schema.Unknown,
  }),
]);
export type ChatImportContentBlock = typeof ChatImportContentBlock.Type;

export const ChatImportEntry = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("message"),
    ordinal: NonNegativeInt,
    role: Schema.Literals(["user", "assistant", "unknown"]),
    blocks: Schema.Array(ChatImportContentBlock),
  }),
  Schema.Struct({
    kind: Schema.Literal("turn-ended"),
    ordinal: NonNegativeInt,
    status: Schema.Literals(["success", "aborted", "error", "unknown"]),
    error: Schema.NullOr(Schema.String),
  }),
]);
export type ChatImportEntry = typeof ChatImportEntry.Type;

export const ChatImportSummary = Schema.Struct({
  id: ChatImportId,
  source: ChatImportSourceKind,
  externalId: TrimmedNonEmptyString,
  projectKey: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  status: ChatImportStatus,
  sourceUpdatedAt: IsoDateTime,
  firstSeenAt: IsoDateTime,
  lastSyncedAt: IsoDateTime,
  sourceAvailable: Schema.Boolean,
  syncError: Schema.NullOr(Schema.String),
  entryCount: NonNegativeInt,
  linkedThreadId: Schema.NullOr(ThreadId),
});
export type ChatImportSummary = typeof ChatImportSummary.Type;

export const ChatImportDetail = Schema.Struct({
  ...ChatImportSummary.fields,
  entries: Schema.Array(ChatImportEntry),
});
export type ChatImportDetail = typeof ChatImportDetail.Type;

export const ChatImportListInput = Schema.Struct({
  status: Schema.optional(ChatImportStatus),
  search: Schema.optional(Schema.String),
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt),
});
export type ChatImportListInput = typeof ChatImportListInput.Type;

export const ChatImportListResult = Schema.Struct({
  items: Schema.Array(ChatImportSummary),
  nextCursor: Schema.NullOr(NonNegativeInt),
  counts: ChatImportCounts,
});
export type ChatImportListResult = typeof ChatImportListResult.Type;

export const ChatImportGetInput = Schema.Struct({
  id: ChatImportId,
});
export type ChatImportGetInput = typeof ChatImportGetInput.Type;

export const ChatImportSetStatusInput = Schema.Struct({
  id: ChatImportId,
  status: ChatImportStatus,
});
export type ChatImportSetStatusInput = typeof ChatImportSetStatusInput.Type;

export const ChatImportRefreshResult = Schema.Struct({
  discovered: NonNegativeInt,
  updated: NonNegativeInt,
  unchanged: NonNegativeInt,
  unavailable: NonNegativeInt,
  failed: NonNegativeInt,
});
export type ChatImportRefreshResult = typeof ChatImportRefreshResult.Type;

export const ChatImportStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    revision: NonNegativeInt,
    counts: ChatImportCounts,
  }),
  Schema.Struct({
    kind: Schema.Literal("upserted"),
    revision: NonNegativeInt,
    summary: ChatImportSummary,
    counts: ChatImportCounts,
  }),
]);
export type ChatImportStreamItem = typeof ChatImportStreamItem.Type;

export class ChatImportNotFoundError extends Schema.TaggedErrorClass<ChatImportNotFoundError>()(
  "ChatImportNotFoundError",
  {
    id: ChatImportId,
    message: Schema.String,
  },
) {}

export class ChatImportInvalidStatusTransitionError extends Schema.TaggedErrorClass<ChatImportInvalidStatusTransitionError>()(
  "ChatImportInvalidStatusTransitionError",
  {
    id: ChatImportId,
    from: ChatImportStatus,
    to: ChatImportStatus,
    message: Schema.String,
  },
) {}

export class ChatImportOperationError extends Schema.TaggedErrorClass<ChatImportOperationError>()(
  "ChatImportOperationError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export const ChatImportRpcError = Schema.Union([
  ChatImportNotFoundError,
  ChatImportInvalidStatusTransitionError,
  ChatImportOperationError,
]);
export type ChatImportRpcError = typeof ChatImportRpcError.Type;
