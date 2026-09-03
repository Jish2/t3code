// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ChatImportId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { parseCursorTranscript } from "../CursorTranscriptParser.ts";
import {
  ChatImportSource,
  ChatImportSourceError,
  type ChatImportSourceDescriptor,
  type ChatImportSourceShape,
} from "../Services/ChatImportSource.ts";

function digest(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function importId(sourceKey: string): ChatImportId {
  return ChatImportId.make(`cursor:${digest(sourceKey)}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
}

async function discoverCursorTranscripts(
  projectsRoot: string,
): Promise<ReadonlyArray<ChatImportSourceDescriptor>> {
  if (!(await pathExists(projectsRoot))) {
    return [];
  }

  const projectEntries = await NodeFSP.readdir(projectsRoot, { withFileTypes: true });
  const descriptors: ChatImportSourceDescriptor[] = [];
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const projectKey = projectEntry.name;
    const transcriptsRoot = NodePath.join(projectsRoot, projectKey, "agent-transcripts");
    if (!(await pathExists(transcriptsRoot))) continue;

    const transcriptEntries = await NodeFSP.readdir(transcriptsRoot, { withFileTypes: true });
    for (const transcriptEntry of transcriptEntries) {
      let sourcePath: string | null = null;
      let relativePath: string | null = null;
      let externalId: string | null = null;
      if (transcriptEntry.isDirectory()) {
        externalId = transcriptEntry.name;
        relativePath = NodePath.join(transcriptEntry.name, `${transcriptEntry.name}.jsonl`);
        sourcePath = NodePath.join(transcriptsRoot, relativePath);
      } else if (transcriptEntry.isFile() && transcriptEntry.name.endsWith(".jsonl")) {
        externalId = transcriptEntry.name.slice(0, -".jsonl".length);
        relativePath = transcriptEntry.name;
        sourcePath = NodePath.join(transcriptsRoot, relativePath);
      }
      if (!sourcePath || !relativePath || !externalId || !(await pathExists(sourcePath))) {
        continue;
      }

      const stat = await NodeFSP.stat(sourcePath);
      if (!stat.isFile()) continue;
      const sourceKey = `${projectKey}/${relativePath.split(NodePath.sep).join("/")}`;
      descriptors.push({
        id: importId(sourceKey),
        source: "cursor",
        sourceKey,
        externalId,
        projectKey,
        sourcePath,
        sourceUpdatedAt: stat.mtime.toISOString(),
        sourceMtimeMs: stat.mtimeMs,
        sourceSize: stat.size,
      });
    }
  }

  return descriptors.toSorted((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}

async function describeCursorTranscriptPath(
  projectsRoot: string,
  inputPath: string,
): Promise<ChatImportSourceDescriptor | null> {
  const sourcePath = NodePath.resolve(inputPath);
  const relative = NodePath.relative(NodePath.resolve(projectsRoot), sourcePath);
  if (!relative || relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    return null;
  }
  const parts = relative.split(NodePath.sep);
  if (parts.length < 3 || parts[1] !== "agent-transcripts" || parts.includes("subagents")) {
    return null;
  }
  const projectKey = parts[0]!;
  const transcriptParts = parts.slice(2);
  const filename = transcriptParts.at(-1);
  if (!filename?.endsWith(".jsonl")) {
    return null;
  }
  const externalId = filename.slice(0, -".jsonl".length);
  if (
    transcriptParts.length > 2 ||
    (transcriptParts.length === 2 && transcriptParts[0] !== externalId)
  ) {
    return null;
  }
  let stat: NodeFS.Stats;
  try {
    stat = await NodeFSP.stat(sourcePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    return null;
  }
  const transcriptRelativePath = transcriptParts.join("/");
  const sourceKey = `${projectKey}/${transcriptRelativePath}`;
  return {
    id: importId(sourceKey),
    source: "cursor",
    sourceKey,
    externalId,
    projectKey,
    sourcePath,
    sourceUpdatedAt: stat.mtime.toISOString(),
    sourceMtimeMs: stat.mtimeMs,
    sourceSize: stat.size,
  };
}

export function makeCursorTranscriptSource(
  projectsRoot = NodePath.join(NodeOS.homedir(), ".cursor", "projects"),
): ChatImportSourceShape {
  return {
    source: "cursor",
    discover: Effect.tryPromise({
      try: () => discoverCursorTranscripts(projectsRoot),
      catch: (cause) =>
        new ChatImportSourceError({
          operation: "discover",
          path: projectsRoot,
          detail: `Failed to discover Cursor transcripts under ${projectsRoot}`,
          cause,
        }),
    }),
    describePath: (sourcePath) =>
      Effect.tryPromise({
        try: () => describeCursorTranscriptPath(projectsRoot, sourcePath),
        catch: (cause) =>
          new ChatImportSourceError({
            operation: "describe",
            path: sourcePath,
            detail: `Failed to inspect Cursor transcript at ${sourcePath}`,
            cause,
          }),
      }),
    load: (descriptor) =>
      Effect.tryPromise({
        try: async () => {
          const before = await NodeFSP.stat(descriptor.sourcePath);
          const raw = await NodeFSP.readFile(descriptor.sourcePath, "utf8");
          const after = await NodeFSP.stat(descriptor.sourcePath);
          if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
            throw new Error("Cursor transcript changed while it was being imported");
          }
          const parsed = parseCursorTranscript(raw, descriptor.externalId);
          return {
            ...descriptor,
            sourceUpdatedAt: after.mtime.toISOString(),
            sourceMtimeMs: after.mtimeMs,
            sourceSize: after.size,
            title: parsed.title,
            contentDigest: digest(raw),
            entries: parsed.entries,
          };
        },
        catch: (cause) =>
          new ChatImportSourceError({
            operation: "load",
            path: descriptor.sourcePath,
            detail: cause instanceof Error ? cause.message : "Failed to read Cursor transcript",
            cause,
          }),
      }),
    watch: (onChange) =>
      Effect.acquireRelease(
        Effect.try({
          try: () =>
            NodeFS.watch(projectsRoot, { recursive: true }, (_eventType, filename) => {
              if (filename === null) {
                onChange(null);
                return;
              }
              onChange(NodePath.resolve(projectsRoot, filename));
            }),
          catch: (cause) =>
            new ChatImportSourceError({
              operation: "watch",
              path: projectsRoot,
              detail: `Failed to watch Cursor transcripts under ${projectsRoot}`,
              cause,
            }),
        }),
        (watcher) => Effect.sync(() => watcher.close()),
      ).pipe(Effect.asVoid),
  };
}

export const CursorTranscriptSourceLive = Layer.succeed(
  ChatImportSource,
  makeCursorTranscriptSource(),
);
