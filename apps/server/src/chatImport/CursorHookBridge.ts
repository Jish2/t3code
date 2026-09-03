// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics globalTimers:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { ChatImportLiveSyncStatus } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

const MANAGED_HOOK_MARKER = "--t3-cursor-live-sync-v1";
const BRIDGE_FILENAME = "cursor-live-sync-hook.mjs";

export interface CursorHookEvent {
  readonly hook_event_name: "beforeSubmitPrompt" | "stop";
  readonly conversation_id: string;
  readonly generation_id: string;
  readonly transcript_path: string | null;
  readonly workspace_roots: ReadonlyArray<string>;
  readonly status?: "completed" | "aborted" | "error";
}

interface CursorHooksConfig {
  readonly version?: unknown;
  readonly hooks?: unknown;
  readonly [key: string]: unknown;
}

interface CursorHookDefinition {
  readonly command?: unknown;
  readonly [key: string]: unknown;
}

class CursorHookBridgeError extends Data.TaggedError("CursorHookBridgeError")<{
  readonly cause: unknown;
}> {}

export interface CursorHookBridgeOptions {
  readonly stateDir: string;
  readonly platform: NodeJS.Platform;
  readonly cursorDir?: string;
  readonly runtimePath?: string;
  readonly electronRuntime?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
}

function decodeHookEvent(value: unknown): CursorHookEvent | null {
  if (!isRecord(value)) return null;
  if (value.hook_event_name !== "beforeSubmitPrompt" && value.hook_event_name !== "stop") {
    return null;
  }
  if (typeof value.conversation_id !== "string" || typeof value.generation_id !== "string") {
    return null;
  }
  const workspaceRoots = Array.isArray(value.workspace_roots)
    ? value.workspace_roots.filter((entry): entry is string => typeof entry === "string")
    : [];
  const transcriptPath = typeof value.transcript_path === "string" ? value.transcript_path : null;
  const status =
    value.status === "completed" || value.status === "aborted" || value.status === "error"
      ? value.status
      : undefined;
  return {
    hook_event_name: value.hook_event_name,
    conversation_id: value.conversation_id,
    generation_id: value.generation_id,
    transcript_path: transcriptPath,
    workspace_roots: workspaceRoots,
    ...(status ? { status } : {}),
  };
}

