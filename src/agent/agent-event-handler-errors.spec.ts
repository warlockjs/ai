import { log } from "@warlock.js/logger";
import { describe, expect, it, vi } from "vitest";
import { MockSDK } from "../mock/mock-sdk";
import { agent } from "./agent";

describe("agent — event handler error surfacing (C5)", () => {
  it("isolates a throwing event handler but surfaces it via the logger", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    const sdk = MockSDK({ responses: [{ content: "hi", finishReason: "stop" }] });
    const ai = agent({
      model: sdk.model({ name: "m" }),
      on: {
        "agent.starting": () => {
          throw new Error("handler boom");
        },
      },
    });

    const result = await ai.execute("go");

    // Isolation preserved — the broken handler did NOT crash the run.
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("hi");

    // Surfaced — no longer a silent swallow. The failure was logged
    // under the dedicated `event.handler.error` code.
    const handlerWarn = warn.mock.calls.find(
      call => call[1] === "event.handler.error",
    );
    expect(handlerWarn).toBeDefined();
    expect(String(handlerWarn?.[3] && (handlerWarn[3] as { error?: unknown }).error)).toContain(
      "handler boom",
    );

    warn.mockRestore();
  });
});
