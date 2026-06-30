import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { MockSDK } from "../mock/mock-sdk";
import type { MockModel } from "../mock/mock-model";
import { agent } from "./agent";

// ---------------------------------------------------------------------------
// Hand-rolled Standard Schema helpers (mirrors agent.spec.ts approach)
// ---------------------------------------------------------------------------

function makeSchema<T>(
  validate: (value: unknown) => StandardSchemaV1.Result<T>,
): StandardSchemaV1<T> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

/** A judge verdict schema: { score: number; passed: boolean }. */
type Verdict = { score: number; passed: boolean };

const verdictSchema = makeSchema<Verdict>((v) => {
  if (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>)["score"] === "number" &&
    typeof (v as Record<string, unknown>)["passed"] === "boolean"
  ) {
    const record = v as Record<string, unknown>;
    return { value: { score: record["score"] as number, passed: record["passed"] as boolean } };
  }
  return { issues: [{ message: "expected { score: number, passed: boolean }" }] };
});

describe("agent judge-safe preset", () => {
  // 1. Lenient parse: recovers a verdict wrapped in a ```json fence.
  it("parses a fenced ```json verdict on the first trip (no repair needed)", async () => {
    const mock = MockSDK({
      responses: [
        { content: '```json\n{"score":0.9,"passed":true}\n```', finishReason: "stop" },
      ],
    });
    const model: MockModel = mock.model({ name: "nova" }) as MockModel;

    const result = await agent({ model, judge: true, output: verdictSchema }).execute("grade it");

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ score: 0.9, passed: true });
    expect(result.report.trips).toHaveLength(1);
    expect(model.callCount).toBe(1);
  });

  // 2. Lenient parse: recovers a verdict surrounded by leading + trailing prose.
  it("parses a verdict buried in prose without a repair trip", async () => {
    const mock = MockSDK({
      responses: [
        {
          content: 'Sure! Here is my grade: {"score":0.4,"passed":false} — let me know.',
          finishReason: "stop",
        },
      ],
    });
    const model: MockModel = mock.model({ name: "nova" }) as MockModel;

    const result = await agent({ model, judge: true, output: verdictSchema }).execute("grade it");

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ score: 0.4, passed: false });
    expect(result.report.trips).toHaveLength(1);
  });

  // 3. A non-judge agent does NOT lenient-parse prose-wrapped JSON (strictness preserved).
  it("a strict (non-judge) agent fails on prose-wrapped JSON instead of recovering it", async () => {
    const mock = MockSDK({
      responses: [
        {
          content: 'My grade: {"score":0.4,"passed":false} done.',
          finishReason: "stop",
        },
      ],
    });
    const model: MockModel = mock.model({ name: "gpt" }) as MockModel;

    // No judge flag, no repair → strict extractJsonPayload cannot slice
    // prose-embedded JSON, so the parse fails and surfaces on result.error.
    const result = await agent({ model, output: verdictSchema }).execute("grade it");

    expect(result.data).toBeUndefined();
    expect(result.error?.message).toContain("Failed to parse model output as JSON");
    expect(result.report.trips).toHaveLength(1);
  });

  // 4. Repair auto-enabled: garbage on trip 1, clean fenced verdict on the re-ask.
  it("auto-repairs a garbage first verdict and recovers on the re-ask", async () => {
    const mock = MockSDK({
      responses: [
        { content: "I cannot comply, sorry.", finishReason: "stop" },
        { content: '```json\n{"score":1,"passed":true}\n```', finishReason: "stop" },
      ],
    });
    const model: MockModel = mock.model({ name: "nova" }) as MockModel;

    // No explicit `repair` option — the judge preset supplies it.
    const result = await agent({ model, judge: true, output: verdictSchema }).execute("grade it");

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ score: 1, passed: true });
    expect(result.report.trips).toHaveLength(2);
    expect(model.callCount).toBe(2);
  });

  // 5. Default repair attempts: two re-asks by default before giving up.
  it("defaults to two repair attempts (three model calls total) before degrading", async () => {
    const mock = MockSDK({
      responses: [
        { content: "nope", finishReason: "stop" },
        { content: "still nope", finishReason: "stop" },
        { content: "really nope", finishReason: "stop" },
        // A fourth clean response that must NOT be reached (only 2 repairs).
        { content: '{"score":1,"passed":true}', finishReason: "stop" },
      ],
    });
    const model: MockModel = mock.model({ name: "nova" }) as MockModel;

    const result = await agent({ model, judge: true, output: verdictSchema }).execute("grade it");

    // 1 initial + 2 repair attempts = 3 calls; the clean 4th is never used.
    expect(model.callCount).toBe(3);
    expect(result.report.trips).toHaveLength(3);
    expect(result.data).toBeUndefined();
    expect(result.error).toBeDefined();
  });

  // 6. Graceful degrade: never throws on a parse miss — result.error + no data.
  it("never throws on a total parse miss — degrades to result.error with undefined data", async () => {
    const mock = MockSDK({
      responses: [
        { content: "absolutely not json", finishReason: "stop" },
        { content: "still not json", finishReason: "stop" },
        { content: "nope nope nope", finishReason: "stop" },
      ],
    });
    const model: MockModel = mock.model({ name: "nova" }) as MockModel;

    // Must resolve (not reject) even though every verdict is garbage.
    const result = await agent({ model, judge: true, output: verdictSchema }).execute("grade it");

    expect(result.type).toBe("agent");
    expect(result.data).toBeUndefined();
    expect(result.error).toBeDefined();
    expect(result.report.status).toBe("failed");
  });

  // 7. judge config object: repairAttempts: 0 keeps lenient parse but no repair.
  it("honors { repairAttempts: 0 } — lenient parse, but no repair trip", async () => {
    const mock = MockSDK({
      responses: [
        { content: "garbage", finishReason: "stop" },
        { content: '{"score":1,"passed":true}', finishReason: "stop" },
      ],
    });
    const model: MockModel = mock.model({ name: "nova" }) as MockModel;

    const result = await agent({
      model,
      judge: { repairAttempts: 0 },
      output: verdictSchema,
    }).execute("grade it");

    // No repair → only the first (garbage) call happened.
    expect(model.callCount).toBe(1);
    expect(result.data).toBeUndefined();
    expect(result.error).toBeDefined();
  });

  // 8. Per-call repair option still wins over the judge default.
  it("lets a per-call repair option override the judge default attempt count", async () => {
    const mock = MockSDK({
      responses: [
        { content: "garbage", finishReason: "stop" },
        { content: "still garbage", finishReason: "stop" },
        { content: '{"score":1,"passed":true}', finishReason: "stop" },
      ],
    });
    const model: MockModel = mock.model({ name: "nova" }) as MockModel;

    // Force exactly 1 repair attempt despite the judge default of 2.
    const result = await agent({ model, judge: true, output: verdictSchema }).execute("grade it", {
      repair: { maxAttempts: 1 },
    });

    // 1 initial + 1 repair = 2 calls (the clean 3rd response is never reached).
    expect(model.callCount).toBe(2);
    expect(result.data).toBeUndefined();
    expect(result.error).toBeDefined();
  });

  // 9. ai.agent.judge(...) helper builds the same preset.
  it("the agent.judge(...) helper enables the judge preset", async () => {
    const mock = MockSDK({
      responses: [
        { content: 'Verdict:\n```json\n{"score":0.8,"passed":true}\n```', finishReason: "stop" },
      ],
    });
    const model: MockModel = mock.model({ name: "nova" }) as MockModel;

    const result = await agent
      .judge({ model, output: verdictSchema })
      .execute("grade it");

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ score: 0.8, passed: true });
  });

  // 10. agent.judge(config, { repairAttempts }) forwards the fine-tuning config.
  it("agent.judge(config, { repairAttempts: 0 }) disables repair", async () => {
    const mock = MockSDK({
      responses: [
        { content: "garbage", finishReason: "stop" },
        { content: '{"score":1,"passed":true}', finishReason: "stop" },
      ],
    });
    const model: MockModel = mock.model({ name: "nova" }) as MockModel;

    const result = await agent
      .judge({ model, output: verdictSchema }, { repairAttempts: 0 })
      .execute("grade it");

    expect(model.callCount).toBe(1);
    expect(result.error).toBeDefined();
  });

  // 11. Judge mode is a no-op when there is no output schema.
  it("is inert (no parse, no repair) when no output schema is configured", async () => {
    const mock = MockSDK({
      responses: [{ content: "just some prose", finishReason: "stop" }],
    });
    const model: MockModel = mock.model({ name: "nova" }) as MockModel;

    const result = await agent({ model, judge: true }).execute("hi");

    expect(result.error).toBeUndefined();
    expect(result.text).toBe("just some prose");
    expect(result.report.trips).toHaveLength(1);
  });
});
