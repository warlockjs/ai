import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import type { WorkflowSnapshot } from "../contracts/workflow/workflow-snapshot.type";
import { mockAgent } from "../mock/mock-agent";
import { memory as snapshotMemory } from "../snapshot/memory";
import { step } from "./step";
import { workflow } from "./workflow";

function schema<T>(
  validate: (value: unknown) => StandardSchemaV1.Result<T>,
): StandardSchemaV1<T> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

const passthrough = schema<any>(v => ({ value: v }));

// End-to-end scenario mirroring PoC Example 2 from the workflow design:
// classify → (conditional enrich) → parallel(draft, kb-articles) → qa
// with a step-level loop-back to "draft" on rejection.
describe("workflow integration — support ticket triage", () => {
  it("runs classify → enrich → parallel draft/kb → qa with loop-back", async () => {
    const classifierAgent = mockAgent({
      name: "classifier",
      responses: [
        {
          content: JSON.stringify({ category: "billing", priority: "high" }),
          finishReason: "stop",
        },
      ],
    });
    const historyAgent = mockAgent({
      name: "history",
      responses: [
        {
          content: JSON.stringify({ tier: "gold", ltv: 500 }),
          finishReason: "stop",
        },
      ],
    });
    const writerAgent = mockAgent({
      name: "writer",
      responses: [
        {
          content: JSON.stringify({ response: "first draft" }),
          finishReason: "stop",
        },
        {
          content: JSON.stringify({ response: "revised draft" }),
          finishReason: "stop",
        },
      ],
    });
    const kbAgent = mockAgent({
      name: "kb",
      responses: [
        {
          content: JSON.stringify({
            urls: ["https://help/a", "https://help/b"],
          }),
          finishReason: "stop",
        },
      ],
    });
    const qaAgent = mockAgent({
      name: "qa",
      responses: [
        {
          content: JSON.stringify({ approved: false, feedback: "be nicer" }),
          finishReason: "stop",
        },
        {
          content: JSON.stringify({ approved: true, feedback: "" }),
          finishReason: "stop",
        },
      ],
    });

    const store = snapshotMemory<WorkflowSnapshot>();

    const wf = workflow({
      name: "support-ticket-processor",
      snapshotStore: store,
      steps: [
        step({
          name: "classify",
          agent: classifierAgent,
          input: ctx => ({ prompt: `classify: ${(ctx.input as any).ticket}` }),
          output: {
            extract: ctx => JSON.parse(ctx.agentResult!.text as string),
            schema: passthrough,
          },
        }),
        step({
          name: "enrich",
          agent: historyAgent,
          skip: ctx => (ctx.steps.classify?.output as any)?.priority !== "high",
          input: ctx => ({
            prompt: `history for ${(ctx.input as any).customerId}`,
          }),
          output: {
            extract: ctx => JSON.parse(ctx.agentResult!.text as string),
          },
        }),
        step({
          name: "generate",
          parallel: [
            step({
              name: "draft",
              agent: writerAgent,
              input: ctx => ({
                prompt: `reply ${ctx.state.qaFeedback ? `(feedback: ${ctx.state.qaFeedback})` : ""}`,
              }),
              output: {
                extract: ctx => JSON.parse(ctx.agentResult!.text as string),
              },
            }),
            step({
              name: "kb-articles",
              agent: kbAgent,
              input: () => ({ prompt: "kb lookup" }),
              output: {
                extract: ctx => JSON.parse(ctx.agentResult!.text as string),
              },
            }),
          ],
        }),
        step({
          name: "qa",
          agent: qaAgent,
          input: ctx => ({
            prompt: `review draft: ${JSON.stringify(ctx.steps.draft?.output)}`,
          }),
          output: {
            extract: ctx => JSON.parse(ctx.agentResult!.text as string),
          },
          nextStep: ctx => {
            const review = ctx.steps.qa?.output as any;
            const latest = ctx.agentResult
              ? JSON.parse(ctx.agentResult.text as string)
              : review;
            if (latest && !latest.approved) {
              ctx.state.qaFeedback = latest.feedback;
              return { goto: "generate" };
            }
          },
        }),
      ],
      output: {
        extract: ctx => ({
          reply: (ctx.steps.draft?.output as any)?.response,
          kbUrls: (ctx.steps["kb-articles"]?.output as any)?.urls,
        }),
      },
    });

    const result = await wf.execute({
      input: { ticket: "I was double-charged", customerId: "c_42" },
      runId: "t-1",
    });

    expect(result.error).toBeUndefined();
    expect(result.report.status).toBe("completed");
    // Draft ran twice thanks to loop-back; second draft wins.
    expect((result.data as any).reply).toBe("revised draft");
    expect((result.data as any).kbUrls).toHaveLength(2);
    // Snapshot persisted.
    const snapshot = await store.load("t-1");
    expect(snapshot).toBeDefined();
    expect(snapshot!.status).toBe("completed");
  });
});

describe("workflow usage rollup", () => {
  it("propagates a step's optional usage channels into the workflow total (regression: the rollup dropped cachedTokens / cost)", async () => {
    const cachingAgent = mockAgent({
      name: "cacher",
      responses: [
        {
          content: JSON.stringify({ ok: true }),
          finishReason: "stop",
          usage: { input: 100, output: 20, total: 120, cachedTokens: 80 },
        },
      ],
    });

    const wf = workflow({
      name: "rollup-wf",
      steps: [
        step({
          name: "s1",
          agent: cachingAgent,
          input: ctx => ({ prompt: String(ctx.input) }),
        }),
      ],
    });

    const result = await wf.execute("go");

    expect(result.usage.total).toBe(120);
    // Before the shared mergeUsage helper, the step-runner summed only
    // input/output/total and this channel was silently dropped.
    expect(result.usage.cachedTokens).toBe(80);
  });
});
