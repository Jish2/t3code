import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-09-02T12:00:00.000Z";
const threadId = ThreadId.make("thread-imported");
const turnId = TurnId.make("turn-imported");
const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: "Imported",
      modelSelection: {
        instanceId: ProviderInstanceId.make("cursor"),
        model: "auto",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: NOW,
};

it.layer(NodeServices.layer)("imported history decider", (it) => {
  it.effect("appends canonical messages without requesting a provider turn", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.history.append",
          commandId: CommandId.make("cursor-import:history"),
          threadId,
          turnId,
          messages: [
            {
              messageId: MessageId.make("imported-user"),
              role: "user",
              text: "Earlier question",
              createdAt: NOW,
            },
            {
              messageId: MessageId.make("imported-assistant"),
              role: "assistant",
              text: "Earlier answer",
              createdAt: NOW,
            },
          ],
          activities: [
            {
              id: EventId.make("cursor-import:turn-completed"),
              tone: "info",
              kind: "cursor.external-turn.completed",
              summary: "Imported Cursor turn completed",
              payload: {
                status: "success",
                historicalDiff: "unavailable",
              },
              turnId,
              createdAt: NOW,
            },
          ],
          createdAt: NOW,
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.message-sent",
        "thread.activity-appended",
      ]);
      expect(events.some((event) => event.type === "thread.turn-start-requested")).toBe(false);
      expect(events.map((event) => event.payload)).toMatchObject([
        { turnId, streaming: false },
        { turnId, streaming: false },
        { activity: { turnId, kind: "cursor.external-turn.completed" } },
      ]);
      let projected = readModel;
      for (const [index, event] of events.entries()) {
        projected = yield* projectEvent(projected, { ...event, sequence: index + 1 });
      }
      expect(projected.threads[0]?.latestTurn).toMatchObject({
        turnId,
        state: "completed",
        assistantMessageId: "imported-assistant",
      });
      expect(projected.threads[0]?.activities).toMatchObject([
        { kind: "cursor.external-turn.completed", turnId },
      ]);
    }),
  );

  it.effect("unsettles a settled thread when imported user activity arrives", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.history.append",
          commandId: CommandId.make("cursor-import:settled-history"),
          threadId,
          turnId,
          messages: [
            {
              messageId: MessageId.make("imported-user-settled"),
              role: "user",
              text: "New Cursor activity",
              createdAt: NOW,
            },
          ],
          activities: [],
          createdAt: NOW,
        },
        readModel: {
          ...readModel,
          threads: [{ ...readModel.threads[0]!, settledOverride: "settled", settledAt: NOW }],
        },
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.message-sent",
      ]);
    }),
  );
});
