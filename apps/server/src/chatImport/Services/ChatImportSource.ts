import type { ChatImportEntry, ChatImportId, ChatImportSourceKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";

export class ChatImportSourceError extends Schema.TaggedErrorClass<ChatImportSourceError>()(
  "ChatImportSourceError",
  {
    operation: Schema.String,
    path: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ChatImportSourceDescriptor {
  readonly id: ChatImportId;
  readonly source: ChatImportSourceKind;
  readonly sourceKey: string;
  readonly externalId: string;
  readonly projectKey: string;
  readonly sourcePath: string;
  readonly sourceUpdatedAt: string;
  readonly sourceMtimeMs: number;
  readonly sourceSize: number;
}

export interface LoadedChatImportSource extends ChatImportSourceDescriptor {
  readonly title: string;
  readonly contentDigest: string;
  readonly entries: ReadonlyArray<ChatImportEntry>;
}

export interface ChatImportSourceShape {
  readonly source: ChatImportSourceKind;
  readonly discover: Effect.Effect<
    ReadonlyArray<ChatImportSourceDescriptor>,
    ChatImportSourceError
  >;
  readonly describePath: (
    sourcePath: string,
  ) => Effect.Effect<ChatImportSourceDescriptor | null, ChatImportSourceError>;
  readonly load: (
    descriptor: ChatImportSourceDescriptor,
  ) => Effect.Effect<LoadedChatImportSource, ChatImportSourceError>;
  readonly watch: (
    onChange: (sourcePath: string | null) => void,
  ) => Effect.Effect<void, ChatImportSourceError, Scope.Scope>;
}

export class ChatImportSource extends Context.Service<ChatImportSource, ChatImportSourceShape>()(
  "t3/chatImport/Services/ChatImportSource",
) {}
