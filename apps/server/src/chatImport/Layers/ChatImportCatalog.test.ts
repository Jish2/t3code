import { ChatImportId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ChatImportRepositoryLive } from "../../persistence/Layers/ChatImports.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/ProviderSessionRuntime.ts";
import { ChatImportCatalog } from "../Services/ChatImportCatalog.ts";
import { ChatImportSource } from "../Services/ChatImportSource.ts";
import { ChatImportCatalogLive } from "./ChatImportCatalog.ts";

const importId = ChatImportId.make("cursor:catalog-test");
const nativeThreadId = ThreadId.make("native-thread");
const timestamp = "2026-09-01T12:00:00.000Z";

const layer = it.layer(
  ChatImportCatalogLive.pipe(
    Layer.provide(ChatImportRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
    Layer.provide(
      Layer.succeed(ChatImportSource, {
        source: "cursor",
        discover: Effect.succeed([
          {
            id: importId,
            source: "cursor" as const,
            sourceKey: "project/session/session.jsonl",
            externalId: "session",
            projectKey: "project",
            sourcePath: "/tmp/session.jsonl",
            sourceUpdatedAt: timestamp,
            sourceMtimeMs: 1,
            sourceSize: 1,
          },
        ]),
        load: (descriptor) =>
          Effect.succeed({
            ...descriptor,
            title: "Imported session",
            contentDigest: "digest",
            entries: [],
          }),
        watch: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderSessionRuntimeRepository)({
        upsert: () => Effect.void,
        getByThreadId: () => Effect.succeed(Option.none()),
        list: () =>
          Effect.succeed([
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
          ]),
        deleteByThreadId: () => Effect.void,
      }),
    ),
  ),
);

layer("ChatImportCatalog", (it) => {
  it.effect("links native Cursor sessions instead of showing duplicate imports", () =>
    Effect.gen(function* () {
      const catalog = yield* ChatImportCatalog;
      const refresh = yield* catalog.refresh;
      assert.strictEqual(refresh.discovered, 1);

      const list = yield* catalog.list({});
      assert.deepStrictEqual(list.items, []);
      assert.deepStrictEqual(list.counts, { inbox: 0, library: 0, archived: 0 });

      const detail = yield* catalog.get({ id: importId });
      assert.strictEqual(detail.linkedThreadId, nativeThreadId);
    }),
  );
});
