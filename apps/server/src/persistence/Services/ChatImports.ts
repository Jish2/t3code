import {
  ChatImportDetail,
  ChatImportId,
  ChatImportListInput,
  ChatImportListResult,
  ChatImportSourceKind,
  ChatImportStatus,
  ChatImportSummary,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  type ChatImportEntry,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ChatImportSourceRecord = Schema.Struct({
  ...ChatImportSummary.fields,
  sourceKey: Schema.String,
  sourcePath: Schema.String,
  sourceMtimeMs: Schema.Number,
  sourceSize: NonNegativeInt,
  contentDigest: Schema.String,
});
export type ChatImportSourceRecord = typeof ChatImportSourceRecord.Type;

export const UpsertChatImportSnapshotInput = Schema.Struct({
  id: ChatImportId,
  source: ChatImportSourceKind,
  sourceKey: Schema.String,
  externalId: Schema.String,
  projectKey: Schema.String,
  sourcePath: Schema.String,
  title: Schema.String,
  sourceUpdatedAt: IsoDateTime,
  firstSeenAt: IsoDateTime,
  lastSyncedAt: IsoDateTime,
  sourceMtimeMs: Schema.Number,
  sourceSize: NonNegativeInt,
  contentDigest: Schema.String,
  linkedThreadId: Schema.NullOr(ThreadId),
  entries: Schema.Array(Schema.Unknown),
});
export interface UpsertChatImportSnapshot extends Omit<
  typeof UpsertChatImportSnapshotInput.Type,
  "entries"
> {
  readonly entries: ReadonlyArray<ChatImportEntry>;
}

export interface UpsertChatImportSnapshotResult {
  readonly change: "discovered" | "updated" | "unchanged";
  readonly summary: ChatImportSummary;
}

export const MarkChatImportUnavailableInput = Schema.Struct({
  id: ChatImportId,
  lastSyncedAt: IsoDateTime,
  syncError: Schema.NullOr(Schema.String),
});
export type MarkChatImportUnavailableInput = typeof MarkChatImportUnavailableInput.Type;

export const SetChatImportStatusInput = Schema.Struct({
  id: ChatImportId,
  status: ChatImportStatus,
  updatedAt: IsoDateTime,
});
export type SetChatImportStatusInput = typeof SetChatImportStatusInput.Type;

export interface ChatImportRepositoryShape {
  readonly upsertSnapshot: (
    input: UpsertChatImportSnapshot,
  ) => Effect.Effect<UpsertChatImportSnapshotResult, ProjectionRepositoryError>;
  readonly getById: (
    id: ChatImportId,
  ) => Effect.Effect<Option.Option<ChatImportDetail>, ProjectionRepositoryError>;
  readonly list: (
    input: ChatImportListInput,
  ) => Effect.Effect<ChatImportListResult, ProjectionRepositoryError>;
  readonly listSourceRecords: (
    source: ChatImportSourceKind,
  ) => Effect.Effect<ReadonlyArray<ChatImportSourceRecord>, ProjectionRepositoryError>;
  readonly setStatus: (
    input: SetChatImportStatusInput,
  ) => Effect.Effect<Option.Option<ChatImportSummary>, ProjectionRepositoryError>;
  readonly markUnavailable: (
    input: MarkChatImportUnavailableInput,
  ) => Effect.Effect<Option.Option<ChatImportSummary>, ProjectionRepositoryError>;
  readonly markSyncError: (
    input: MarkChatImportUnavailableInput,
  ) => Effect.Effect<Option.Option<ChatImportSummary>, ProjectionRepositoryError>;
}

export class ChatImportRepository extends Context.Service<
  ChatImportRepository,
  ChatImportRepositoryShape
>()("t3/persistence/Services/ChatImports/ChatImportRepository") {}
