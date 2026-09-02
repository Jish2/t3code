import { useAtomValue } from "@effect/atom-react";
import {
  ChatImportId,
  type ChatImportCounts,
  type ChatImportDetail,
  type ChatImportStatus,
  type ChatImportSummary,
  type EnvironmentId,
} from "@t3tools/contracts";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { chatImportEnvironment } from "../state/chatImports";
import { formatEnvironmentQueryError } from "../state/query";

const EMPTY_COUNTS: ChatImportCounts = { inbox: 0, library: 0, archived: 0 };
const activeListKeys = new Map<string, number>();
const activeDetailKeys = new Map<string, number>();
const activeCountEnvironmentIds = new Map<EnvironmentId, number>();

function retainKey<K>(keys: Map<K, number>, key: K): () => void {
  keys.set(key, (keys.get(key) ?? 0) + 1);
  return () => {
    const nextCount = (keys.get(key) ?? 1) - 1;
    if (nextCount === 0) {
      keys.delete(key);
    } else {
      keys.set(key, nextCount);
    }
  };
}

export interface ScopedChatImportSummary extends ChatImportSummary {
  readonly environmentId: EnvironmentId;
}

interface ChatImportListSnapshot {
  readonly items: ReadonlyArray<ScopedChatImportSummary>;
  readonly counts: ChatImportCounts;
  readonly error: string | null;
  readonly isLoading: boolean;
}

interface ListKey {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly status: ChatImportStatus;
  readonly search: string;
}

function makeListKey(input: ListKey): string {
  return JSON.stringify({
    ...input,
    environmentIds: input.environmentIds.toSorted(),
  });
}

function parseListKey(key: string): ListKey {
  return JSON.parse(key) as ListKey;
}

function makeDetailKey(environmentId: EnvironmentId, id: ChatImportId): string {
  return JSON.stringify([environmentId, id]);
}

function parseDetailKey(key: string): readonly [EnvironmentId, ChatImportId] {
  return JSON.parse(key) as readonly [EnvironmentId, ChatImportId];
}

function listQuery(input: ListKey, environmentId: EnvironmentId) {
  return chatImportEnvironment.list({
    environmentId,
    input: {
      status: input.status,
      ...(input.search === "" ? {} : { search: input.search }),
    },
  });
}

const listAtom = Atom.family((key: string) => {
  const input = parseListKey(key);
  return Atom.make((get): ChatImportListSnapshot => {
    const items: ScopedChatImportSummary[] = [];
    let counts = EMPTY_COUNTS;
    let error: string | null = null;
    let isLoading = false;

    for (const environmentId of input.environmentIds) {
      const result = get(listQuery(input, environmentId));
      isLoading ||= result.waiting;
      const page = Option.getOrNull(AsyncResult.value(result));
      if (page !== null) {
        items.push(...page.items.map((item) => ({ ...item, environmentId })));
        counts = {
          inbox: counts.inbox + page.counts.inbox,
          library: counts.library + page.counts.library,
          archived: counts.archived + page.counts.archived,
        };
      }
      if (error === null && result._tag === "Failure") {
        error = formatEnvironmentQueryError(result.cause);
      }
    }

    return {
      items: items.toSorted(
        (left, right) =>
          right.sourceUpdatedAt.localeCompare(left.sourceUpdatedAt) ||
          left.id.localeCompare(right.id),
      ),
      counts,
      error,
      isLoading,
    };
  }).pipe(Atom.withLabel(`web:chat-imports:list:${key}`));
});

const detailAtom = Atom.family((key: string) => {
  const [environmentId, id] = parseDetailKey(key);
  return chatImportEnvironment.detail({ environmentId, input: { id } });
});

const revisionsAtom = Atom.family((environmentKey: string) => {
  const environmentIds = JSON.parse(environmentKey) as ReadonlyArray<EnvironmentId>;
  return Atom.make((get) =>
    environmentIds
      .map((environmentId) => {
        const event = Option.getOrNull(
          AsyncResult.value(get(chatImportEnvironment.changes({ environmentId, input: {} }))),
        );
        return event?.revision ?? -1;
      })
      .join(":"),
  ).pipe(Atom.withLabel(`web:chat-imports:revisions:${environmentKey}`));
});

function countsQuery(environmentId: EnvironmentId) {
  return chatImportEnvironment.listPage({
    environmentId,
    input: { limit: 1 },
  });
}

