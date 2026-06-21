import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import type { ModelToolCallRequest } from "../contracts/model-tool-call-request.type";
import { tool } from "../tool/tool";
import { JsonStreamGuard } from "./json-stream-guard";

function makeSchema<T>(
  validate: (value: unknown) => StandardSchemaV1.Result<T>,
): StandardSchemaV1<T> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

const suggestFollowupsSchema = makeSchema<{
  suggestions: Array<{ label: string; value: string }>;
}>((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { issues: [{ message: "expected object" }] };
  }

  const v = value as { suggestions?: unknown };

  if (!Array.isArray(v.suggestions)) {
    return { issues: [{ message: "expected suggestions array" }] };
  }

  for (const entry of v.suggestions) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { label?: unknown }).label !== "string" ||
      typeof (entry as { value?: unknown }).value !== "string"
    ) {
      return { issues: [{ message: "invalid suggestion entry" }] };
    }
  }

  return { value: v as { suggestions: Array<{ label: string; value: string }> } };
});

const searchCatalogSchema = makeSchema<{ query: string }>((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { issues: [{ message: "expected object" }] };
  }

  const v = value as { query?: unknown };

  if (typeof v.query !== "string") {
    return { issues: [{ message: "expected query string" }] };
  }

  return { value: { query: v.query } };
});

const suggestFollowupsTool = tool({
  name: "suggest_followups",
  description: "Attach chips.",
  input: suggestFollowupsSchema,
  execute: async () => ({ presented: 0 }),
});

const searchCatalogTool = tool({
  name: "search_catalog",
  description: "Search.",
  input: searchCatalogSchema,
  execute: async () => ({ results: [] }),
});

type Capture = {
  emitted: string[];
  recovered: ModelToolCallRequest[];
};

function makeCapture(): Capture & {
  guard: JsonStreamGuard;
} {
  const emitted: string[] = [];
  const recovered: ModelToolCallRequest[] = [];

  const guard = new JsonStreamGuard({
    tools: [suggestFollowupsTool, searchCatalogTool],
    onSafeDelta: (delta) => emitted.push(delta),
    onRecoveredCall: (request) => recovered.push(request),
  });

  return { emitted, recovered, guard };
}

function emittedText(capture: { emitted: string[] }): string {
  return capture.emitted.join("");
}

