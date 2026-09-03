import type {
  ChatImportLiveSyncState,
  ChatImportStatus,
  ChatImportSyncState,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

export interface ChatImportLifecycleAction {
  readonly nextStatus: ChatImportStatus;
  readonly label: "Keep" | "Archive" | "Restore";
}

export function chatImportLifecycleAction(status: ChatImportStatus): ChatImportLifecycleAction {
  switch (status) {
    case "inbox":
      return { nextStatus: "library", label: "Keep" };
    case "library":
      return { nextStatus: "archived", label: "Archive" };
    case "archived":
      return { nextStatus: "library", label: "Restore" };
  }
}

export function suggestedChatImportProjectId(
  workspaceRoots: ReadonlyArray<string>,
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>,
): ProjectId | null {
  const exactMatch = projects.find((project) => workspaceRoots.includes(project.workspaceRoot));
  if (exactMatch !== undefined) return exactMatch.id;
  return workspaceRoots.length === 0 && projects.length === 1 ? projects[0]!.id : null;
}

export function chatImportLiveSyncAction(
  state: ChatImportLiveSyncState | null,
): "enable" | "disable" | null {
  if (state === null || state === "unavailable") return null;
  return state === "installed" ? "disable" : "enable";
}

export function chatImportSyncNotice(syncState: ChatImportSyncState): {
  readonly title: string;
  readonly blocksSend: boolean;
} | null {
  switch (syncState) {
    case "idle":
      return null;
    case "cursor-active":
      return { title: "Cursor is responding", blocksSend: false };
    case "t3-active":
      return { title: "Syncing Cursor changes", blocksSend: false };
    case "conflict":
      return { title: "Cursor history conflict", blocksSend: true };
  }
}

export function adoptedChatNavigation(environmentId: EnvironmentId, threadId: ThreadId) {
  return {
    to: "/$environmentId/$threadId" as const,
    params: { environmentId, threadId },
  };
}
