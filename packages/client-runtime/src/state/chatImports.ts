import { WS_METHODS, type ChatImportListResult, type ChatImportStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import { request } from "../rpc/client.ts";

export interface ChatImportCatalogListInput {
  readonly status: ChatImportStatus;
  readonly search?: string;
}

const LIST_PAGE_SIZE = 200;

export function createChatImportEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();

  return {
    listPage: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:chat-imports:list-page",
      tag: WS_METHODS.chatImportsList,
      staleTimeMs: 5_000,
    }),
    list: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:chat-imports:list",
      staleTimeMs: 5_000,
      execute: (input: ChatImportCatalogListInput) =>
        Effect.gen(function* () {
          const items: ChatImportListResult["items"][number][] = [];
          let counts: ChatImportListResult["counts"] = {
            inbox: 0,
            library: 0,
            archived: 0,
          };
          let cursor: number | undefined;
          do {
            const page = yield* request(WS_METHODS.chatImportsList, {
              status: input.status,
              ...(input.search === undefined ? {} : { search: input.search }),
              ...(cursor === undefined ? {} : { cursor }),
              limit: LIST_PAGE_SIZE,
            });
            items.push(...page.items);
            counts = page.counts;
            cursor = page.nextCursor ?? undefined;
          } while (cursor !== undefined);

          return { items, counts, nextCursor: null } satisfies ChatImportListResult;
        }),
    }),
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:chat-imports:detail",
      tag: WS_METHODS.chatImportsGet,
      staleTimeMs: 5_000,
    }),
    linked: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:chat-imports:linked",
      tag: WS_METHODS.chatImportsGetLinked,
      staleTimeMs: 5_000,
    }),
    liveSyncStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:chat-imports:live-sync-status",
      tag: WS_METHODS.chatImportsLiveSyncStatus,
      staleTimeMs: 5_000,
    }),
    changes: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:chat-imports:changes",
      tag: WS_METHODS.subscribeChatImports,
    }),
    setStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:chat-imports:set-status",
      tag: WS_METHODS.chatImportsSetStatus,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.id}`,
      },
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:chat-imports:refresh",
      tag: WS_METHODS.chatImportsRefresh,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    installLiveSync: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:chat-imports:install-live-sync",
      tag: WS_METHODS.chatImportsInstallLiveSync,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    uninstallLiveSync: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:chat-imports:uninstall-live-sync",
      tag: WS_METHODS.chatImportsUninstallLiveSync,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    adopt: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:chat-imports:adopt",
      tag: WS_METHODS.chatImportsAdopt,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.id}`,
      },
    }),
    resolveConflict: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:chat-imports:resolve-conflict",
      tag: WS_METHODS.chatImportsResolveConflict,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.id}`,
      },
    }),
  };
}
