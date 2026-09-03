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
import { useEffect, useMemo, useState } from "react";

import {
  adoptChatImport,
  resolveChatImportConflict,
  setChatImportStatus,
  useChatImportDetail,
} from "../lib/chatImportsState";
import {
  adoptedChatNavigation,
  chatImportLifecycleAction,
  suggestedChatImportProjectId,
} from "../lib/chatImportUi";
import { newMessageId, newThreadId, cn } from "../lib/utils";
import { useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";
import ChatMarkdown from "./ChatMarkdown";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

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
  const projects = useProjects();
  const { environments } = useEnvironments();
  const continuationSupported =
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.environment.capabilities.chatImportContinuation === true;
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [environmentId, projects],
  );
  const [moving, setMoving] = useState(false);
  const [sending, setSending] = useState(false);
  const [resolvingConflict, setResolvingConflict] = useState<
    "keep-t3" | "accept-cursor-tail" | null
  >(null);
  const [prompt, setPrompt] = useState("");
  const [projectId, setProjectId] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const maybeDetail = imported.detail;
  const suggestedProjectId = useMemo(
    () =>
      maybeDetail === null
        ? null
        : suggestedChatImportProjectId(maybeDetail.workspaceRoots, environmentProjects),
    [environmentProjects, maybeDetail],
  );
  useEffect(() => {
    if (!maybeDetail || projectId) return;
    setProjectId(suggestedProjectId ?? "");
  }, [maybeDetail, projectId, suggestedProjectId]);

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
  const resolveConflict = (resolution: "keep-t3" | "accept-cursor-tail") => {
    if (detail.linkedThreadId === null || resolvingConflict !== null) return;
    setResolvingConflict(resolution);
    setActionError(null);
    void resolveChatImportConflict({
      environmentId,
      id: detail.id,
      resolution,
      ...(resolution === "accept-cursor-tail" ? { replacementThreadId: newThreadId() } : {}),
    })
      .then((resolvedThreadId) => navigate(adoptedChatNavigation(environmentId, resolvedThreadId)))
      .catch((cause: unknown) =>
        setActionError(
          cause instanceof Error ? cause.message : "Could not resolve the Cursor conflict.",
        ),
      )
      .finally(() => setResolvingConflict(null));
  };

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
      {continuationSupported ? (
        <form
          className="border-t bg-background px-5 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            const text = prompt.trim();
            const project = environmentProjects.find((candidate) => candidate.id === projectId);
            if (!text || !project || sending) return;
            const threadId = newThreadId();
            setSending(true);
            setActionError(null);
            void adoptChatImport({
              environmentId,
              id: detail.id,
              projectId: project.id,
              threadId,
              messageId: newMessageId(),
              text,
              createdAt: new Date().toISOString(),
            })
              .then((adoptedThreadId) =>
                navigate(adoptedChatNavigation(environmentId, adoptedThreadId)),
              )
              .catch((error: unknown) =>
                setActionError(
                  error instanceof Error ? error.message : "Could not send to this Cursor chat.",
                ),
              )
              .finally(() => setSending(false));
          }}
        >
          <div className="mx-auto max-w-4xl space-y-2">
            {suggestedProjectId === null &&
            (environmentProjects.length > 1 || (environmentProjects.length === 1 && !projectId)) ? (
              <select
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                className="h-8 max-w-full rounded-md border bg-background px-2 text-xs"
                aria-label="T3 project"
              >
                <option value="">Choose a project</option>
                {environmentProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title} — {project.workspaceRoot}
                  </option>
                ))}
              </select>
            ) : null}
            {environmentProjects.length === 0 ? (
              <p className="text-xs text-destructive">
                Add this Cursor workspace as a T3 project before continuing.
              </p>
            ) : null}
            <div className="flex items-end gap-2">
              <Textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={
                  detail.syncState === "cursor-active"
                    ? "Cursor is responding…"
                    : "Message this Cursor conversation"
                }
                disabled={sending || !detail.sourceAvailable || detail.syncState === "conflict"}
                className="min-h-20 resize-y"
              />
              <Button
                type="submit"
                disabled={
                  sending ||
                  !prompt.trim() ||
                  !projectId ||
                  !detail.sourceAvailable ||
                  detail.syncState === "conflict"
                }
              >
                {sending ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
                Send
              </Button>
            </div>
            {detail.syncState === "cursor-active" ? (
              <p className="text-xs text-muted-foreground">
                Cursor is responding. T3 will wait before sending.
              </p>
            ) : detail.syncState === "conflict" ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-destructive">
                <p>
                  {detail.linkedThreadId === null
                    ? "The Cursor source could not be validated. Sync the transcript before retrying."
                    : "Cursor history changed unexpectedly. Choose which history to continue."}
                </p>
                {detail.linkedThreadId !== null ? (
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={resolvingConflict !== null}
                      onClick={() => resolveConflict("keep-t3")}
                    >
                      {resolvingConflict === "keep-t3" ? "Keeping..." : "Keep T3"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={resolvingConflict !== null}
                      onClick={() => resolveConflict("accept-cursor-tail")}
                    >
                      {resolvingConflict === "accept-cursor-tail"
                        ? "Accepting..."
                        : "Accept Cursor"}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </form>
      ) : (
        <div className="border-t px-5 py-3 text-center text-xs text-muted-foreground">
          Update this environment to continue imported Cursor chats from T3.
        </div>
      )}
    </main>
  );
}