const countsAtom = Atom.family((environmentKey: string) => {
  const environmentIds = JSON.parse(environmentKey) as ReadonlyArray<EnvironmentId>;
  return Atom.make((get): ChatImportCounts => {
    let counts = EMPTY_COUNTS;
    for (const environmentId of environmentIds) {
      const page = Option.getOrNull(AsyncResult.value(get(countsQuery(environmentId))));
      if (page !== null) {
        counts = {
          inbox: counts.inbox + page.counts.inbox,
          library: counts.library + page.counts.library,
          archived: counts.archived + page.counts.archived,
        };
      }
    }
    return counts;
  }).pipe(Atom.withLabel(`web:chat-imports:counts:${environmentKey}`));
});

export function refreshChatImportsForEnvironment(environmentId: EnvironmentId): void {
  for (const key of activeListKeys.keys()) {
    const input = parseListKey(key);
    if (input.environmentIds.includes(environmentId)) {
      appAtomRegistry.refresh(listQuery(input, environmentId));
    }
  }
  for (const key of activeDetailKeys.keys()) {
    const [detailEnvironmentId] = parseDetailKey(key);
    if (detailEnvironmentId === environmentId) {
      appAtomRegistry.refresh(detailAtom(key));
    }
  }
  if (activeCountEnvironmentIds.has(environmentId)) {
    appAtomRegistry.refresh(countsQuery(environmentId));
  }
}

function useImportChanges(environmentIds: ReadonlyArray<EnvironmentId>): void {
  const environmentKey = JSON.stringify(environmentIds.toSorted());
  const revision = useAtomValue(revisionsAtom(environmentKey));
  useEffect(() => {
    for (const environmentId of environmentIds) {
      refreshChatImportsForEnvironment(environmentId);
    }
  }, [environmentIds, revision]);
}

export function useChatImportList(input: ListKey): ChatImportListSnapshot & {
  readonly refresh: () => void;
} {
  const key = makeListKey(input);
  const atom = listAtom(key);
  const snapshot = useAtomValue(atom);
  useImportChanges(input.environmentIds);
  useEffect(() => retainKey(activeListKeys, key), [key]);
  const refresh = useCallback(() => {
    for (const environmentId of input.environmentIds) {
      appAtomRegistry.refresh(listQuery(input, environmentId));
    }
  }, [key]);
  return { ...snapshot, refresh };
}

export function useChatImportCounts(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ChatImportCounts {
  const environmentKey = JSON.stringify(environmentIds.toSorted());
  const counts = useAtomValue(countsAtom(environmentKey));
  useImportChanges(environmentIds);
  useEffect(() => {
    const releases = environmentIds.map((environmentId) =>
      retainKey(activeCountEnvironmentIds, environmentId),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [environmentKey]);
  return counts;
}

export function useChatImportDetail(
  environmentId: EnvironmentId,
  rawId: string,
): {
  readonly detail: ChatImportDetail | null;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const id = ChatImportId.make(rawId);
  const key = makeDetailKey(environmentId, id);
  const atom = detailAtom(key);
  const result = useAtomValue(atom);
  useImportChanges(useMemo(() => [environmentId], [environmentId]));
  useEffect(() => retainKey(activeDetailKeys, key), [key]);
  return {
    detail: Option.getOrNull(AsyncResult.value(result)),
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    isLoading: result.waiting,
    refresh: () => appAtomRegistry.refresh(atom),
  };
}

export async function setChatImportStatus(
  environmentId: EnvironmentId,
  id: ChatImportId,
  status: ChatImportStatus,
): Promise<void> {
  const result = await runAtomCommand(
    appAtomRegistry,
    chatImportEnvironment.setStatus,
    { environmentId, input: { id, status } },
    { label: "chat-imports:set-status" },
  );
  if (result._tag === "Failure") {
    throw squashAtomCommandFailure(result);
  }
  refreshChatImportsForEnvironment(environmentId);
}

export async function refreshChatImportSources(
  environmentIds: ReadonlyArray<EnvironmentId>,
): Promise<void> {
  await Promise.all(
    environmentIds.map(async (environmentId) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        chatImportEnvironment.refresh,
        { environmentId, input: {} },
        { label: "chat-imports:refresh" },
      );
      if (result._tag === "Failure") {
        throw squashAtomCommandFailure(result);
      }
      refreshChatImportsForEnvironment(environmentId);
    }),
  );
}
