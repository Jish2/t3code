import { describe, expect, it } from "vitest";

import { parseCursorTranscript } from "./CursorTranscriptParser.ts";

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
});
