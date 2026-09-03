// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import type { ChatImportContentBlock, ChatImportEntry } from "@t3tools/contracts";

export interface ParsedCursorTranscript {
  readonly title: string;
  readonly entries: ReadonlyArray<ChatImportEntry>;
}

export interface CursorCompletedTurn {
  readonly index: number;
  readonly hash: string;
  readonly status: Extract<ChatImportEntry, { kind: "turn-ended" }>["status"];
  readonly messages: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly text: string;
  }>;
  readonly activities: ReadonlyArray<{
    readonly kind: string;
    readonly summary: string;
    readonly payload: unknown;
  }>;
}

export interface CursorTranscriptTurns {
  readonly completed: ReadonlyArray<CursorCompletedTurn>;
  readonly hasIncompleteTail: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripUserTransportText(text: string): string {
  const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/u.exec(text);
  if (query?.[1]) {
    return query[1].trim();
  }

  return text
    .replace(/<timestamp>[\s\S]*?<\/timestamp>/gu, "")
    .replace(/<manually_attached_skills>[\s\S]*?<\/manually_attached_skills>/gu, "")
    .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/gu, "")
    .trim();
}

function normalizeTitle(text: string, fallback: string): string {
  const words = text.match(/[\p{L}\p{N}#./:_-]+/gu) ?? [];
  const title = words.slice(0, 6).join(" ").trim();
  if (!title) return fallback;
  return title.length > 80 ? `${title.slice(0, 77).trimEnd()}...` : title;
}

function parseMessageBlocks(
  content: unknown,
  role: "user" | "assistant" | "unknown",
): Extract<ChatImportEntry, { kind: "message" }>["blocks"] {
  const rawBlocks = Array.isArray(content) ? content : [content];
  return rawBlocks.flatMap<ChatImportContentBlock>((rawBlock) => {
    if (typeof rawBlock === "string") {
      const text = role === "user" ? stripUserTransportText(rawBlock) : rawBlock.trim();
      return text ? [{ type: "text" as const, text }] : [];
    }
    if (!isRecord(rawBlock)) {
      return rawBlock == null ? [] : [{ type: "unknown" as const, payload: rawBlock }];
    }

    switch (rawBlock.type) {
      case "text": {
        if (typeof rawBlock.text !== "string") {
          return [{ type: "unknown" as const, payload: rawBlock }];
        }
        const text = role === "user" ? stripUserTransportText(rawBlock.text) : rawBlock.text.trim();
        return text ? [{ type: "text" as const, text }] : [];
      }
      case "tool_use":
        return [
          {
            type: "tool-call" as const,
            name:
              typeof rawBlock.name === "string" && rawBlock.name.trim()
                ? rawBlock.name.trim()
                : "tool",
            input: rawBlock.input ?? null,
          },
        ];
      case "tool_result":
        return [{ type: "tool-result" as const, content: rawBlock.content ?? null }];
      default:
        return [{ type: "unknown" as const, payload: rawBlock }];
    }
  });
}

export function parseCursorTranscript(raw: string, fallbackTitle: string): ParsedCursorTranscript {
  const lines = raw.split("\n");
  const entries: ChatImportEntry[] = [];
  let titleText = "";

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!.trim();
    if (!line) continue;

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (cause) {
      throw new Error(`Invalid Cursor transcript JSON on line ${lineIndex + 1}`, { cause });
    }
    if (!isRecord(record)) {
      continue;
    }

    if (record.type === "turn_ended") {
      const status =
        record.status === "success" || record.status === "aborted" || record.status === "error"
          ? record.status
          : "unknown";
      entries.push({
        kind: "turn-ended",
        ordinal: entries.length,
        status,
        error: typeof record.error === "string" ? record.error : null,
      });
      continue;
    }

    if (!("role" in record)) {
      continue;
    }
    const role =
      record.role === "user" || record.role === "assistant" ? record.role : ("unknown" as const);
    const message = isRecord(record.message) ? record.message : record;
    const blocks = parseMessageBlocks(message.content, role);
    if (blocks.length === 0) {
      continue;
    }
    if (!titleText && role === "user") {
      titleText = blocks
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join(" ");
    }
    entries.push({
      kind: "message",
      ordinal: entries.length,
      role,
      blocks,
    });
  }

  return {
    title: normalizeTitle(titleText, fallbackTitle),
    entries,
  };
}

function messageText(entry: Extract<ChatImportEntry, { kind: "message" }>): string {
  return entry.blocks
    .filter(
      (block): block is Extract<ChatImportContentBlock, { type: "text" }> => block.type === "text",
    )
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function messageActivities(
  entry: Extract<ChatImportEntry, { kind: "message" }>,
): CursorCompletedTurn["activities"] {
  const activities: Array<CursorCompletedTurn["activities"][number]> = [];
  for (const block of entry.blocks) {
    switch (block.type) {
      case "text":
        break;
      case "tool-call":
        activities.push({
          kind: "cursor.imported.tool-call",
          summary: `Used ${block.name}`,
          payload: { role: entry.role, name: block.name, input: block.input },
        });
        break;
      case "tool-result":
        activities.push({
          kind: "cursor.imported.tool-result",
          summary: "Cursor tool result",
          payload: { role: entry.role, content: block.content },
        });
        break;
      case "unknown":
        activities.push({
          kind: "cursor.imported.unknown",
          summary: "Imported Cursor activity",
          payload: { role: entry.role, content: block.payload },
        });
        break;
    }
  }
  return activities;
}

export function cursorTranscriptTurns(
  entries: ReadonlyArray<ChatImportEntry>,
): CursorTranscriptTurns {
  const completed: CursorCompletedTurn[] = [];
  let pending: ChatImportEntry[] = [];

  for (const entry of entries) {
    pending.push(entry);
    if (entry.kind !== "turn-ended") {
      continue;
    }
    const messages = pending.flatMap((candidate) => {
      if (candidate.kind !== "message" || candidate.role === "unknown") {
        return [];
      }
      const text = messageText(candidate);
      return text ? [{ role: candidate.role, text }] : [];
    });
    const activities = pending.flatMap((candidate) =>
      candidate.kind === "message" ? messageActivities(candidate) : [],
    );
    if (messages.length > 0 || activities.length > 0) {
      completed.push({
        index: completed.length,
        hash: NodeCrypto.createHash("sha256").update(JSON.stringify(pending)).digest("hex"),
        status: entry.status,
        messages,
        activities,
      });
    }
    pending = [];
  }

  return {
    completed,
    hasIncompleteTail: pending.some((entry) => entry.kind === "message"),
  };
}
