import { describe, expect, it, vi } from "vitest";
import type { Message } from "../contracts/conversation-message.type";
import { SupervisorFailedError } from "../errors";
import { createCommandDispatcher } from "./commands";

const summaryMessage: Message = { role: "assistant", content: "summary" };

describe("createCommandDispatcher", () => {
  it("routes a compact command to its registered handler with typed args", async () => {
    const compact = vi.fn(async () => ({
      summary: summaryMessage,
      replacesFromIndex: 0,
      replacesToIndex: 9,
    }));

    const command = createCommandDispatcher({ compact });

    const result = await command("compact", {
      sessionId: "s1",
      history: [{ role: "user", content: "hi" }],
    });

    expect(compact).toHaveBeenCalledWith({
      sessionId: "s1",
      history: [{ role: "user", content: "hi" }],
    });
    expect(result).toEqual({
      summary: summaryMessage,
      replacesFromIndex: 0,
      replacesToIndex: 9,
    });
  });

  it("throws SupervisorFailedError for an unregistered command", () => {
    const command = createCommandDispatcher(
      {} as unknown as Parameters<typeof createCommandDispatcher>[0],
    );

    expect(() =>
      command("compact", { sessionId: "s1", history: [] }),
    ).toThrow(SupervisorFailedError);
  });

  it("propagates the handler's rejection unchanged", async () => {
    const boom = new Error("summarizer down");
    const command = createCommandDispatcher({
      compact: async () => {
        throw boom;
      },
    });

    await expect(
      command("compact", { sessionId: "s1", history: [] }),
    ).rejects.toBe(boom);
  });
});
