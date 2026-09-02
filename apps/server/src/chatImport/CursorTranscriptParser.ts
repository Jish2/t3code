import type { ChatImportContentBlock, ChatImportEntry } from "@t3tools/contracts";

export interface ParsedCursorTranscript {
  readonly title: string;
  readonly entries: ReadonlyArray<ChatImportEntry>;
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