describe("JsonStreamGuard", () => {
  describe("pass-through", () => {
    it("emits plain prose verbatim with no recovery", async () => {
      const cap = makeCapture();

      await cap.guard.feed("Hello there, ");
      await cap.guard.feed("how can I help you today?");
      await cap.guard.finalize();

      expect(emittedText(cap)).toBe("Hello there, how can I help you today?");
      expect(cap.recovered).toHaveLength(0);
    });

    it("does not engage when there is no { or backtick anywhere", async () => {
      const cap = makeCapture();

      await cap.guard.feed("The quick brown fox jumps over the lazy dog.");
      await cap.guard.finalize();

      expect(emittedText(cap)).toBe("The quick brown fox jumps over the lazy dog.");
    });
  });

  describe("named-envelope recovery — brace mode", () => {
    it("recovers a JSON envelope appearing at the start of the stream", async () => {
      const cap = makeCapture();

      const envelope = `{"name":"suggest_followups","arguments":{"suggestions":[{"label":"L","value":"V"}]}}`;

      await cap.guard.feed(envelope);
      await cap.guard.finalize();

      expect(emittedText(cap)).toBe("");
      expect(cap.recovered).toHaveLength(1);
      expect(cap.recovered[0].name).toBe("suggest_followups");
      expect(cap.recovered[0].recoveredFrom).toBe("stream-text");
      expect(cap.recovered[0].input).toEqual({
        suggestions: [{ label: "L", value: "V" }],
      });
    });

    it("recovers when JSON appears at the tail after legitimate prose", async () => {
      const cap = makeCapture();

      const prose = "Here are some good options: ";
      const envelope = `{"name":"suggest_followups","arguments":{"suggestions":[{"label":"A","value":"B"}]}}`;

      await cap.guard.feed(prose + envelope);
      await cap.guard.finalize();

      expect(emittedText(cap)).toBe(prose);
      expect(cap.recovered).toHaveLength(1);
    });

    it("recovers when JSON appears in the middle with trailing prose", async () => {
      const cap = makeCapture();

      const before = "Looking at this, ";
      const envelope = `{"name":"search_catalog","arguments":{"query":"shoes"}}`;
      const after = " and that should help.";

      await cap.guard.feed(before + envelope + after);
      await cap.guard.finalize();

      expect(emittedText(cap)).toBe(before + after);
      expect(cap.recovered).toHaveLength(1);
      expect(cap.recovered[0].name).toBe("search_catalog");
    });

    it("recovers multiple envelopes in one stream", async () => {
      const cap = makeCapture();

      const first = `{"name":"search_catalog","arguments":{"query":"a"}}`;
      const second = `{"name":"search_catalog","arguments":{"query":"b"}}`;

      await cap.guard.feed(`Sure: ${first} and also: ${second}.`);
      await cap.guard.finalize();

      expect(emittedText(cap)).toBe("Sure:  and also: .");
      expect(cap.recovered).toHaveLength(2);
      expect((cap.recovered[0].input as { query: string }).query).toBe("a");
      expect((cap.recovered[1].input as { query: string }).query).toBe("b");
    });

    it("handles a JSON envelope split across many delta chunks", async () => {
      const cap = makeCapture();

      const envelope = `{"name":"search_catalog","arguments":{"query":"split"}}`;

      for (let i = 0; i < envelope.length; i++) {
        await cap.guard.feed(envelope[i]);
      }

      await cap.guard.finalize();

      expect(emittedText(cap)).toBe("");
      expect(cap.recovered).toHaveLength(1);
    });

    it("tracks string literals so braces inside strings do not skew depth", async () => {
      const cap = makeCapture();

      const envelope = `{"name":"search_catalog","arguments":{"query":"a { weird } query"}}`;

      await cap.guard.feed(envelope);
      await cap.guard.finalize();

      expect(emittedText(cap)).toBe("");
      expect(cap.recovered).toHaveLength(1);
      expect((cap.recovered[0].input as { query: string }).query).toBe("a { weird } query");
    });

    it("respects escaped quotes inside JSON string literals", async () => {
      const cap = makeCapture();

      const envelope = `{"name":"search_catalog","arguments":{"query":"he said \\"hi\\" then left"}}`;

      await cap.guard.feed(envelope);
      await cap.guard.finalize();

      expect(emittedText(cap)).toBe("");
      expect(cap.recovered).toHaveLength(1);
      expect((cap.recovered[0].input as { query: string }).query).toBe(
        'he said "hi" then left',
      );
    });
  });

  describe("envelope-key aliases", () => {
    it('accepts "tool" + "input" as aliases for "name" + "arguments"', async () => {
      const cap = makeCapture();

      const envelope = `{"tool":"search_catalog","input":{"query":"alias"}}`;

      await cap.guard.feed(envelope);
      await cap.guard.finalize();

      expect(cap.recovered).toHaveLength(1);
      expect(cap.recovered[0].name).toBe("search_catalog");
      expect((cap.recovered[0].input as { query: string }).query).toBe("alias");
    });
  });

  describe("non-matching JSON falls through as text", () => {
    it("flushes a JSON object whose tool name is not registered", async () => {
      const cap = makeCapture();

      const envelope = `{"name":"unknown_tool","arguments":{"x":1}}`;

      await cap.guard.feed(envelope);
      await cap.guard.finalize();

      expect(emittedText(cap)).toBe(envelope);
      expect(cap.recovered).toHaveLength(0);
    });

    it("flushes when args fail the registered tool's schema", async () => {
      const cap = makeCapture();

      // `search_catalog` requires `query: string`; we pass `query: 123`.
      const envelope = `{"name":"search_catalog","arguments":{"query":123}}`;

      await cap.guard.feed(envelope);
      await cap.guard.finalize();

      expect(emittedText(cap)).toBe(envelope);
      expect(cap.recovered).toHaveLength(0);
    });

    it("flushes when the JSON is not envelope-shaped (no name+args keys)", async () => {
      const cap = makeCapture();

      const json = `{"items":[1,2,3]}`;

      await cap.guard.feed(`Some data: ${json}.`);
      await cap.guard.finalize();

      expect(emittedText(cap)).toBe(`Some data: ${json}.`);
      expect(cap.recovered).toHaveLength(0);
    });
  });

  describe("fence-mode recovery", () => {
    it("recovers an envelope wrapped in a ```json fence", async () => {
      const cap = makeCapture();

      const envelope = `{"name":"search_catalog","arguments":{"query":"fenced"}}`;
      const fenced = "```json\n" + envelope + "\n```";

      await cap.guard.feed(`Here you go: ${fenced}`);
      await cap.guard.finalize();

      expect(emittedText(cap)).toBe("Here you go: ");
      expect(cap.recovered).toHaveLength(1);
      expect((cap.recovered[0].input as { query: string }).query).toBe("fenced");
    });

    it("flushes a fenced block as text when the JSON doesn't match any tool", async () => {
      const cap = makeCapture();

      const fenced = "```json\n{\"foo\":\"bar\"}\n```";

      await cap.guard.feed(fenced);
      await cap.guard.finalize();

      expect(emittedText(cap)).toBe(fenced);
      expect(cap.recovered).toHaveLength(0);
    });

    it("flushes a broken fence (no closing) as text on finalize", async () => {
      const cap = makeCapture();

      await cap.guard.feed("```json\n{\"name\":\"search_catalog\"");
      await cap.guard.finalize();

      expect(emittedText(cap)).toBe("```json\n{\"name\":\"search_catalog\"");
      expect(cap.recovered).toHaveLength(0);
    });
  });

  describe("partial-opener handling", () => {
    it("flushes a partial backtick prefix that does not complete a fence", async () => {
      const cap = makeCapture();

      await cap.guard.feed("``not a fence``");
      await cap.guard.finalize();

      expect(emittedText(cap)).toBe("``not a fence``");
      expect(cap.recovered).toHaveLength(0);
    });

    it("flushes a single trailing backtick on finalize", async () => {
      const cap = makeCapture();

      await cap.guard.feed("text ");
      await cap.guard.feed("`");
      await cap.guard.finalize();

      expect(emittedText(cap)).toBe("text `");
    });

    it("handles a `{` that immediately follows a partial fence break", async () => {
      const cap = makeCapture();

      const envelope = `{"name":"search_catalog","arguments":{"query":"x"}}`;

      // "``" is not a fence opener — flush, then the next `{` opens a buffer.
      await cap.guard.feed("``" + envelope);
      await cap.guard.finalize();

      expect(emittedText(cap)).toBe("``");
      expect(cap.recovered).toHaveLength(1);
    });
  });

  describe("buffer cap enforcement", () => {
    it("flushes a runaway brace buffer as text once the cap is exceeded", async () => {
      const emitted: string[] = [];
      const recovered: ModelToolCallRequest[] = [];

      const guard = new JsonStreamGuard({
        tools: [searchCatalogTool],
        maxBufferBytes: 32,
        onSafeDelta: (delta) => emitted.push(delta),
        onRecoveredCall: (request) => recovered.push(request),
      });

      const oversize = `{"name":"search_catalog","arguments":{"query":"${"x".repeat(100)}"}}`;

      await guard.feed(oversize);
      await guard.finalize();

      expect(recovered).toHaveLength(0);
      expect(emitted.join("")).toBe(oversize);
    });

    it("returns to pass-through after a cap-overflow flush", async () => {
      const emitted: string[] = [];
      const recovered: ModelToolCallRequest[] = [];

      const guard = new JsonStreamGuard({
        tools: [searchCatalogTool],
        maxBufferBytes: 16,
        onSafeDelta: (delta) => emitted.push(delta),
        onRecoveredCall: (request) => recovered.push(request),
      });

      // First buffer overflows; subsequent prose streams clean.
      await guard.feed(`{"a":"${"x".repeat(40)}"}`);
      await guard.feed(" then later text");
      await guard.finalize();

      expect(recovered).toHaveLength(0);
      expect(emitted.join("")).toContain("then later text");
    });
  });

  describe("finalize", () => {
    it("flushes an unclosed brace buffer as text when the stream ends", async () => {
      const cap = makeCapture();

      await cap.guard.feed(`prefix {"name":"search_catalog","arguments":{"query":"unclosed"`);
      await cap.guard.finalize();

      expect(emittedText(cap)).toBe(
        `prefix {"name":"search_catalog","arguments":{"query":"unclosed"`,
      );
      expect(cap.recovered).toHaveLength(0);
    });

    it("reports hasRecoveredCalls() correctly after recovery", async () => {
      const cap = makeCapture();

      expect(cap.guard.hasRecoveredCalls()).toBe(false);

      await cap.guard.feed(
        `{"name":"search_catalog","arguments":{"query":"x"}}`,
      );
      await cap.guard.finalize();

      expect(cap.guard.hasRecoveredCalls()).toBe(true);
    });

    it("reports hasRecoveredCalls() false when no envelope matched", async () => {
      const cap = makeCapture();

      await cap.guard.feed("plain text only");
      await cap.guard.finalize();

      expect(cap.guard.hasRecoveredCalls()).toBe(false);
    });
  });

  describe("synthesized id", () => {
    it("generates stable, collision-free ids across multiple recoveries", async () => {
      const cap = makeCapture();

      const first = `{"name":"search_catalog","arguments":{"query":"a"}}`;
      const second = `{"name":"search_catalog","arguments":{"query":"b"}}`;

      await cap.guard.feed(first + second);
      await cap.guard.finalize();

      expect(cap.recovered).toHaveLength(2);
      expect(cap.recovered[0].id).not.toBe(cap.recovered[1].id);
      expect(cap.recovered[0].id).toMatch(/^synth_search_catalog_\d+$/);
      expect(cap.recovered[1].id).toMatch(/^synth_search_catalog_\d+$/);
    });
  });
});
