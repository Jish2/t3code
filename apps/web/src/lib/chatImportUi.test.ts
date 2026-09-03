import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  chatImportLifecycleAction,
  chatImportLiveSyncAction,
  chatImportSyncNotice,
  adoptedChatNavigation,
  suggestedChatImportProjectId,
} from "./chatImportUi";

describe("chatImportLifecycleAction", () => {
  it("maps imported chat states to the available lifecycle action", () => {
    expect(chatImportLifecycleAction("inbox")).toEqual({
      nextStatus: "library",
      label: "Keep",
    });
    expect(chatImportLifecycleAction("library")).toEqual({
      nextStatus: "archived",
      label: "Archive",
    });
    expect(chatImportLifecycleAction("archived")).toEqual({
      nextStatus: "library",
      label: "Restore",
    });
  });
});

describe("Cursor continuation UI", () => {
  it("prompts before installing hooks and exposes installed-hook removal", () => {
    expect(chatImportLiveSyncAction("not-installed")).toBe("enable");
    expect(chatImportLiveSyncAction("error")).toBe("enable");
    expect(chatImportLiveSyncAction("installed")).toBe("disable");
    expect(chatImportLiveSyncAction("unavailable")).toBeNull();
  });

  it("automatically selects only safe workspace matches", () => {
    const first = {
      id: ProjectId.make("first"),
      workspaceRoot: "/workspace/first",
    };
    const second = {
      id: ProjectId.make("second"),
      workspaceRoot: "/workspace/second",
    };
    expect(suggestedChatImportProjectId(["/workspace/second"], [first, second])).toBe(second.id);
    expect(suggestedChatImportProjectId(["/workspace/other"], [first, second])).toBeNull();
    expect(suggestedChatImportProjectId([], [first])).toBe(first.id);
  });

  it("keeps Cursor-active sends queued and blocks only conflicts", () => {
    expect(chatImportSyncNotice("cursor-active")).toEqual({
      title: "Cursor is responding",
      blocksSend: false,
    });
    expect(chatImportSyncNotice("t3-active")).toEqual({
      title: "Syncing Cursor changes",
      blocksSend: false,
    });
    expect(chatImportSyncNotice("conflict")).toEqual({
      title: "Cursor history conflict",
      blocksSend: true,
    });
    expect(chatImportSyncNotice("idle")).toBeNull();
  });

  it("navigates invisible adoption to the returned native thread", () => {
    const environmentId = EnvironmentId.make("environment");
    const threadId = ThreadId.make("adopted-thread");
    expect(adoptedChatNavigation(environmentId, threadId)).toEqual({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  });
});
