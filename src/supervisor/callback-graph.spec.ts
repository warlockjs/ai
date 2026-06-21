import { describe, expect, it } from "vitest";
import { END } from "../contracts/end.type";
import { buildScriptedAgent, schema } from "./_test-helpers";
import { supervisor } from "./supervisor";

/**
 * Phase 3.3 stage 3d — full callback-only supervisor example.
 *
 * Demonstrates a LangGraph-style flow where every routable intent is
 * a dev-controlled callback, and the agents that produce LLM output
 * are wired in as `dispatch.byName` targets rather than routed to
 * directly. The shape:
 *
 *   route: classify → lookup → respond → END
 *
 *   intents.classify   (callback) → ctx.intents["classifier-agent"].execute()
 *   intents.lookup     (callback) → reads ctx.iterations, dispatches kb OR billing agent
 *   intents.respond    (callback) → reads ctx.iterations, dispatches responder agent
 *
 *   intents["classifier-agent"] (agent) — not routed to; reachable via ctx.intents.X.execute
 *   intents["kb-agent"]         (agent) — same
 *   intents["billing-agent"]    (agent) — same
 *   intents["responder-agent"]  (agent) — same
 *
 * State threading uses `ctx.iterations` — each callback reads the
 * previous iteration's output to decide what to do. Stage 4b will
 * replace this with the typed `ctx.state` accumulator; for now this
 * spec verifies the property-access composition pattern.
 */

