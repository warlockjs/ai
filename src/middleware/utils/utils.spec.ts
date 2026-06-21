import { describe, expect, it } from "vitest";
import type { Message } from "../../contracts/conversation-message.type";
import type { MiddlewareState } from "../../contracts/middleware";
import { extractUserText } from "./extract-user-text";
import { namespacedState } from "./namespaced-state";

describe("namespacedState", () => {
  function makeCtx(): { readonly state: MiddlewareState } {
    return { state: new Map<string, unknown>() };
  }

  it("reads undefined for an unset namespace", () => {
    const accessor = namespacedState<number>(makeCtx(), "budget");

    expect(accessor.get()).toBeUndefined();
    expect(accessor.has()).toBe(false);
  });

  it("writes and reads back a typed value", () => {
    const counters = namespacedState<{ tokens: number }>(makeCtx(), "budget");

    counters.set({ tokens: 5 });

    expect(counters.get()).toEqual({ tokens: 5 });
    expect(counters.has()).toBe(true);
  });

  it("set overwrites a previous value under the same namespace", () => {
    const accessor = namespacedState<number>(makeCtx(), "n");

    accessor.set(1);
    accessor.set(2);

    expect(accessor.get()).toBe(2);
  });

  it("delete removes the entry — has() flips back to false", () => {
    const accessor = namespacedState<number>(makeCtx(), "n");

    accessor.set(42);
    expect(accessor.has()).toBe(true);

    accessor.delete();

    expect(accessor.has()).toBe(false);
    expect(accessor.get()).toBeUndefined();
  });

  it("is a live view — two accessors on the same namespace see each other's writes", () => {
    const ctx = makeCtx();
    const a = namespacedState<number>(ctx, "shared");
    const b = namespacedState<number>(ctx, "shared");

    a.set(7);

    expect(b.get()).toBe(7);
  });

  it("isolates distinct namespaces in the same state bag", () => {
    const ctx = makeCtx();
    const budget = namespacedState<number>(ctx, "budget");
    const guardrail = namespacedState<number>(ctx, "guardrail");

    budget.set(1);
    guardrail.set(2);

    expect(budget.get()).toBe(1);
    expect(guardrail.get()).toBe(2);
  });

  it("writes are visible on the underlying Map directly", () => {
    const ctx = makeCtx();
    const accessor = namespacedState<string>(ctx, "key");

    accessor.set("value");

    expect(ctx.state.get("key")).toBe("value");
  });

  it("stores falsy values without conflating them with 'unset'", () => {
    const accessor = namespacedState<number>(makeCtx(), "n");

    accessor.set(0);

    expect(accessor.has()).toBe(true);
    expect(accessor.get()).toBe(0);
  });
});

describe("extractUserText", () => {
  it("returns the string content of the only user message", () => {
    const messages: Message[] = [{ role: "user", content: "hello" }];

    expect(extractUserText(messages)).toBe("hello");
  });

  it("returns the LAST user message when several are present", () => {
    const messages: Message[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];

    expect(extractUserText(messages)).toBe("second");
  });

  it("skips trailing non-user messages to find the last user turn", () => {
    const messages: Message[] = [
      { role: "user", content: "the question" },
      { role: "assistant", content: "the answer" },
      { role: "tool", toolCallId: "c1", content: "{}" },
    ];

    expect(extractUserText(messages)).toBe("the question");
  });

  it("joins text parts of a multipart user message with newlines", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      },
    ];

    expect(extractUserText(messages)).toBe("line one\nline two");
  });

  it("skips non-text parts (images) when joining multipart content", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image", source: { url: "https://example.com/cat.jpg" } },
        ],
      },
    ];

    expect(extractUserText(messages)).toBe("describe this");
  });

  it("returns an empty string for a multipart message with no text parts", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { url: "https://example.com/a.png" } },
        ],
      },
    ];

    expect(extractUserText(messages)).toBe("");
  });

  it("returns an empty string when there is no user message at all", () => {
    const messages: Message[] = [
      { role: "system", content: "you are a bot" },
      { role: "assistant", content: "hi" },
      { role: "tool", toolCallId: "c1", content: "{}" },
    ];

    expect(extractUserText(messages)).toBe("");
  });

  it("returns an empty string for an empty message list", () => {
    expect(extractUserText([])).toBe("");
  });

  it("treats an empty multipart user message as the matched turn (no further search)", () => {
    // The backward walk stops at the first user message it finds, even
    // when that message yields an empty string. An earlier user turn is
    // NOT consulted.
    const messages: Message[] = [
      { role: "user", content: "earlier" },
      { role: "user", content: [] },
    ];

    expect(extractUserText(messages)).toBe("");
  });
});
