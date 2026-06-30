import { describe, expect, it } from "vitest";
import type { Message } from "../contracts/conversation-message.type";
import type { ToolConfig } from "../contracts/tool.contract";
import { DEFAULT_HASH_OPTIONS, hashRequest } from "./hash-request";

const messages: Message[] = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "Where is my order?" },
];

describe("hashRequest", () => {
  it("is stable for identical inputs", () => {
    expect(hashRequest(messages, { temperature: 0.2 })).toBe(
      hashRequest(messages, { temperature: 0.2 }),
    );
  });

  it("differs when messages differ", () => {
    const other: Message[] = [{ role: "user", content: "different" }];

    expect(hashRequest(messages)).not.toBe(hashRequest(other));
  });

  it("differs when a hashed option differs", () => {
    expect(hashRequest(messages, { temperature: 0.2 })).not.toBe(
      hashRequest(messages, { temperature: 0.9 }),
    );
  });

  it("excludes signal from the hash", () => {
    const controller = new AbortController();

    expect(hashRequest(messages, { temperature: 0.2 })).toBe(
      hashRequest(messages, { temperature: 0.2, signal: controller.signal }),
    );
  });

  it("excludes unknown provider keys from the hash", () => {
    expect(hashRequest(messages, { temperature: 0.2 })).toBe(
      hashRequest(messages, { temperature: 0.2, customProviderFlag: true }),
    );
  });

  it("includes temperature by default", () => {
    expect(DEFAULT_HASH_OPTIONS).toContain("temperature");
  });

  it("is insensitive to option key insertion order", () => {
    expect(hashRequest(messages, { temperature: 0.2, maxTokens: 100 })).toBe(
      hashRequest(messages, { maxTokens: 100, temperature: 0.2 }),
    );
  });

  it("hashes tools by name + description + schema shape, not identity", () => {
    const toolA: ToolConfig<unknown, unknown> = {
      name: "search",
      description: "Search the web",
      input: { keyA: "string", keyB: "number" } as never,
      execute: async () => ({}),
    };
    const toolB: ToolConfig<unknown, unknown> = {
      name: "search",
      description: "Search the web",
      input: { keyA: "string", keyB: "number" } as never,
      execute: async () => ({}),
    };

    expect(hashRequest(messages, { tools: [toolA] })).toBe(
      hashRequest(messages, { tools: [toolB] }),
    );
  });

  it("changes when a tool's description changes", () => {
    const toolA: ToolConfig<unknown, unknown> = {
      name: "search",
      description: "Search the web",
      execute: async () => ({}),
    };
    const toolB: ToolConfig<unknown, unknown> = {
      name: "search",
      description: "Search the catalog",
      execute: async () => ({}),
    };

    expect(hashRequest(messages, { tools: [toolA] })).not.toBe(
      hashRequest(messages, { tools: [toolB] }),
    );
  });

  it("honors a custom hashOptions list", () => {
    // maxTokens excluded → the two calls collide.
    expect(hashRequest(messages, { maxTokens: 100 }, ["temperature"])).toBe(
      hashRequest(messages, { maxTokens: 500 }, ["temperature"]),
    );
  });
});