describe("ai.supervisor — callback-only graph (LangGraph-style)", () => {
  it("orchestrates a 3-callback pipeline with agents invoked via ctx.intents.X.execute", async () => {
    // --- Helper agents (LLM-backed leaves) ---
    const classifier = buildScriptedAgent({
      name: "classifier",
      description: "Classifies a ticket as billing | knowledge | other",
      responses: [{ content: "billing", finishReason: "stop" }],
    });

    const kbAgent = buildScriptedAgent({
      name: "kb",
      description: "Knowledge base lookup",
      responses: [
        { content: "kb-hit: warranty info...", finishReason: "stop" },
      ],
    });

    const billingAgent = buildScriptedAgent({
      name: "billing",
      description: "Billing system lookup",
      responses: [
        { content: "billing-hit: order #42 refundable", finishReason: "stop" },
      ],
    });

    const responder = buildScriptedAgent({
      name: "responder",
      description: "Drafts the final customer reply",
      responses: [
        {
          content: "Your order #42 is refundable. We've initiated it.",
          finishReason: "stop",
        },
      ],
    });

    // --- Tiny wire-up to surface what each callback sees ---
    const trace: Array<{
      stage: string;
      intent: string;
      iteration: number;
      input: unknown;
      iterationsLength: number;
    }> = [];

    // --- The supervisor ---
    const sup = supervisor<{ category: string; lookup: string; reply: string }>(
      {
        name: "ticket-graph",

        route: ctx => {
          if (ctx.iteration === 0) return "classify";
          if (ctx.iteration === 1) return "lookup";
          if (ctx.iteration === 2) return "respond";
          return END;
        },

        intents: {
          // ---- Node 1: classify ----
          classify: async ctx => {
            trace.push({
              stage: "classify",
              intent: ctx.intent,
              iteration: ctx.iteration,
              input: ctx.input,
              iterationsLength: ctx.iterations.length,
            });

            const category = await ctx.intents["classifier-agent"].execute();
            return { category: String(category).trim() };
          },

          // ---- Node 2: lookup (branches on classify output) ----
          lookup: async ctx => {
            trace.push({
              stage: "lookup",
              intent: ctx.intent,
              iteration: ctx.iteration,
              input: ctx.input,
              iterationsLength: ctx.iterations.length,
            });

            // Read prior iteration's classify output via the iterations trace.
            const classifyOutput = ctx.iterations[0]?.result.classify
              ?.output as { category: string } | undefined;
            const category = classifyOutput?.category ?? "other";

            const target =
              category === "billing" ? "billing-agent" : "kb-agent";
            const lookupResult = await ctx.intents[target].execute();

            return { lookup: String(lookupResult), categoryUsed: category };
          },

          // ---- Node 3: respond (composes the final reply) ----
          respond: async ctx => {
            trace.push({
              stage: "respond",
              intent: ctx.intent,
              iteration: ctx.iteration,
              input: ctx.input,
              iterationsLength: ctx.iterations.length,
            });

            const lookupOutput = ctx.iterations[1]?.result.lookup?.output as
              | { lookup: string }
              | undefined;

            const reply = await ctx.intents["responder-agent"].execute();

            return {
              reply: String(reply),
              usedLookup: lookupOutput?.lookup,
            };
          },

          // ---- Helper agents (reachable via ctx.intents.X.execute, not routed to) ----
          "classifier-agent": classifier,
          "kb-agent": kbAgent,
          "billing-agent": billingAgent,
          "responder-agent": responder,
        },

        // Stage 4c: combine is gone. The supervisor's `output` schema
        // validates the accumulated state — each callback's return value
        // shallow-merged into state across iterations:
        //   classify → { category }
        //   lookup   → { lookup, categoryUsed }
        //   respond  → { reply, usedLookup }
        output: schema<{ category: string; lookup: string; reply: string }>(
          value => {
            const v = value as Record<string, unknown> | undefined;
            return {
              value: {
                category: String(v?.category ?? ""),
                lookup: String(v?.lookup ?? ""),
                reply: String(v?.reply ?? ""),
              },
            };
          },
        ),

        maxIterations: 4,
      },
    );

    const result = await sup.execute(
      "My order #42 should have been refunded weeks ago",
    );

    // ---- Result shape ----
    expect(result.error).toBeUndefined();
    expect(result.data?.reply).toContain("Your order #42 is refundable");

    // ---- Trace shape ----
    expect(trace).toEqual([
      {
        stage: "classify",
        intent: "classify",
        iteration: 0,
        input: "My order #42 should have been refunded weeks ago",
        iterationsLength: 0,
      },
      {
        stage: "lookup",
        intent: "lookup",
        iteration: 1,
        input: "My order #42 should have been refunded weeks ago",
        iterationsLength: 1,
      },
      {
        stage: "respond",
        intent: "respond",
        iteration: 2,
        input: "My order #42 should have been refunded weeks ago",
        iterationsLength: 2,
      },
    ]);

    // ---- Report tree shape: 3 callback nodes at top level, each
    //      with one nested agent child, plus the agents-not-routed-to
    //      should NOT appear at the supervisor's top level. ----
    const topLevelTypes = result.report.children.map(
      child => `${child.type}:${child.name}`,
    );

    expect(topLevelTypes).toEqual(
      expect.arrayContaining([
        "callback:classify",
        "callback:lookup",
        "callback:respond",
      ]),
    );

    // No top-level agent nodes for the helpers — their reports nest
    // under the callback that dispatched them.
    expect(topLevelTypes).not.toContain("agent:classifier");
    expect(topLevelTypes).not.toContain("agent:kb");
    expect(topLevelTypes).not.toContain("agent:billing");
    expect(topLevelTypes).not.toContain("agent:responder");

    // Each callback node has exactly one nested agent child.
    const classifyNode = result.report.children.find(
      child => child.type === "callback" && child.name === "classify",
    );
    expect(classifyNode?.children.length).toBe(1);
    expect(classifyNode?.children[0]?.type).toBe("agent");
    expect(classifyNode?.children[0]?.name).toBe("classifier");

    const lookupNode = result.report.children.find(
      child => child.type === "callback" && child.name === "lookup",
    );
    expect(lookupNode?.children.length).toBe(1);
    expect(lookupNode?.children[0]?.name).toBe("billing"); // routed to billing because classify said "billing"

    const respondNode = result.report.children.find(
      child => child.type === "callback" && child.name === "respond",
    );
    expect(respondNode?.children.length).toBe(1);
    expect(respondNode?.children[0]?.name).toBe("responder");

    // ---- Usage rollup: each callback node's total = its child agent's total ----
    expect(classifyNode?.usage.total).toBe(
      classifyNode?.children[0]?.usage.total,
    );
    expect(lookupNode?.usage.total).toBe(lookupNode?.children[0]?.usage.total);
    expect(respondNode?.usage.total).toBe(
      respondNode?.children[0]?.usage.total,
    );
  });
});

// Stage 4c removed the combine helpers — combine no longer exists,
// and state accumulation across iterations does the work directly.
// The legacy helpers below are dead but kept temporarily because
// other parts of the file may still reference them.
function ctx_classifySnapshot(
  _branches: Record<string, { output: unknown }>,
): string {
  return "billing";
}
function ctx_lookupSnapshot(
  _branches: Record<string, { output: unknown }>,
): string | undefined {
  return undefined;
}
