import { describe, expect, it } from "vitest";
import type { AgentContract } from "../contracts/agent/agent.contract";
import { END } from "../contracts/end.type";
import type { Next } from "../contracts/supervisor/next.type";
import type { SupervisorRoutingError } from "../errors";
import { buildScriptedAgent, routerDecision } from "./_test-helpers";
import { supervisor } from "./supervisor";

/**
 * Direct-ish exercise of `decide.ts`'s normalization + router-result
 * branches via the public `supervisor.execute()` surface. Every
 * routing fault funnels through `runIterationLoop`'s catch onto
 * `result.error` — these specs pin the precise error code + carried
 * forensic fields (`returned`, `availableKeys`) for each malformed
 * decision shape the normalizer rejects.
 */
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

describe("supervisor decide — route callback normalization faults", () => {
  it("an empty-array decision surfaces SUPERVISOR_INVALID_ROUTE with availableKeys", async () => {
    const worker = makeScripted("worker", "ok", "ok");

    const supervisorInstance = supervisor({
      name: "empty-array-route",
      intents: { worker },
      route: () => [] as unknown as Next,
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error?.code).toBe("SUPERVISOR_INVALID_ROUTE");
    expect(result.error?.message).toMatch(/empty array/);
    expect((result.error as SupervisorRoutingError).availableKeys).toEqual([
      "worker",
    ]);
    expect((result.error as SupervisorRoutingError).returned).toEqual([]);
  });

  it("a non-string element inside a fan-out array surfaces SUPERVISOR_INVALID_ROUTE", async () => {
    const worker = makeScripted("worker", "ok", "ok");

    const supervisorInstance = supervisor({
      name: "non-string-element",
      intents: { worker },
      route: () => ["worker", 42] as unknown as Next,
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error?.code).toBe("SUPERVISOR_INVALID_ROUTE");
    expect(result.error?.message).toMatch(/non-string/);
  });

  it("an unsupported scalar decision (number) surfaces SUPERVISOR_INVALID_ROUTE", async () => {
    const worker = makeScripted("worker", "ok", "ok");

    const supervisorInstance = supervisor({
      name: "unsupported-scalar",
      intents: { worker },
      route: () => 7 as unknown as Next,
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error?.code).toBe("SUPERVISOR_INVALID_ROUTE");
    expect(result.error?.message).toMatch(/unsupported value/);
  });

  it("an unknown key inside an otherwise-valid fan-out array is rejected", async () => {
    const worker = makeScripted("worker", "ok", "ok");

    const supervisorInstance = supervisor({
      name: "fanout-unknown-key",
      intents: { worker },
      route: () => ["worker", "ghost"],
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error?.code).toBe("SUPERVISOR_INVALID_ROUTE");
    expect(result.error?.message).toMatch(/unknown agent key "ghost"/);
  });

  it("a throwing route callback wraps as SUPERVISOR_FAILED preserving the cause", async () => {
    const worker = makeScripted("worker", "ok", "ok");
    const boom = new Error("route exploded");

    const supervisorInstance = supervisor({
      name: "throwing-route",
      intents: { worker },
      route: () => {
        throw boom;
      },
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error?.code).toBe("SUPERVISOR_FAILED");
    expect(result.error?.message).toMatch(/`route` callback threw/);
    expect(result.error?.message).toMatch(/route exploded/);
    expect(result.error?.cause).toBe(boom);
  });

  it("an async route callback's rejection also wraps as SUPERVISOR_FAILED", async () => {
    const worker = makeScripted("worker", "ok", "ok");

    const supervisorInstance = supervisor({
      name: "async-throwing-route",
      intents: { worker },
      route: async () => {
        throw new Error("async route failure");
      },
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error?.code).toBe("SUPERVISOR_FAILED");
    expect(result.error?.message).toMatch(/async route failure/);
  });
});

describe("supervisor decide — router-agent result faults", () => {
  it("a router emitting bare prose fails the framework schema (SCHEMA_VALIDATION_FAILED)", async () => {
    // The router agent is handed the framework's `{ next, reasoning }`
    // schema. A model returning bare prose fails the AGENT's own
    // structured-output validation first — so `routerResult.error` is a
    // SchemaValidationError (an AIError), which `decideViaRouter`
    // re-raises directly. The supervisor's own "no structured `next`"
    // branch is therefore defensive: a validated router result is
    // always an object. This pins the real, reachable behavior.
    const triage = makeScripted("triage", "classifies", "ok");

    const routerAgent = buildScriptedAgent({
      name: "router",
      description: "routes",
      responses: [{ content: "I have no idea what to do", finishReason: "stop" }],
    });

    const supervisorInstance = supervisor({
      name: "router-non-object",
      router: routerAgent as never,
      intents: { triage },
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error?.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(result.report.status).toBe("failed");
  });

  it("a router naming an unknown intent surfaces SUPERVISOR_INVALID_ROUTE", async () => {
    const triage = makeScripted("triage", "classifies", "ok");

    const routerAgent = buildScriptedAgent({
      name: "router",
      description: "routes",
      responses: [{ content: routerDecision("ghost"), finishReason: "stop" }],
    });

    const supervisorInstance = supervisor({
      name: "router-unknown-intent",
      router: routerAgent as never,
      intents: { triage },
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error?.code).toBe("SUPERVISOR_INVALID_ROUTE");
    expect(result.error?.message).toMatch(/unknown agent key "ghost"/);
  });

  it("a router agent whose call errors surfaces the underlying error", async () => {
    // The router agent's model throws — the agent captures it on
    // `routerResult.error`; `decideViaRouter` re-raises it (already an
    // AIError) so it lands on the supervisor result.
    const triage = makeScripted("triage", "classifies", "ok");

    const routerAgent = buildScriptedAgent({
      name: "router",
      description: "routes",
      responses: [
        { content: "", finishReason: "error", error: new Error("router boom") },
      ],
    });

    const supervisorInstance = supervisor({
      name: "router-call-error",
      router: routerAgent as never,
      intents: { triage },
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error).toBeDefined();
    expect(result.report.status).toBe("failed");
  });

  it("a router fan-out (string[]) dispatches every named intent in one iteration", async () => {
    // `normalize()` accepts a string[] from the router exactly like a
    // route callback — exercises the array branch of the router path.
    const market = makeScripted("market", "market analysis", "m");
    const pricing = makeScripted("pricing", "pricing analysis", "p");

    const routerAgent = buildScriptedAgent({
      name: "router",
      description: "routes",
      responses: [
        {
          content: routerDecision(["market", "pricing"]),
          finishReason: "stop",
        },
        { content: routerDecision(END), finishReason: "stop" },
      ],
    });

    const supervisorInstance = supervisor({
      name: "router-fanout",
      router: routerAgent as never,
      intents: { market, pricing },
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error).toBeUndefined();
    expect(Object.keys(result.report.snapshots[0].result).sort()).toEqual([
      "market",
      "pricing",
    ]);
    expect(result.report.snapshots[0].decision.source).toBe("router");
  });

  it("the router's reasoning string lands on the decision snapshot", async () => {
    const triage = makeScripted("triage", "classifies", "ok");

    const routerAgent = buildScriptedAgent({
      name: "router",
      description: "routes",
      responses: [
        {
          content: routerDecision("triage", "ticket looks like a billing issue"),
          finishReason: "stop",
        },
        { content: routerDecision(END), finishReason: "stop" },
      ],
    });

    const supervisorInstance = supervisor({
      name: "router-reasoning",
      router: routerAgent as never,
      intents: { triage },
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error).toBeUndefined();
    expect(result.report.snapshots[0].decision.reasoning).toBe(
      "ticket looks like a billing issue",
    );
  });
});

describe("supervisor decide — initialAgent fast-path", () => {
  it("validates the initialAgent key at dispatch time (decide() guards it too)", async () => {
    // The factory already rejects an unknown initialAgent, so reaching
    // decide()'s own `validateKey` requires a registered key. This pins
    // the happy path: source is "initialAgent", zero routing duration,
    // and route() never fires on turn 0.
    const routeIterations: number[] = [];
    const triage = makeScripted("triage", "classifies", "ok");

    const supervisorInstance = supervisor({
      name: "initial-fastpath",
      intents: { triage },
      initialAgent: "triage",
      route: ctx => {
        routeIterations.push(ctx.iteration);
        return END;
      },
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error).toBeUndefined();
    const decision0 = result.report.snapshots[0].decision;
    expect(decision0.source).toBe("initialAgent");
    expect(decision0.durationMs).toBe(0);
    // route() must NOT have fired on turn 0 — initialAgent bypasses it.
    expect(routeIterations).not.toContain(0);
  });
});
