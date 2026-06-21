import { describe, expect, it } from "vitest";
import { END } from "../contracts/end.type";
import { SupervisorFailedError } from "../errors";
import { buildScriptedAgent, schema } from "./_test-helpers";
import { supervisor } from "./supervisor";

/**
 * Phase 5 / decisions §34 — `mode: "stream"` + `streamTo`.
 *
 * Verifies stream-mode intents (a) write the assembled prose into
 * `state[streamTo]`, (b) emit raw text deltas through
 * `supervisor.agent.streaming` without a JSON envelope, and (c)
 * trigger the two factory-time validations.
 */
describe("supervisor — intent stream mode", () => {
  it("writes the assembled prose into state[streamTo] and surfaces it on result.data", async () => {
    const replyText = "Hi there — happy to help.";
    const smalltalk = buildScriptedAgent({
      name: "smalltalk",
      description: "chat-style replies",
      responses: [{ content: replyText, finishReason: "stop" }],
    });

    const replyShape = schema<{ reply: string }>(value => {
      if (!value || typeof value !== "object" || typeof (value as { reply?: unknown }).reply !== "string") {
        return { issues: [{ message: "reply must be a string" }] };
      }

      return { value: value as { reply: string } };
    });

    const supervisorInstance = supervisor<{ reply: string }>({
      name: "stream-mode-state",
      intents: {
        smalltalk: {
          agent: smalltalk,
          mode: "stream",
          streamTo: "reply",
        },
      },
      route: ctx => (ctx.iteration === 0 ? "smalltalk" : END),
      output: replyShape,
    });

    const result = await supervisorInstance.execute("hi");

    expect(result.error).toBeUndefined();
    expect((result.data as { reply: string }).reply.trim()).toBe(replyText);
  });

  it("supervisor.agent.streaming deltas are plain prose, never JSON-enveloped", async () => {
    const fragments = ["Hi", " there", "!"];
    const smalltalk = buildScriptedAgent({
      name: "smalltalk",
      description: "chat-style replies",
      responses: [
        {
          content: fragments.join(""),
          finishReason: "stop",
          deltas: fragments,
        },
      ],
    });

    const replyShape = schema<{ reply: string }>(value => ({
      value: value as { reply: string },
    }));

    const supervisorInstance = supervisor<{ reply: string }>({
      name: "stream-mode-deltas",
      intents: {
        smalltalk: {
          agent: smalltalk,
          mode: "stream",
          streamTo: "reply",
        },
      },
      route: ctx => (ctx.iteration === 0 ? "smalltalk" : END),
      output: replyShape,
    });

    const seenDeltas: string[] = [];

    await supervisorInstance.execute("hi", {
      on: {
        "supervisor.agent.streaming": ({ delta }) => {
          seenDeltas.push(delta);
        },
      },
    });

    expect(seenDeltas.length).toBeGreaterThan(0);

    for (const delta of seenDeltas) {
      // Stream-mode chunks must NOT be JSON-shaped — no leading `{`,
      // no `"reply":` envelope. Plain prose only.
      expect(delta.trimStart().startsWith("{")).toBe(false);
      expect(delta).not.toContain('"reply"');
    }
  });

  it("factory throws SUPERVISOR_INTENT_STREAM_AND_OUTPUT when both are set", () => {
    const smalltalk = buildScriptedAgent({
      name: "smalltalk",
      description: "chat",
      responses: [{ content: "hi", finishReason: "stop" }],
    });

    const replyShape = schema<{ reply: string }>(value => ({
      value: value as { reply: string },
    }));

    expect(() =>
      supervisor({
        name: "stream-and-output",
        intents: {
          smalltalk: {
            agent: smalltalk,
            mode: "stream",
            streamTo: "reply",
            output: replyShape,
          },
        },
        route: () => END,
      }),
    ).toThrow(
      expect.objectContaining({
        name: "SupervisorFailedError",
        code: "SUPERVISOR_INTENT_STREAM_AND_OUTPUT",
      }) as unknown as SupervisorFailedError,
    );
  });

  it("factory throws SUPERVISOR_INTENT_STREAM_TO_REQUIRED when streamTo is missing", () => {
    const smalltalk = buildScriptedAgent({
      name: "smalltalk",
      description: "chat",
      responses: [{ content: "hi", finishReason: "stop" }],
    });

    expect(() =>
      supervisor({
        name: "stream-no-to",
        intents: {
          smalltalk: {
            agent: smalltalk,
            mode: "stream",
          },
        },
        route: () => END,
      }),
    ).toThrow(
      expect.objectContaining({
        name: "SupervisorFailedError",
        code: "SUPERVISOR_INTENT_STREAM_TO_REQUIRED",
      }) as unknown as SupervisorFailedError,
    );
  });
});
