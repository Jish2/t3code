import { describe, expect, it } from "vitest";

import { chatImportLifecycleAction } from "./chatImportUi";

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
