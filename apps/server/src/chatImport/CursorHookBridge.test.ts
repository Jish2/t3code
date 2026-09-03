// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect } from "vitest";

import { makeCursorHookBridge, type CursorHookEvent } from "./CursorHookBridge.ts";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => NodeFSP.rm(path, { recursive: true })));
});

function runBridgeScript(path: string, payload: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(process.execPath, [path, "--t3-cursor-live-sync-v1"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Hook bridge exited ${code}: ${stderr}`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

describe("CursorHookBridge", () => {
  it.effect("preserves unrelated hooks and durably replays a spooled event", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cursor-hook-")),
      );
      cleanupPaths.push(root);
      const cursorDir = NodePath.join(root, ".cursor");
      const stateDir = NodePath.join(root, "state");
      yield* Effect.promise(() => NodeFSP.mkdir(cursorDir, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(cursorDir, "hooks.json"),
          JSON.stringify({
            version: 1,
            custom: { retained: true },
            hooks: {
              stop: [{ command: "./unrelated-stop.sh" }],
              afterFileEdit: [{ command: "./format.sh" }],
            },
          }),
        ),
      );

      const bridge = makeCursorHookBridge({
        cursorDir,
        stateDir,
        platform: "darwin",
        runtimePath: process.execPath,
        electronRuntime: false,
      });
      expect(yield* bridge.status).toEqual({
        state: "not-installed",
        message: null,
      });
      expect(yield* bridge.install).toEqual({
        state: "installed",
        message: null,
      });
      expect(yield* bridge.install).toEqual({
        state: "installed",
        message: null,
      });

      const config = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(bridge.hooksPath, "utf8")),
      ) as {
        custom: unknown;
        hooks: Record<string, Array<{ command: string }>>;
      };
      expect(config.custom).toEqual({ retained: true });
      expect(config.hooks.afterFileEdit).toEqual([{ command: "./format.sh" }]);
      expect(config.hooks.stop?.[0]).toEqual({ command: "./unrelated-stop.sh" });
      expect(config.hooks.stop?.[1]?.command).toContain("--t3-cursor-live-sync-v1");
      expect(config.hooks.beforeSubmitPrompt?.[0]?.command).toContain("--t3-cursor-live-sync-v1");
      expect(
        config.hooks.stop?.filter(({ command }) => command.includes("--t3-cursor-live-sync-v1")),
      ).toHaveLength(1);
      expect(
        config.hooks.beforeSubmitPrompt?.filter(({ command }) =>
          command.includes("--t3-cursor-live-sync-v1"),
        ),
      ).toHaveLength(1);

      const payload = {
        hook_event_name: "stop",
        conversation_id: "conversation",
        generation_id: "generation",
        transcript_path: "/tmp/conversation.jsonl",
        workspace_roots: ["/tmp/project"],
        status: "completed",
      } as const;
      expect(yield* Effect.promise(() => runBridgeScript(bridge.bridgePath, payload))).toBe("{}");

      let resolveEvent!: (event: CursorHookEvent) => void;
      const received = new Promise<CursorHookEvent>((resolve) => {
        resolveEvent = resolve;
      });
      const event = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* bridge.start(async (hookEvent) => resolveEvent(hookEvent));
          return yield* Effect.promise(() => received);
        }),
      );
      expect(event).toEqual(payload);
      expect(
        (yield* Effect.promise(() => NodeFSP.readdir(bridge.spoolDir))).filter((name) =>
          name.endsWith(".json"),
        ),
      ).toEqual([]);

      yield* Effect.promise(() => runBridgeScript(bridge.bridgePath, payload));
      yield* Effect.promise(() =>
        runBridgeScript(bridge.bridgePath, { ...payload, generation_id: "generation-2" }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* bridge.start(async () => Promise.reject(new Error("reconciliation failed")));
        }),
      );
      expect(
        (yield* Effect.promise(() => NodeFSP.readdir(bridge.spoolDir))).filter((name) =>
          name.endsWith(".json"),
        ),
      ).toHaveLength(2);

      expect(yield* bridge.uninstall).toEqual({
        state: "not-installed",
        message: null,
      });
      expect(yield* bridge.status).toEqual({
        state: "not-installed",
        message: null,
      });
      const uninstalledConfig = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(bridge.hooksPath, "utf8")),
      ) as {
        hooks: Record<string, Array<{ command: string }>>;
      };
      expect(uninstalledConfig.hooks.stop).toEqual([{ command: "./unrelated-stop.sh" }]);
      expect(uninstalledConfig.hooks.beforeSubmitPrompt).toBeUndefined();
    }),
  );
});
