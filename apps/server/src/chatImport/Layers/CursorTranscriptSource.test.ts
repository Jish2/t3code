// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect } from "vite-plus/test";

import { makeCursorTranscriptSource } from "./CursorTranscriptSource.ts";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => NodeFSP.rm(path, { recursive: true })));
});

describe("CursorTranscriptSource", () => {
  it.effect("discovers parent transcripts and excludes nested subagents", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cursor-import-")),
      );
      cleanupPaths.push(root);
      const transcriptDir = NodePath.join(root, "project-key", "agent-transcripts", "parent-id");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(transcriptDir, "subagents"), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(transcriptDir, "parent-id.jsonl"),
          `${JSON.stringify({
            role: "user",
            message: {
              content: [{ type: "text", text: "<user_query>Parent chat</user_query>" }],
            },
          })}\n`,
        ),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(transcriptDir, "subagents", "child-id.jsonl"),
          `${JSON.stringify({
            role: "user",
            message: {
              content: [{ type: "text", text: "<user_query>Child chat</user_query>" }],
            },
          })}\n`,
        ),
      );

      const source = makeCursorTranscriptSource(root);
      const descriptors = yield* source.discover;
      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        externalId: "parent-id",
        projectKey: "project-key",
        sourceKey: "project-key/parent-id/parent-id.jsonl",
      });

      const loaded = yield* source.load(descriptors[0]!);
      expect(loaded.title).toBe("Parent chat");
      expect(loaded.entries).toHaveLength(1);
    }),
  );
});
