import { describe, expect, it } from "vitest";
import type { AgentContract } from "../contracts/agent/agent.contract";
import { END } from "../contracts/end.type";
import type { MaxIterationsError, SupervisorRoutingError } from "../errors";
import { step } from "../workflow/step";
import { workflow } from "../workflow/workflow";
import { buildScriptedAgent, routerDecision, schema } from "./_test-helpers";
import { supervisor } from "./supervisor";

function makeScripted(
  name: string,
  description: string,
  content: string,
): AgentContract {
  return buildScriptedAgent({
    name,
    description,
    responses: [{ content, finishReason: "stop" }],
  });
}

describe("ai.supervisor — factory validation", () => {
  it("requires name", () => {
    expect(() =>
      supervisor({
        name: "",
        intents: { a: makeScripted("a", "a", "ok") },
        route: () => END,
      } as any),
    ).toThrow(/`name` is required/);
  });

  it("rejects both route and router set", () => {
    expect(() =>
      supervisor({
        name: "bad",
        intents: { a: makeScripted("a", "a", "ok") },
        route: () => END,
        router: makeScripted("r", "r", "{}") as any,
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects neither route nor router set", () => {
    expect(() =>
      supervisor({
        name: "bad",
        intents: { a: makeScripted("a", "a", "ok") },
      } as any),
    ).toThrow(/one of `route`, `router`, or `classifier` is required/);
  });

  it("allows evaluate paired with route (Q9 — restriction lifted)", async () => {
    // Phase 3.4 lifted the historical router-only restriction on
    // evaluate. State-driven termination ("if state has X, satisfied")
    // is just as useful in route mode as in router mode.
    let evaluateCalls = 0;
    const supervisorInstance = supervisor({
      name: "evaluate-with-route",
      intents: { a: makeScripted("a", "a", "ok") },
      route: ctx => (ctx.iteration === 0 ? "a" : END),
      evaluate: () => {
        evaluateCalls += 1;
        return { satisfied: true };
      },
    });

    const result = await supervisorInstance.execute("seed");
    expect(result.error).toBeUndefined();
    expect(evaluateCalls).toBeGreaterThan(0);
    expect(result.report.terminatedBy).toBe("evaluate");
  });

  it("rejects missing description on agent when a router is configured", () => {
    const agentWithoutDescription = buildScriptedAgent({
      name: "nada",
      responses: [{ content: "ok", finishReason: "stop" }],
    });

    expect(() =>
      supervisor({
        name: "bad",
        intents: { nada: agentWithoutDescription },
        router: makeScripted("r", "router", "{}") as any,
      }),
    ).toThrow(/needs a description/);
  });

  it("allows missing description on agent under deterministic route", () => {
    const agentWithoutDescription = buildScriptedAgent({
      name: "nada",
      responses: [{ content: "ok", finishReason: "stop" }],
    });

    expect(() =>
      supervisor({
        name: "ok",
        intents: { nada: agentWithoutDescription },
        route: () => END,
      }),
    ).not.toThrow();
  });

  it("rejects initialAgent that is not a registered intent", () => {
    expect(() =>
      supervisor({
        name: "bad",
        intents: { a: makeScripted("a", "a", "ok") },
        route: () => END,
        initialAgent: "missing",
      }),
    ).toThrow(/is not a key in `intents`/);
  });
});

describe("ai.supervisor — deterministic route dispatch", () => {
  it("runs a single-agent iteration then terminates on END", async () => {
    const writer = makeScripted("writer", "drafts content", "hello");

    const decisions: Array<number> = [];

    const supervisorInstance = supervisor({
      name: "single",
      intents: { writer },
      route: ctx => {
        decisions.push(ctx.iteration);
        return ctx.iteration === 0 ? "writer" : END;
      },
    });

    const result = await supervisorInstance.execute("topic");

    expect(result.error).toBeUndefined();
    expect(result.report.status).toBe("completed");
    expect(result.report.terminatedBy).toBe("route");
    expect(result.report.iterations).toBe(2);
    expect(decisions).toEqual([0, 1]);
  });

  it("dispatches fan-out when route returns string[]", async () => {
    const market = makeScripted("market", "market analysis", "market-result");
    const pricing = makeScripted(
      "pricing",
      "pricing analysis",
      "pricing-result",
    );
    const synth = makeScripted("synth", "synthesizer", "synth-result");

    const supervisorInstance = supervisor({
      name: "fan-out-flow",
      intents: { market, pricing, synth },
      route: ctx => {
        if (ctx.iteration === 0) {
          return ["market", "pricing"];
        }

        if (ctx.iteration === 1) {
          return "synth";
        }

        return END;
      },
    });

    const result = await supervisorInstance.execute("competitive analysis");

    expect(result.error).toBeUndefined();
    expect(result.report.iterations).toBe(3);

    const firstIteration = result.report.snapshots[0];
    expect(Object.keys(firstIteration.result).sort()).toEqual([
      "market",
      "pricing",
    ]);

    const lastIteration = result.report.snapshots[1];
    expect(Object.keys(lastIteration.result)).toEqual(["synth"]);
  });

  it("captures per-branch errors without aborting siblings", async () => {
    const good = makeScripted("good", "ok", "ok-payload");
    const bad = buildScriptedAgent({
      name: "bad",
      description: "always throws",
      responses: [
        { content: "", finishReason: "error", error: new Error("boom") },
      ],
    });

    const supervisorInstance = supervisor({
      name: "resilient-fanout",
      intents: { good, bad },
      route: ctx => (ctx.iteration === 0 ? ["good", "bad"] : END),
    });

    const result = await supervisorInstance.execute("x");

    const snapshot = result.report.snapshots[0];
    expect(snapshot.result.good.error).toBeUndefined();
    expect(snapshot.result.bad.error).toBeDefined();
  });

  it("enforces maxIterations", async () => {
    const worker = makeScripted("worker", "loops", "ok");

    const supervisorInstance = supervisor({
      name: "looping",
      intents: { worker },
      route: () => "worker",
      maxIterations: 3,
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe("SUPERVISOR_MAX_ITERATIONS");
    expect((result.error as MaxIterationsError).maxIterations).toBe(3);
    expect(result.report.status).toBe("max-iterations");
    expect(result.report.terminatedBy).toBe("max-iterations");
  });

  it("routing to an unknown intent throws SupervisorRoutingError", async () => {
    const worker = makeScripted("worker", "ok", "ok");

    const supervisorInstance = supervisor({
      name: "bad-route",
      intents: { worker },
      route: () => "ghost",
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error?.code).toBe("SUPERVISOR_INVALID_ROUTE");
    expect((result.error as SupervisorRoutingError).availableKeys).toEqual([
      "worker",
    ]);
  });

  it("terminates immediately when first decision is END", async () => {
    const worker = makeScripted("worker", "ok", "ok");

    const supervisorInstance = supervisor({
      name: "immediate-end",
      intents: { worker },
      route: () => END,
    });

    const result = await supervisorInstance.execute("x");

    expect(result.report.status).toBe("completed");
    expect(result.report.terminatedBy).toBe("route");
    expect(result.report.iterations).toBe(1);
  });

  it("skips routing on turn 0 when initialAgent is set", async () => {
    const triage = makeScripted("triage", "triage", "triaged");
    const resolver = makeScripted("resolver", "resolver", "resolved");

    const seen: number[] = [];

    const supervisorInstance = supervisor({
      name: "with-initial",
      intents: { triage, resolver },
      initialAgent: "triage",
      route: ctx => {
        seen.push(ctx.iteration);
        return ctx.iteration >= 1 ? END : "resolver";
      },
    });

    const result = await supervisorInstance.execute("x");

    // route() must NOT fire on iteration 0 — initialAgent bypasses it
    expect(seen).not.toContain(0);
    expect(result.report.snapshots[0].decision.source).toBe("initialAgent");
  });
});

describe("ai.supervisor — output schema + state validation (Stage 4b/4c)", () => {
  // Phase 3.4: output schema validates the supervisor's accumulated
  // state (Q8). Intents contribute slices via per-intent output
  // schemas (Q11/Q13 — strip-merge into state). Stage 4c dropped
  // `combine` entirely — fan-out branches shallow-merge into state;
  // custom merging is handled via callback-orchestrator intents.

  it("validates accumulated state against the output schema on clean termination", async () => {
    const supervisorInstance = supervisor<{ category: string; reply: string }>({
      name: "state-validate",
      intents: {
        classify: {
          run: async () => ({ category: "billing" }),
          description: "classifies",
          output: schema<{ category: string }>(v =>
            typeof (v as { category?: unknown })?.category === "string"
              ? { value: { category: (v as { category: string }).category } }
              : { issues: [{ message: "missing category" }] },
          ),
        },
        respond: {
          run: async () => ({ reply: "Got it." }),
          description: "responds",
          output: schema<{ reply: string }>(v =>
            typeof (v as { reply?: unknown })?.reply === "string"
              ? { value: { reply: (v as { reply: string }).reply } }
              : { issues: [{ message: "missing reply" }] },
          ),
        },
      },
      route: ctx =>
        ctx.iteration === 0
          ? "classify"
          : ctx.iteration === 1
            ? "respond"
            : END,
      output: schema<{ category: string; reply: string }>(v => {
        const obj = v as { category?: unknown; reply?: unknown };
        if (
          typeof obj?.category === "string" &&
          typeof obj?.reply === "string"
        ) {
          return { value: { category: obj.category, reply: obj.reply } };
        }
        return { issues: [{ message: "incomplete state" }] };
      }),
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ category: "billing", reply: "Got it." });
  });

  it("fan-out: parallel-write conflict resolves by decision-array order (Q15)", async () => {
    // Two callbacks both write `winner` — the LATER one in the
    // route's decision array wins. Q15 conflict rule.
    const supervisorInstance = supervisor<{ winner: string }>({
      name: "fanout-conflict",
      intents: {
        first: {
          run: async () => ({ winner: "first" }),
          description: "writes winner=first",
          output: schema<{ winner: string }>(v =>
            typeof (v as { winner?: unknown })?.winner === "string"
              ? { value: { winner: (v as { winner: string }).winner } }
              : { issues: [{ message: "no winner" }] },
          ),
        },
        last: {
          run: async () => ({ winner: "last" }),
          description: "writes winner=last",
          output: schema<{ winner: string }>(v =>
            typeof (v as { winner?: unknown })?.winner === "string"
              ? { value: { winner: (v as { winner: string }).winner } }
              : { issues: [{ message: "no winner" }] },
          ),
        },
      },
      route: ctx => (ctx.iteration === 0 ? ["first", "last"] : END),
      output: schema<{ winner: string }>(v =>
        typeof (v as { winner?: unknown })?.winner === "string"
          ? { value: { winner: (v as { winner: string }).winner } }
          : { issues: [{ message: "no winner" }] },
      ),
    });

    const result = await supervisorInstance.execute("x");
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ winner: "last" });
  });

  it("output-schema validation failure surfaces as SchemaValidationError on result.error", async () => {
    const supervisorInstance = supervisor<{ required: string }>({
      name: "incomplete-state",
      intents: {
        partial: {
          run: async () => ({ irrelevant: 1 }),
          description: "writes nothing matching the schema",
        },
      },
      route: ctx => (ctx.iteration === 0 ? "partial" : END),
      output: schema<{ required: string }>(v =>
        typeof (v as { required?: unknown })?.required === "string"
          ? { value: { required: (v as { required: string }).required } }
          : { issues: [{ message: "missing required key" }] },
      ),
    });

    const result = await supervisorInstance.execute("x");
    expect(result.error?.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(result.data).toBeUndefined();
  });
});

describe("ai.supervisor — state-aware contexts (Stage 4b)", () => {
  it("threads ctx.state through callback intents and updates across iterations", async () => {
    const seen: Array<Record<string, unknown>> = [];

    const supervisorInstance = supervisor({
      name: "state-thread",
      intents: {
        first: {
          run: async ctx => {
            seen.push({ phase: "first", state: { ...(ctx.state as object) } });
            return { count: 1 };
          },
          description: "writes count=1",
          output: schema<{ count: number }>(v =>
            typeof (v as { count?: unknown })?.count === "number"
              ? { value: { count: (v as { count: number }).count } }
              : { issues: [{ message: "no count" }] },
          ),
        },
        second: {
          run: async ctx => {
            seen.push({ phase: "second", state: { ...(ctx.state as object) } });
            return {
              doubled: ((ctx.state as { count?: number }).count ?? 0) * 2,
            };
          },
          description: "reads count, writes doubled",
          output: schema<{ doubled: number }>(v =>
            typeof (v as { doubled?: unknown })?.doubled === "number"
              ? { value: { doubled: (v as { doubled: number }).doubled } }
              : { issues: [{ message: "no doubled" }] },
          ),
        },
      },
      route: ctx =>
        ctx.iteration === 0 ? "first" : ctx.iteration === 1 ? "second" : END,
    });

    await supervisorInstance.execute("seed");

    expect(seen[0]).toEqual({ phase: "first", state: {} });
    expect(seen[1]).toEqual({ phase: "second", state: { count: 1 } });
  });

  it("evaluate sees post-merge ctx.state for state-driven termination", async () => {
    const stateSnapshots: Array<Record<string, unknown>> = [];

    const supervisorInstance = supervisor<{ done: boolean }>({
      name: "state-evaluate",
      intents: {
        worker: {
          run: async () => ({ done: true }),
          description: "marks done",
          output: schema<{ done: boolean }>(v =>
            typeof (v as { done?: unknown })?.done === "boolean"
              ? { value: { done: (v as { done: boolean }).done } }
              : { issues: [{ message: "no done" }] },
          ),
        },
      },
      route: ctx => (ctx.iteration < 3 ? "worker" : END),
      evaluate: ctx => {
        stateSnapshots.push({ ...(ctx.state as object) });
        return (ctx.state as { done?: boolean }).done
          ? { satisfied: true }
          : undefined;
      },
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error).toBeUndefined();
    expect(result.report.terminatedBy).toBe("evaluate");
    // evaluate fired after iteration 0 with done=true → terminate.
    expect(stateSnapshots.length).toBe(1);
    expect(stateSnapshots[0]).toEqual({ done: true });
  });

  it("iteration snapshot carries state for resume rehydration", async () => {
    const supervisorInstance = supervisor({
      name: "snapshot-state",
      intents: {
        worker: {
          run: async () => ({ value: 42 }),
          description: "writes value",
          output: schema<{ value: number }>(v =>
            typeof (v as { value?: unknown })?.value === "number"
              ? { value: { value: (v as { value: number }).value } }
              : { issues: [{ message: "no value" }] },
          ),
        },
      },
      route: ctx => (ctx.iteration === 0 ? "worker" : END),
    });

    const result = await supervisorInstance.execute("x");

    expect(result.report.snapshots[0].state).toEqual({ value: 42 });
  });
});

describe("ai.supervisor — per-agent input and output overrides", () => {
  it("applies a per-agent input transformer", async () => {
    const seen: string[] = [];

    const writerModel = buildScriptedAgent({
      name: "writer",
      description: "drafts",
      responses: [{ content: "draft", finishReason: "stop" }],
    });

    const supervisorInstance = supervisor({
      name: "input-override",
      intents: {
        writer: {
          agent: writerModel,
          description: "drafts with custom input",
          input: ctx => `CUSTOM:${ctx.input}`,
        },
      },
      route: ctx => (ctx.iteration === 0 ? "writer" : END),
    });

    const supervisorExecution = await supervisorInstance.execute("topic");
    void supervisorExecution;

    // Inspect the snapshot's resolved input to verify the transformer
    // ran — the branch input field records what was actually sent.
    const snapshot = supervisorExecution.report.snapshots[0];
    expect(snapshot.result.writer.input).toBe("CUSTOM:topic");
    void seen;
  });

  it("strip-merges callback output through the per-intent output schema (Q11/Q13)", async () => {
    // Stage 4b shifts intent.output from a transformer callback to a
    // Standard Schema. The schema strips returned data to validated
    // keys before snapshot + state merge. Callback intents make this
    // easiest to test — they return objects directly.
    const supervisorInstance = supervisor<{ category: string }>({
      name: "output-schema",
      output: schema<{ category: string }>(value => {
        if (
          value &&
          typeof value === "object" &&
          typeof (value as { category?: unknown }).category === "string"
        ) {
          return {
            value: { category: (value as { category: string }).category },
          };
        }
        return { issues: [{ message: "missing category" }] };
      }),
      intents: {
        classify: {
          run: async () => ({ category: "billing", confidence: 0.97 }),
          description: "classifies",
          output: schema<{ category: string }>(value => {
            if (
              value &&
              typeof value === "object" &&
              typeof (value as { category?: unknown }).category === "string"
            ) {
              return {
                value: { category: (value as { category: string }).category },
              };
            }
            return { issues: [{ message: "missing category" }] };
          }),
        },
      },
      route: ctx => (ctx.iteration === 0 ? "classify" : END),
    });

    const result = await supervisorInstance.execute("x");

    const snapshot = result.report.snapshots[0];
    // Snapshot.output reflects the validated slice — `confidence` stripped.
    expect(snapshot.result.classify.output).toEqual({ category: "billing" });
    // State accumulator carries the same slice; supervisor.output
    // schema validates the final state shape.
    expect(snapshot.state).toEqual({ category: "billing" });
    expect(result.data).toEqual({ category: "billing" });
  });
});

describe("ai.supervisor — workflow as dispatchable unit", () => {
  it("dispatches a workflow alongside agents", async () => {
    const research = workflow({
      name: "research",
      description: "runs research steps",
      steps: [
        step({
          name: "collect",
          run: () => "dataset",
          output: { extract: () => "dataset" },
        }),
      ],
    });

    const resolver = makeScripted("resolver", "resolver", "final");

    const supervisorInstance = supervisor({
      name: "mixed",
      intents: { research, resolver },
      route: ctx => {
        if (ctx.iteration === 0) {
          return "research";
        }

        if (ctx.iteration === 1) {
          return "resolver";
        }

        return END;
      },
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error).toBeUndefined();
    expect(result.report.snapshots[0].result.research).toBeDefined();
    expect(result.report.snapshots[1].result.resolver).toBeDefined();
  });
});

describe("ai.supervisor — router-agent dispatch", () => {
  it("dispatches based on router agent output", async () => {
    const triage = makeScripted("triage", "classifies tickets", "triage-data");
    const resolver = makeScripted(
      "resolver",
      "final response drafter",
      "resolver-data",
    );

    const routerAgent = buildScriptedAgent({
      name: "router",
      description: "routes",
      responses: [
        { content: routerDecision("triage"), finishReason: "stop" },
        { content: routerDecision("resolver"), finishReason: "stop" },
        { content: routerDecision(END), finishReason: "stop" },
      ],
    });

    const supervisorInstance = supervisor({
      name: "router-driven",
      router: routerAgent as any,
      intents: { triage, resolver },
    });

    const result = await supervisorInstance.execute("order #123 late");

    expect(result.error).toBeUndefined();
    expect(result.report.iterations).toBe(3);
    expect(result.report.snapshots[0].decision.source).toBe("router");
    expect(result.report.snapshots[0].result.triage).toBeDefined();
    expect(result.report.snapshots[1].result.resolver).toBeDefined();
    expect(result.report.terminatedBy).toBe("router");
  });

  it("accepts the RouterEntry object form with placeholders + input overrides", async () => {
    // Q2 lock — `router` accepts `{ agent, placeholders?, input? }`
    // symmetric with `IntentEntry`. Output schema stays framework-
    // controlled; the entry form only adds prompt-shaping hooks.
    const triage = makeScripted("triage", "classifies tickets", "ok");

    let placeholdersCalled = false;
    let inputOverrideCalled = false;

    const routerAgent = buildScriptedAgent({
      name: "router",
      description: "routes",
      responses: [
        { content: routerDecision("triage"), finishReason: "stop" },
        { content: routerDecision(END), finishReason: "stop" },
      ],
    });

    const supervisorInstance = supervisor({
      name: "router-entry-form",
      router: {
        agent: routerAgent,
        placeholders: ctx => {
          placeholdersCalled = true;
          // ctx.iteration is typed as number, ctx.input is SupervisorInput
          return { tone: ctx.iteration === 0 ? "fresh" : "follow-up" };
        },
        input: ctx => {
          inputOverrideCalled = true;
          return `pick next intent for: ${typeof ctx.input === "string" ? ctx.input : "structured"}`;
        },
      },
      intents: { triage },
    });

    const result = await supervisorInstance.execute("order #123 late");

    expect(result.error).toBeUndefined();
    expect(placeholdersCalled).toBe(true);
    expect(inputOverrideCalled).toBe(true);
    expect(result.report.snapshots[0].decision.source).toBe("router");
  });

  it("threads `options.context` into every ctx surface, frozen + shallow-copied", async () => {
    // Q3 lock — `execute(input, { context })` reaches `route` /
    // `evaluate` / intent callbacks via `ctx.context`. Shallow copy +
    // freeze at intake; mutating the caller's bag after the call
    // should NOT leak into ongoing iterations.
    const captured: Array<Record<string, unknown>> = [];
    let frozen: boolean | undefined;

    const supervisorInstance = supervisor({
      name: "context-thread",
      intents: {
        echo: async ctx => {
          captured.push(ctx.context);
          frozen = Object.isFrozen(ctx.context);
          return { traceId: ctx.context.traceId };
        },
      },
      route: ctx => (ctx.iteration === 0 ? "echo" : END),
      evaluate: ctx => {
        captured.push(ctx.context);
        return undefined;
      },
    });

    const callerBag: Record<string, unknown> = {
      traceId: "trc-1",
      userId: "u_42",
    };
    const result = await supervisorInstance.execute("hi", {
      context: callerBag,
    });

    // Caller-side mutation after execute must not affect captured snapshots.
    callerBag.traceId = "MUTATED";

    expect(result.error).toBeUndefined();
    expect(frozen).toBe(true);
    expect(captured.length).toBe(2); // intent + evaluate
    expect(captured[0]?.traceId).toBe("trc-1");
    expect(captured[1]?.traceId).toBe("trc-1");
  });

  it("defaults `ctx.context` to a frozen empty object when omitted", async () => {
    let observed: Readonly<Record<string, unknown>> | undefined;

    const supervisorInstance = supervisor({
      name: "context-default",
      intents: {
        echo: async ctx => {
          observed = ctx.context;
          return {};
        },
      },
      route: ctx => (ctx.iteration === 0 ? "echo" : END),
    });

    await supervisorInstance.execute("hi");

    expect(observed).toBeDefined();
    expect(Object.keys(observed!)).toEqual([]);
    expect(Object.isFrozen(observed)).toBe(true);
  });

  it("accepts a structured object as supervisor input (Q1)", async () => {
    // Q1 lock — `supervisor.execute()` accepts `string | Record<string, unknown>`.
    // Object inputs JSON-stringify when forwarded to a child agent
    // without an explicit `entry.input(ctx)` override.
    const triage = makeScripted("triage", "classifies tickets", "ok");

    const routerAgent = buildScriptedAgent({
      name: "router",
      description: "routes",
      responses: [
        { content: routerDecision("triage"), finishReason: "stop" },
        { content: routerDecision(END), finishReason: "stop" },
      ],
    });

    const supervisorInstance = supervisor({
      name: "object-input",
      router: routerAgent as any,
      intents: { triage },
    });

    const result = await supervisorInstance.execute({
      orderId: "123",
      reason: "late delivery",
    });

    expect(result.error).toBeUndefined();
    // Snapshot input mirrors the original payload — object preserved
    // at the supervisor surface, stringified only when forwarded to
    // child agents.
    expect(typeof result.report.snapshots[0].result.triage.input).toBe(
      "string",
    );
    expect(result.report.snapshots[0].result.triage.input).toContain("orderId");
  });
});

describe("ai.supervisor — receptionist (ack)", () => {
  const ackOutputSchema = schema<{ ack: string }>(value => {
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { ack?: unknown }).ack !== "string"
    ) {
      return { issues: [{ message: "ack must be { ack: string }" }] };
    }
    return { value: value as { ack: string } };
  });

  it("agent form — fires on iter 0, merges slice, surfaces report.ack", async () => {
    const triage = makeScripted("triage", "specialist", "specialist-result");

    const receptionist = buildScriptedAgent({
      name: "receptionist",
      description: "receptionist",
      responses: [
        { content: '{"ack":"Looking into it now"}', finishReason: "stop" },
      ],
    });

    let ackCompletedCalled = false;

    const supervisorInstance = supervisor({
      name: "with-ack-agent",
      intents: { triage },
      route: ctx => (ctx.iteration === 0 ? "triage" : END),
      ack: {
        agent: receptionist,
        output: ackOutputSchema,
      },
      on: {
        "supervisor.ack.completed": () => {
          ackCompletedCalled = true;
        },
      },
    });

    const result = await supervisorInstance.execute("hello");

    expect(result.error).toBeUndefined();
    expect(ackCompletedCalled).toBe(true);
    expect(result.report.ack).toBeDefined();
    expect(result.report.ack?.error).toBeUndefined();
    expect((result.data as { ack?: string })?.ack).toBe("Looking into it now");
    expect(
      result.report.children.some(child => child.name === "receptionist"),
    ).toBe(true);
    expect(result.usage.total).toBeGreaterThan(0);
  });

  it("run-entry form — pure-code ack with optional output schema", async () => {
    const triage = makeScripted("triage", "specialist", "specialist-result");

    const supervisorInstance = supervisor({
      name: "with-ack-run",
      intents: { triage },
      route: ctx => (ctx.iteration === 0 ? "triage" : END),
      ack: {
        run: () => ({ ack: "Got it, one moment..." }),
        output: ackOutputSchema,
      },
    });

    const result = await supervisorInstance.execute("hello");

    expect(result.error).toBeUndefined();
    expect(result.report.ack).toBeDefined();
    expect(result.report.ack?.error).toBeUndefined();
    expect((result.data as { ack?: string })?.ack).toBe(
      "Got it, one moment...",
    );
    // Pure-code ack contributes no LLM usage.
    expect(result.report.ack?.usage.total).toBe(0);
  });

  it("bare-callback shorthand — instant ack, no schema needed", async () => {
    const triage = makeScripted("triage", "specialist", "specialist-result");

    const supervisorInstance = supervisor({
      name: "with-ack-callback",
      intents: { triage },
      route: ctx => (ctx.iteration === 0 ? "triage" : END),
      ack: () => ({ ack: "Bare-callback ack" }),
    });

    const result = await supervisorInstance.execute("hello");

    expect(result.error).toBeUndefined();
    expect(result.report.ack).toBeDefined();
    expect((result.data as { ack?: string })?.ack).toBe("Bare-callback ack");
  });

  it("ack failure does not abort the run", async () => {
    const triage = makeScripted("triage", "specialist", "specialist-result");

    const receptionist = buildScriptedAgent({
      name: "receptionist",
      description: "receptionist",
      responses: [{ content: "not valid json", finishReason: "stop" }],
    });

    const supervisorInstance = supervisor({
      name: "ack-failure",
      intents: { triage },
      route: ctx => (ctx.iteration === 0 ? "triage" : END),
      ack: {
        agent: receptionist,
        output: ackOutputSchema,
      },
    });

    const result = await supervisorInstance.execute("hi");

    expect(result.report.status).toBe("completed");
    expect(result.report.ack).toBeDefined();
    expect(result.report.ack?.error).toBeDefined();
  });
});

describe("ai.supervisor — evaluate verdicts", () => {
  it("terminates the run when evaluate returns satisfied: true", async () => {
    const triage = makeScripted("triage", "classifies", "ok");
    const resolver = makeScripted("resolver", "drafts reply", "reply");

    const routerAgent = buildScriptedAgent({
      name: "router",
      description: "routes",
      responses: [
        { content: routerDecision("triage"), finishReason: "stop" },
        { content: routerDecision("resolver"), finishReason: "stop" },
        { content: routerDecision(END), finishReason: "stop" },
      ],
    });

    const supervisorInstance = supervisor({
      name: "satisfied",
      router: routerAgent as any,
      intents: { triage, resolver },
      evaluate: ctx => (ctx.result.resolver ? { satisfied: true } : undefined),
    });

    const result = await supervisorInstance.execute("x");

    expect(result.report.iterations).toBe(2);
    expect(result.report.terminatedBy).toBe("evaluate");
  });

  it("reassignTo overrides the router's next decision", async () => {
    const triage = makeScripted("triage", "classifies", "triage-data");
    const resolver = makeScripted("resolver", "drafts reply", "reply");

    const routerAgent = buildScriptedAgent({
      name: "router",
      description: "routes",
      responses: [
        { content: routerDecision("triage"), finishReason: "stop" },
        { content: routerDecision("triage"), finishReason: "stop" },
        { content: routerDecision(END), finishReason: "stop" },
      ],
    });

    let callCount = 0;

    const supervisorInstance = supervisor({
      name: "reassign",
      router: routerAgent as any,
      intents: { triage, resolver },
      evaluate: () => {
        callCount += 1;
        // After the first iteration force a reassign to resolver, then stop.
        if (callCount === 1) {
          return { reassignTo: "resolver" };
        }
        return { satisfied: true };
      },
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error).toBeUndefined();
    expect(result.report.snapshots[1].result.resolver).toBeDefined();
    expect(result.report.iterations).toBe(2);
  });

  it("feedback does NOT leak into the next iteration's agent input (Q17/Q18)", async () => {
    // Q17 dropped composeAgentInput; Q18 made feedback router-only.
    // Agents now receive the supervisor's `ctx.input` unchanged
    // unless a per-intent `input` override is configured. Stage 4b
    // will additionally render feedback in the router prompt (router
    // mode) — covered by a future test once that lands.
    const triage = makeScripted("triage", "classifies", "triage-data");
    const resolver = makeScripted("resolver", "drafts reply", "reply");

    const routerAgent = buildScriptedAgent({
      name: "router",
      description: "routes",
      responses: [
        { content: routerDecision("triage"), finishReason: "stop" },
        { content: routerDecision("resolver"), finishReason: "stop" },
        { content: routerDecision(END), finishReason: "stop" },
      ],
    });

    const supervisorInstance = supervisor({
      name: "with-feedback",
      router: routerAgent as any,
      intents: { triage, resolver },
      evaluate: ctx => {
        if (ctx.result.triage) {
          return { feedback: "be concise" };
        }

        return { satisfied: true };
      },
    });

    const result = await supervisorInstance.execute("x");

    const resolverInput = result.report.snapshots[1].result.resolver.input;
    // Agent's user message is the supervisor's original input — no
    // feedback injection at the agent layer.
    expect(resolverInput).toBe("x");
    expect(resolverInput).not.toContain("be concise");
  });
});

describe("ai.supervisor — signature + basic instance surface", () => {
  it("exposes a stable signature on the instance", () => {
    const supervisorInstance = supervisor({
      name: "sig-test",
      intents: { a: makeScripted("a", "a", "ok") },
      route: () => END,
    });

    expect(typeof supervisorInstance.signature).toBe("string");
    expect(supervisorInstance.signature.length).toBeGreaterThan(0);
  });

  it("name matches config", () => {
    const supervisorInstance = supervisor({
      name: "namer",
      intents: { a: makeScripted("a", "a", "ok") },
      route: () => END,
    });

    expect(supervisorInstance.name).toBe("namer");
  });
});

describe("ai.supervisor — per-intent next directive (Stage 4d / Q24)", () => {
  // Phase 3.4 Stage 4d: per-intent `next(ctx)` lets dev pre-declare
  // the successor without consulting the router. Outranks router/route;
  // outranked by evaluate.reassignTo. Fan-out: union of unique
  // intents; END from any branch terminates; silent branches abstain.

  it("single-intent next routes to the named intent without invoking the router", async () => {
    let routeCalls = 0;
    const supervisorInstance = supervisor({
      name: "next-skip-router",
      intents: {
        first: {
          run: async () => ({ phase: "first" }),
          description: "first step",
          next: () => "second",
        },
        second: {
          run: async () => ({ phase: "second" }),
          description: "second step",
          next: () => END,
        },
      },
      // route() would normally pick — but `next` should bypass it
      // entirely after `first` runs.
      route: ctx => {
        routeCalls += 1;
        return ctx.iteration === 0 ? "first" : END;
      },
    });

    const result = await supervisorInstance.execute("seed");

    expect(result.error).toBeUndefined();
    expect(result.report.iterations).toBe(2);
    // route() fired once on iteration 0 (no carriedNextDispatch yet);
    // iteration 1 was driven by first.next → skip route.
    expect(routeCalls).toBe(1);
    const intents = result.report.snapshots.map(s => Object.keys(s.result));
    expect(intents).toEqual([["first"], ["second"]]);
  });

  it("next: () => END terminates the run without further dispatch", async () => {
    const supervisorInstance = supervisor({
      name: "next-end",
      intents: {
        worker: {
          run: async () => ({ done: true }),
          description: "marks done",
          next: () => END,
        },
      },
      route: ctx => (ctx.iteration === 0 ? "worker" : END),
    });

    const result = await supervisorInstance.execute("seed");

    expect(result.error).toBeUndefined();
    expect(result.report.terminatedBy).toBe("route");
    // Only iteration 0 ran; next: END terminated before iter 1.
    expect(result.report.iterations).toBe(1);
  });

  it("fan-out: branches' next directives merge into the next iteration's union", async () => {
    let routeCalls = 0;
    const supervisorInstance = supervisor({
      name: "fanout-next",
      intents: {
        a: {
          run: async () => ({ ranA: true }),
          description: "branch a",
          next: () => "x",
        },
        b: {
          run: async () => ({ ranB: true }),
          description: "branch b",
          next: () => "y",
        },
        x: {
          run: async () => ({ ranX: true }),
          description: "follow-up to a",
          next: () => END,
        },
        y: {
          run: async () => ({ ranY: true }),
          description: "follow-up to b",
          next: () => END,
        },
      },
      route: ctx => {
        routeCalls += 1;
        return ctx.iteration === 0 ? ["a", "b"] : END;
      },
    });

    const result = await supervisorInstance.execute("seed");

    expect(result.error).toBeUndefined();
    // route fired only on iter 0; iter 1 driven by union { x, y };
    // iter 1 ends via next: END (no iter 2).
    expect(routeCalls).toBe(1);
    expect(result.report.iterations).toBe(2);
    const iter1 = result.report.snapshots[1];
    expect(Object.keys(iter1.result).sort()).toEqual(["x", "y"]);
  });

  it("fan-out: any branch returning END terminates the run (END is supreme)", async () => {
    const supervisorInstance = supervisor({
      name: "fanout-end-supreme",
      intents: {
        a: {
          run: async () => ({}),
          description: "wants to continue to x",
          next: () => "x",
        },
        b: {
          run: async () => ({}),
          description: "wants to terminate",
          next: () => END,
        },
        x: {
          run: async () => ({}),
          description: "follow-up — should NOT run",
        },
      },
      route: ctx => (ctx.iteration === 0 ? ["a", "b"] : END),
    });

    const result = await supervisorInstance.execute("seed");

    expect(result.error).toBeUndefined();
    expect(result.report.terminatedBy).toBe("route");
    expect(result.report.iterations).toBe(1);
    // x must not have run.
    expect(Object.keys(result.report.snapshots[0].result).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("fan-out: silent branches abstain — defined branches still drive the union", async () => {
    let routeCalls = 0;
    const supervisorInstance = supervisor({
      name: "fanout-silent-abstain",
      intents: {
        opinionated: {
          run: async () => ({}),
          description: "directs the next iteration",
          next: () => "follow-up",
        },
        silent: {
          run: async () => ({}),
          description: "no opinion on continuation",
          // no `next`
        },
        "follow-up": {
          run: async () => ({}),
          description: "follow-up branch",
          next: () => END,
        },
      },
      route: ctx => {
        routeCalls += 1;
        return ctx.iteration === 0 ? ["opinionated", "silent"] : END;
      },
    });

    const result = await supervisorInstance.execute("seed");

    expect(result.error).toBeUndefined();
    // Silent branch did NOT drag the iteration to the router; the
    // opinionated branch's `next` drove iter 1 directly.
    expect(routeCalls).toBe(1);
    expect(Object.keys(result.report.snapshots[1].result)).toEqual([
      "follow-up",
    ]);
  });

  it("evaluate.reassignTo outranks intent.next (precedence)", async () => {
    // intent.next says "x" → without evaluate, that's where iter 1
    // would dispatch. But evaluate.reassignTo: "y" wins.
    const supervisorInstance = supervisor({
      name: "evaluate-outranks-next",
      router: buildScriptedAgent({
        name: "router",
        description: "routes",
        responses: [
          { content: routerDecision("first"), finishReason: "stop" },
          { content: routerDecision(END), finishReason: "stop" },
        ],
      }),
      intents: {
        first: {
          run: async () => ({ ran: "first" }),
          description: "first step",
          next: () => "x",
        },
        x: {
          run: async () => ({ ran: "x" }),
          description: "what next would have picked",
        },
        y: {
          run: async () => ({ ran: "y" }),
          description: "what evaluate forces",
        },
      },
      evaluate: ctx => {
        if (ctx.iteration === 0) return { reassignTo: "y" };
        return { satisfied: true };
      },
    });

    const result = await supervisorInstance.execute("seed");

    expect(result.error).toBeUndefined();
    // y must have run on iter 1, NOT x.
    expect(Object.keys(result.report.snapshots[1].result)).toEqual(["y"]);
  });
});
