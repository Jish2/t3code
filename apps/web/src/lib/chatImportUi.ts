import type { ChatImportStatus } from "@t3tools/contracts";

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
