import { describe, expect, it } from "vitest";

import { cursorTranscriptTurns, parseCursorTranscript } from "./CursorTranscriptParser.ts";

describe("parseCursorTranscript", () => {
  it("normalizes wrapped user text, tools, and turn endings", () => {
    const parsed = parseCursorTranscript(
      [
        JSON.stringify({
          role: "user",
          message: {
            content: [
              {
                type: "text",
                text: "<timestamp>today</timestamp><user_query>Fix the import flow please</user_query>",
              },
            ],
          },
        }),
        JSON.stringify({
          role: "assistant",
          message: {
            content: [
              { type: "text", text: "I will inspect it." },
              { type: "tool_use", name: "ReadFile", input: { path: "src/import.ts" } },
            ],
          },
        }),
        JSON.stringify({ type: "turn_ended", status: "success" }),
      ].join("\n"),
      "fallback",
    );

    expect(parsed.title).toBe("Fix the import flow please");
    expect(parsed.entries).toEqual([
      {
        kind: "message",
        ordinal: 0,
        role: "user",
        blocks: [{ type: "text", text: "Fix the import flow please" }],
      },
      {
        kind: "message",
        ordinal: 1,
        role: "assistant",
        blocks: [
          { type: "text", text: "I will inspect it." },
          { type: "tool-call", name: "ReadFile", input: { path: "src/import.ts" } },
        ],
      },
      { kind: "turn-ended", ordinal: 2, status: "success", error: null },
    ]);
    expect(cursorTranscriptTurns(parsed.entries).completed[0]?.activities).toEqual([
      {
        kind: "cursor.imported.tool-call",
        summary: "Used ReadFile",
        payload: {
          role: "assistant",
          name: "ReadFile",
          input: { path: "src/import.ts" },
        },
      },
    ]);
  });

  it("ignores reminder-only user records and unknown control records", () => {
    const parsed = parseCursorTranscript(
      [
        JSON.stringify({
          role: "user",
          message: {
            content: [{ type: "text", text: "<system_reminder>internal</system_reminder>" }],
          },
        }),
        JSON.stringify({ type: "other_control", value: true }),
      ].join("\n"),
      "fallback",
    );

    expect(parsed.title).toBe("fallback");
    expect(parsed.entries).toEqual([]);
  });

  it("rejects a partial final record so the last good mirror is retained", () => {
    expect(() => parseCursorTranscript('{"role":"user"', "fallback")).toThrow(
      "Invalid Cursor transcript JSON on line 1",
    );
  });

  it("fingerprints only completed turns and reports an incomplete tail", () => {
    const first = parseCursorTranscript(
      [
        JSON.stringify({ role: "user", message: { content: "first" } }),
        JSON.stringify({ role: "assistant", message: { content: "answer" } }),
        JSON.stringify({ type: "turn_ended", status: "success" }),
        JSON.stringify({ role: "user", message: { content: "still running" } }),
      ].join("\n"),
      "fallback",
    );
    const analyzed = cursorTranscriptTurns(first.entries);

    expect(analyzed.completed).toHaveLength(1);
    expect(analyzed.completed[0]?.messages).toEqual([
      { role: "user", text: "first" },
      { role: "assistant", text: "answer" },
    ]);
    expect(analyzed.completed[0]?.activities).toEqual([]);
    expect(analyzed.completed[0]?.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(analyzed.hasIncompleteTail).toBe(true);

    const repeated = cursorTranscriptTurns(first.entries);
    expect(repeated.completed[0]?.hash).toBe(analyzed.completed[0]?.hash);
  });
});
