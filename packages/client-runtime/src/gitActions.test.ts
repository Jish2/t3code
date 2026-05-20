import type { VcsStatusResult } from "@t3tools/contracts";
import { assert, describe, it } from "vitest";

import { buildMenuItems, resolveQuickAction } from "./gitActions.ts";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("git action logic", () => {
  it("offers repository publishing when a clean ref has commits but no primary remote", () => {
    const quickAction = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
      }),
      false,
      false,
      false,
    );

    assert.deepEqual(quickAction, {
      kind: "open_publish",
      label: "Publish repository",
      disabled: false,
    });
  });

  it("keeps only commit in the menu when no primary remote exists", () => {
    const items = buildMenuItems(
      status({
        hasUpstream: false,
        aheadCount: 2,
      }),
      false,
      false,
    );

    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
    ]);
  });
});
