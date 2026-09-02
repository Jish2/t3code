import { EnvironmentId, type ChatImportStatus } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  BookOpenIcon,
  CheckIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";

import { setChatImportStatus, useChatImportDetail } from "../lib/chatImportsState";
import { chatImportLifecycleAction } from "../lib/chatImportUi";
import { cn } from "../lib/utils";
import ChatMarkdown from "./ChatMarkdown";
import { Button } from "./ui/button";

function prettyPayload(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

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

export function ImportedChatDetail({
  environmentId: rawEnvironmentId,
  chatImportId,
}: {
  readonly environmentId: string;
  readonly chatImportId: string;
}) {
  const environmentId = EnvironmentId.make(rawEnvironmentId);
  const navigate = useNavigate();
  const imported = useChatImportDetail(environmentId, chatImportId);
  const [moving, setMoving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (imported.isLoading && !imported.detail) {
    return (
      <main className="grid min-h-0 flex-1 place-items-center bg-background">
        <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (!imported.detail) {
    return (
      <main className="grid min-h-0 flex-1 place-items-center bg-background p-6 text-center">
        <div>
          <BookOpenIcon className="mx-auto size-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium">Imported chat unavailable</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {imported.error ?? "The imported chat could not be loaded."}
          </p>
          <Button
            render={<Link to="/imports" search={{ status: "inbox" }} />}
            size="sm"
            variant="outline"
            className="mt-4"
          >
            Back to imports
          </Button>
        </div>
      </main>
    );
  }

  const detail = imported.detail;
  const action = chatImportLifecycleAction(detail.status);
  const ActionIcon = iconForStatus(detail.status);

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="border-b px-4 py-3">
        <div className="mx-auto flex max-w-4xl items-start gap-3">
          <Button
            render={
              <Link
                to="/imports"
                search={{ status: "inbox" }}
                aria-label="Back to imported chats"
              />
            }
            size="icon"
            variant="ghost"
            className="mt-0.5 size-8 shrink-0"
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">{detail.title}</h1>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              Cursor · {detail.projectKey} · {environmentId}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={imported.refresh}
            disabled={imported.isLoading}
          >
            <RefreshCwIcon className={cn("size-3.5", imported.isLoading && "animate-spin")} />
            Sync
          </Button>
          <Button
            size="sm"
            disabled={moving}
            onClick={() => {
              setMoving(true);
              setActionError(null);
              void setChatImportStatus(environmentId, detail.id, action.nextStatus)
                .then(() => navigate({ to: "/imports", search: { status: action.nextStatus } }))
                .catch((error: unknown) =>
                  setActionError(
                    error instanceof Error ? error.message : "Could not update imported chat.",
                  ),
                )
                .finally(() => setMoving(false));
            }}
          >
            {moving ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <ActionIcon className="size-3.5" />
            )}
            {action.label}
          </Button>
        </div>
      </header>
      {(actionError ?? imported.error ?? detail.syncError) ? (
        <div className="border-b border-warning/25 bg-warning/10 px-5 py-2 text-center text-xs text-warning">
          {actionError ?? imported.error ?? detail.syncError}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-5 px-5 py-6">
          {!detail.sourceAvailable ? (
            <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              The Cursor transcript is no longer available. This is the latest synchronized copy.
            </div>
          ) : null}
          {detail.entries.map((entry) => {
            if (entry.kind === "turn-ended") {
              return (
                <div
                  key={entry.ordinal}
                  className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground"
                >
                  <span className="h-px flex-1 bg-border" />
                  Turn {entry.status}
                  {entry.error ? `: ${entry.error}` : ""}
                  <span className="h-px flex-1 bg-border" />
                </div>
              );
            }
            return (
              <section
                key={entry.ordinal}
                className={cn(
                  "rounded-lg border p-4",
                  entry.role === "user" ? "bg-muted/35" : "bg-card",
                )}
              >
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {entry.role}
                </div>
                <div className="space-y-3">
                  {entry.blocks.map((block, blockIndex) => {
                    const key = `${entry.ordinal}:${blockIndex}`;
                    if (block.type === "text") {
                      return <ChatMarkdown key={key} text={block.text} cwd={undefined} />;
                    }
                    if (block.type === "tool-call") {
                      return (
                        <details key={key} className="rounded-md border bg-muted/25">
                          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium">
                            <WrenchIcon className="size-3.5 text-muted-foreground" />
                            {block.name}
                          </summary>
                          <pre className="max-h-80 overflow-auto border-t px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                            {prettyPayload(block.input)}
                          </pre>
                        </details>
                      );
                    }
                    return (
                      <details key={key} className="rounded-md border bg-muted/25">
                        <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
                          {block.type === "tool-result" ? "Tool result" : "Unrecognized content"}
                        </summary>
                        <pre className="max-h-80 overflow-auto border-t px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                          {prettyPayload(
                            block.type === "tool-result" ? block.content : block.payload,
                          )}
                        </pre>
                      </details>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {detail.entries.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              This transcript has no displayable messages.
            </p>
          ) : null}
        </div>
      </div>
    </main>
  );
}