function shellQuote(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function bridgeSource(spoolDir: string): string {
  return `import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString("utf8");
const payload = JSON.parse(raw);
const spoolDir = ${JSON.stringify(spoolDir)};
await mkdir(spoolDir, { recursive: true });
const eventOrder = payload.hook_event_name === "beforeSubmitPrompt" ? "0" : "1";
const name = \`\${Date.now()}-\${eventOrder}-\${randomUUID()}.json\`;
const target = join(spoolDir, name);
const temporary = \`\${target}.tmp\`;
await writeFile(temporary, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
await rename(temporary, target);
process.stdout.write(
  payload.hook_event_name === "beforeSubmitPrompt" ? '{"continue":true}' : "{}",
);
`;
}

function hookCommand(input: {
  readonly runtimePath: string;
  readonly bridgePath: string;
  readonly electronRuntime: boolean;
  readonly platform: NodeJS.Platform;
}): string {
  const invocation = `${shellQuote(input.runtimePath, input.platform)} ${shellQuote(input.bridgePath, input.platform)} ${MANAGED_HOOK_MARKER}`;
  if (!input.electronRuntime) return invocation;
  return input.platform === "win32"
    ? `set "ELECTRON_RUN_AS_NODE=1" && ${invocation}`
    : `ELECTRON_RUN_AS_NODE=1 ${invocation}`;
}

function readHookDefinitions(value: unknown): ReadonlyArray<CursorHookDefinition> {
  return Array.isArray(value)
    ? value.filter((entry): entry is CursorHookDefinition => isRecord(entry))
    : [];
}

export function makeCursorHookBridge(options: CursorHookBridgeOptions) {
  const cursorDir = options.cursorDir ?? NodePath.join(NodeOS.homedir(), ".cursor");
  const hooksPath = NodePath.join(cursorDir, "hooks.json");
  const managedDir = NodePath.join(options.stateDir, "cursor-live-sync");
  const bridgePath = NodePath.join(managedDir, BRIDGE_FILENAME);
  const spoolDir = NodePath.join(managedDir, "events");
  const runtimePath = options.runtimePath ?? process.execPath;
  const command = hookCommand({
    runtimePath,
    bridgePath,
    electronRuntime: options.electronRuntime ?? Boolean(process.versions.electron),
    platform: options.platform,
  });

  const readConfig = async (): Promise<CursorHooksConfig> => {
    try {
      const raw = await NodeFSP.readFile(hooksPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) {
        throw new Error("Cursor hooks configuration must contain a JSON object.");
      }
      return parsed;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw cause;
    }
  };

  const status = Effect.promise(async (): Promise<ChatImportLiveSyncStatus> => {
    try {
      const config = await readConfig();
      const hooks = isRecord(config.hooks) ? config.hooks : {};
      const bridgeAvailable = await pathExists(bridgePath);
      const installed =
        bridgeAvailable &&
        ["beforeSubmitPrompt", "stop"].every((eventName) =>
          readHookDefinitions(hooks[eventName]).some(
            (definition) => definition.command === command,
          ),
        );
      return installed
        ? { state: "installed", message: null }
        : { state: "not-installed", message: null };
    } catch (cause) {
      return {
        state: "error",
        message: cause instanceof Error ? cause.message : "Cursor hooks configuration is invalid.",
      };
    }
  });

  const install = Effect.tryPromise({
    try: async (): Promise<ChatImportLiveSyncStatus> => {
      const config = await readConfig();
      const existingHooks = isRecord(config.hooks) ? config.hooks : {};
      const hooks: Record<string, unknown> = { ...existingHooks };
      for (const eventName of ["beforeSubmitPrompt", "stop"]) {
        const retained = readHookDefinitions(existingHooks[eventName]).filter(
          (definition) =>
            typeof definition.command !== "string" ||
            !definition.command.includes(MANAGED_HOOK_MARKER),
        );
        hooks[eventName] = [
          ...retained,
          {
            command,
            timeout: 2,
            failClosed: false,
          },
        ];
      }

      await NodeFSP.mkdir(managedDir, { recursive: true });
      await NodeFSP.mkdir(spoolDir, { recursive: true });
      await NodeFSP.mkdir(cursorDir, { recursive: true });
      await NodeFSP.writeFile(bridgePath, bridgeSource(spoolDir), "utf8");
      const temporary = `${hooksPath}.${NodeCrypto.randomUUID()}.tmp`;
      await NodeFSP.writeFile(
        temporary,
        `${JSON.stringify({ ...config, version: 1, hooks }, null, 2)}\n`,
        "utf8",
      );
      await NodeFSP.rename(temporary, hooksPath);
      return { state: "installed", message: null };
    },
    catch: (cause) => new CursorHookBridgeError({ cause }),
  });

  const uninstall = Effect.tryPromise({
    try: async (): Promise<ChatImportLiveSyncStatus> => {
      const config = await readConfig();
      const existingHooks = isRecord(config.hooks) ? config.hooks : {};
      const hooks: Record<string, unknown> = { ...existingHooks };
      for (const eventName of ["beforeSubmitPrompt", "stop"]) {
        const retained = readHookDefinitions(existingHooks[eventName]).filter(
          (definition) =>
            typeof definition.command !== "string" ||
            !definition.command.includes(MANAGED_HOOK_MARKER),
        );
        if (retained.length === 0) {
          delete hooks[eventName];
        } else {
          hooks[eventName] = retained;
        }
      }

      await NodeFSP.mkdir(cursorDir, { recursive: true });
      const temporary = `${hooksPath}.${NodeCrypto.randomUUID()}.tmp`;
      await NodeFSP.writeFile(
        temporary,
        `${JSON.stringify({ ...config, version: 1, hooks }, null, 2)}\n`,
        "utf8",
      );
      await NodeFSP.rename(temporary, hooksPath);
      await NodeFSP.rm(bridgePath, { force: true });
      return { state: "not-installed", message: null };
    },
    catch: (cause) => new CursorHookBridgeError({ cause }),
  });

  const start = (
    onEvent: (event: CursorHookEvent) => Promise<void>,
  ): Effect.Effect<void, never, import("effect/Scope").Scope> =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(spoolDir, { recursive: true });
          let processing = false;
          let rerun = false;
          let retryTimer: NodeJS.Timeout | null = null;
          const processPending = async (): Promise<void> => {
            if (processing) {
              rerun = true;
              return;
            }
            processing = true;
            try {
              do {
                rerun = false;
                const pendingEvents = await Promise.all(
                  (await NodeFSP.readdir(spoolDir))
                    .filter((name) => name.endsWith(".json"))
                    .map(async (name) => ({
                      name,
                      modifiedAt: (
                        await NodeFSP.stat(NodePath.join(spoolDir, name), {
                          bigint: true,
                        })
                      ).mtimeNs,
                    })),
                );
                pendingEvents.sort((left, right) =>
                  left.modifiedAt === right.modifiedAt
                    ? left.name.localeCompare(right.name)
                    : left.modifiedAt < right.modifiedAt
                      ? -1
                      : 1,
                );
                for (const { name } of pendingEvents) {
                  const path = NodePath.join(spoolDir, name);
                  let event: CursorHookEvent | null;
                  try {
                    event = decodeHookEvent(JSON.parse(await NodeFSP.readFile(path, "utf8")));
                  } catch {
                    await NodeFSP.unlink(path).catch(() => undefined);
                    continue;
                  }
                  if (event === null) {
                    await NodeFSP.unlink(path).catch(() => undefined);
                    continue;
                  }
                  try {
                    await onEvent(event);
                    await NodeFSP.unlink(path);
                  } catch {
                    // Keep valid events until reconciliation acknowledges them.
                    if (retryTimer === null) {
                      retryTimer = setTimeout(() => {
                        retryTimer = null;
                        void processPending();
                      }, 1_000);
                    }
                    return;
                  }
                }
              } while (rerun);
            } finally {
              processing = false;
            }
          };
          const watcher = NodeFS.watch(spoolDir, () => {
            void processPending();
          });
          await processPending();
          return {
            close: () => {
              watcher.close();
              if (retryTimer !== null) clearTimeout(retryTimer);
            },
          };
        },
        catch: (cause) => new CursorHookBridgeError({ cause }),
      }).pipe(Effect.orDie),
      (watcher) => Effect.sync(() => watcher.close()),
    ).pipe(Effect.asVoid);

  return {
    hooksPath,
    bridgePath,
    spoolDir,
    status,
    install,
    uninstall,
    start,
  };
}
