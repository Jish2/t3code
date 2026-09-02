import type { ChatImportStatus } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BookOpenIcon,
  CheckIcon,
  InboxIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { useEnvironments } from "../state/environments";
import { useDebouncedValue } from "../state/queries";
import {
  refreshChatImportSources,
  setChatImportStatus,
  useChatImportList,
  type ScopedChatImportSummary,
} from "../lib/chatImportsState";
import { chatImportLifecycleAction } from "../lib/chatImportUi";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const STATUS_TABS: ReadonlyArray<{
  readonly status: ChatImportStatus;
  readonly label: string;
  readonly icon: typeof InboxIcon;
}> = [
  { status: "inbox", label: "Inbox", icon: InboxIcon },
  { status: "library", label: "Library", icon: BookOpenIcon },
  { status: "archived", label: "Archived", icon: ArchiveIcon },
];

function iconForStatus(status: ChatImportStatus) {
  switch (status) {
    case "inbox":
      return CheckIcon;
    case "library":
      return ArchiveIcon;
    case "archived":
      return ArchiveRestoreIcon;
  }
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function ImportRow({
  item,
  environmentName,
  onMove,
}: {
  readonly item: ScopedChatImportSummary;
  readonly environmentName: string;
  readonly onMove: (item: ScopedChatImportSummary, status: ChatImportStatus) => Promise<void>;
}) {
  const [moving, setMoving] = useState(false);
  const action = chatImportLifecycleAction(item.status);
  const ActionIcon = iconForStatus(item.status);
  return (
    <div className="group flex min-w-0 items-center border-b transition-colors hover:bg-muted/45">
      <Link
        to="/imports/$environmentId/$chatImportId"
        params={{ environmentId: item.environmentId, chatImportId: item.id }}
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{item.title}</span>
            {!item.sourceAvailable ? (
              <span className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
                unavailable
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate">{item.projectKey}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{environmentName}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{item.entryCount} events</span>
          </div>
        </div>
        <time className="shrink-0 text-xs text-muted-foreground">
          {formatUpdatedAt(item.sourceUpdatedAt)}
        </time>
      </Link>
      <Button
        size="sm"
        variant="ghost"
        className="mr-4 h-7 shrink-0 gap-1.5 px-2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
        disabled={moving}
        onClick={() => {
          setMoving(true);
          void onMove(item, action.nextStatus).finally(() => setMoving(false));
        }}
      >
        {moving ? (
          <LoaderCircleIcon className="size-3 animate-spin" />
        ) : (
          <ActionIcon className="size-3" />
        )}
        {action.label}
      </Button>
    </div>
  );
}

export function ImportedChatsPage({
  status,
  onStatusChange,
}: {
  readonly status: ChatImportStatus;
  readonly onStatusChange: (status: ChatImportStatus) => void;
}) {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search.trim(), 250);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const { environments } = useEnvironments();
  const importEnvironments = useMemo(
    () =>
      environments.filter(
        (environment) => environment.serverConfig?.environment.capabilities.chatImports === true,
      ),
    [environments],
  );
  const environmentIds = useMemo(
    () => importEnvironments.map((environment) => environment.environmentId),
    [importEnvironments],
  );
  const environmentLabelById = useMemo(
    () =>
      new Map(
        importEnvironments.map((environment) => [environment.environmentId, environment.label]),
      ),
    [importEnvironments],
  );
  const imports = useChatImportList({ environmentIds, status, search: debouncedSearch });
  const total = imports.counts.inbox + imports.counts.library + imports.counts.archived;

  const move = async (item: ScopedChatImportSummary, next: ChatImportStatus) => {
    setActionError(null);
    try {
      await setChatImportStatus(item.environmentId, item.id, next);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not update imported chat.");
    }
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="border-b px-5 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-base font-semibold">Imported chats</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Read-only Cursor histories synchronized across connected environments
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={refreshing || environmentIds.length === 0}
            onClick={() => {
              setRefreshing(true);
              setActionError(null);
              void refreshChatImportSources(environmentIds)
                .catch((error: unknown) =>
                  setActionError(
                    error instanceof Error ? error.message : "Could not refresh imports.",
                  ),
                )
                .finally(() => setRefreshing(false));
            }}
          >
            <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
            Refresh
          </Button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {STATUS_TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <Button
                key={tab.status}
                size="sm"
                variant={status === tab.status ? "secondary" : "ghost"}
                onClick={() => onStatusChange(tab.status)}
              >
                <Icon className="size-3.5" />
                {tab.label}
                <span className="tabular-nums text-muted-foreground">
                  {imports.counts[tab.status]}
                </span>
              </Button>
            );
          })}
          <div className="relative ml-auto min-w-48 flex-1 sm:max-w-72">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search imports"
              className="h-8 pl-8"
            />
          </div>
        </div>
      </header>

      {(actionError ?? imports.error) ? (
        <div className="border-b border-destructive/25 bg-destructive/10 px-5 py-2 text-xs text-destructive">
          {actionError ?? imports.error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {imports.items.map((item) => (
          <ImportRow
            key={`${item.environmentId}:${item.id}`}
            item={item}
            environmentName={environmentLabelById.get(item.environmentId) ?? item.environmentId}
            onMove={move}
          />
        ))}
        {!imports.isLoading && imports.items.length === 0 ? (
          <div className="grid min-h-64 place-items-center p-8 text-center">
            <div>
              <InboxIcon className="mx-auto size-8 text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium">
                {debouncedSearch ? "No matching imported chats" : `No chats in ${status}`}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {environmentIds.length === 0
                  ? "Connect an environment to discover Cursor histories."
                  : total === 0
                    ? "Refresh to scan Cursor transcripts now."
                    : "Chats moved here will appear in this view."}
              </p>
            </div>
          </div>
        ) : null}
        {imports.isLoading && imports.items.length === 0 ? (
          <div className="grid min-h-64 place-items-center">
            <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}
      </div>
    </main>
  );
}
