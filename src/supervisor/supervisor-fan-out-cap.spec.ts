import { describe, expect, it } from "vitest";
import type { AgentContract } from "../contracts/agent/agent.contract";
import { END } from "../contracts/end.type";
import type { Next } from "../contracts/supervisor/next.type";
import { SupervisorFailedError, type SupervisorRoutingError } from "../errors";
import { buildScriptedAgent, routerDecision } from "./_test-helpers";
import { supervisor } from "./supervisor";

/**
 * Fan-out WIDTH bound (`maxFanOut`).
 *
 * `maxIterations` bounds how DEEP a run goes; nothing bounded how WIDE
 * a single decision could go. Because the router's per-turn prompt
 * embeds supervisor `state` and prior branch outputs — both able to
 * carry attacker text lifted from tool results — a prompt injection
 * could make the router emit a huge `next` array and launch that many
 * real agent/workflow runs per iteration, without ever naming an
 * intent outside the allowlist.
 *
 * Contract pinned here:
 *  - duplicate intents collapse silently (wasted spend, not an attack),
 *  - a deduped list wider than the cap fails as SUPERVISOR_INVALID_ROUTE,
 *  - the cap applies to every dispatch source, not just the router,
 *  - `maxFanOut` is validated at authoring time.
 */
function makeWorker(name: string): AgentContract {
  return buildScriptedAgent({
    name,
    description: `worker ${name}`,
    responses: Array.from({ length: 4 }, () => ({
      content: `${name}-done`,
      finishReason: "stop" as const,
    })),
  });
}

function makeWorkers(count: number): Record<string, AgentContract> {
  const intents: Record<string, AgentContract> = {};

  for (let index = 0; index < count; index++) {
    intents[`w${index}`] = makeWorker(`w${index}`);
  }

  return intents;
}

describe("supervisor fan-out cap — dedup", () => {
  it("collapses duplicate intents in a route decision to one branch each", async () => {
    let workerCalls = 0;
    const supervisorInstance = supervisor({
      name: "dedup-route",
      intents: {
        worker: {
          run: () => {
            workerCalls++;
            return { done: true };
          },
          description: "worker",
        },
        other: { run: () => ({ other: true }), description: "other" },
      },
      route: ctx =>
        ctx.iteration === 0 ? ["worker", "worker", "other", "worker"] : END,
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error).toBeUndefined();
    expect(workerCalls).toBe(1);
    expect(Object.keys(result.report.snapshots[0].result)).toEqual([
      "worker",
      "other",
    ]);
    // The raw decision is still recorded verbatim for forensics.
    expect(result.report.snapshots[0].decision.next).toEqual([
      "worker",
      "worker",
      "other",
      "worker",
    ]);
    // Deduping does not lose the branches' state contributions.
    expect(result.data).toMatchObject({ done: true, other: true });
  });

  it("dedup alone defuses a repeated-intent flood well past the cap", async () => {
    let workerCalls = 0;
    const flood = Array.from({ length: 200 }, () => "worker");

    const supervisorInstance = supervisor({
      name: "dedup-flood",
      intents: {
        worker: {
          run: () => {
            workerCalls++;
            return { done: true };
          },
          description: "worker",
        },
      },
      route: ctx => (ctx.iteration === 0 ? flood : END),
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error).toBeUndefined();
    expect(workerCalls).toBe(1);
  });
});

describe("supervisor fan-out cap — width limit", () => {
  it("rejects a deduped fan-out wider than the default cap of 10", async () => {
    const intents = makeWorkers(12);

    const supervisorInstance = supervisor({
      name: "default-cap",
      intents,
      route: () => Object.keys(intents),
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error?.code).toBe("SUPERVISOR_INVALID_ROUTE");
    expect(result.error?.message).toMatch(/exceeds maxFanOut=10/);
    expect((result.error as SupervisorRoutingError).returned).toHaveLength(12);
    expect((result.error as SupervisorRoutingError).availableKeys).toHaveLength(
      12,
    );
  });

  it("allows a fan-out exactly at the cap", async () => {
    let dispatched = 0;
    const intents: Record<string, { run: () => unknown; description: string }> =
      {};

    for (let index = 0; index < 10; index++) {
      intents[`w${index}`] = {
        run: () => {
          dispatched++;
          return { [`w${index}`]: true };
        },
        description: `worker ${index}`,
      };
    }

    const supervisorInstance = supervisor({
      name: "at-cap",
      intents,
      route: ctx => (ctx.iteration === 0 ? Object.keys(intents) : END),
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error).toBeUndefined();
    expect(dispatched).toBe(10);
  });

  it("honours a lowered maxFanOut", async () => {
    const intents = makeWorkers(4);

    const supervisorInstance = supervisor({
      name: "lowered-cap",
      intents,
      maxFanOut: 2,
      route: () => ["w0", "w1", "w2"],
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error?.code).toBe("SUPERVISOR_INVALID_ROUTE");
    expect(result.error?.message).toMatch(/fanned out to 3 intents/);
  });

  it("honours a raised maxFanOut for supervisors that legitimately fan wide", async () => {
    let dispatched = 0;
    const intents: Record<string, { run: () => unknown; description: string }> =
      {};

    for (let index = 0; index < 12; index++) {
      intents[`w${index}`] = {
        run: () => {
          dispatched++;
          return { [`w${index}`]: true };
        },
        description: `worker ${index}`,
      };
    }

    const supervisorInstance = supervisor({
      name: "raised-cap",
      intents,
      maxFanOut: 20,
      route: ctx => (ctx.iteration === 0 ? Object.keys(intents) : END),
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error).toBeUndefined();
    expect(dispatched).toBe(12);
  });

  it("caps a router-agent decision — the prompt-injection path", async () => {
    const intents = makeWorkers(12);
    const flood = Object.keys(intents);

    const router = buildScriptedAgent({
      name: "router",
      description: "routes",
      responses: [
        {
          content: routerDecision(flood as unknown as Next, "obeying the prompt"),
          finishReason: "stop",
        },
      ],
      capabilities: { structuredOutput: true },
    });

    const supervisorInstance = supervisor({
      name: "router-cap",
      intents,
      router,
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error?.code).toBe("SUPERVISOR_INVALID_ROUTE");
    expect(result.error?.message).toMatch(/exceeds maxFanOut=10/);
  });

  it("caps an evaluate.reassignTo fan-out — the non-normalize dispatch path", async () => {
    const intents = makeWorkers(12);

    const supervisorInstance = supervisor({
      name: "reassign-cap",
      intents: {
        ...intents,
        seed: { run: () => ({ seeded: true }), description: "seed" },
      },
      maxFanOut: 3,
      route: () => "seed",
      evaluate: ctx =>
        ctx.iteration === 0
          ? { satisfied: false, reassignTo: Object.keys(intents) }
          : { satisfied: true },
    });

    const result = await supervisorInstance.execute("x");

    expect(result.error?.code).toBe("SUPERVISOR_INVALID_ROUTE");
    expect(result.error?.message).toMatch(/exceeds maxFanOut=3/);
  });
});

describe("supervisor fan-out cap — authoring validation", () => {
  it("rejects maxFanOut below 1 at construction", () => {
    expect(() =>
      supervisor({
        name: "bad-cap",
        intents: { worker: makeWorker("worker") },
        route: () => END,
        maxFanOut: 0,
      }),
    ).toThrow(SupervisorFailedError);
  });

  it("rejects a non-integer maxFanOut at construction", () => {
    expect(() =>
      supervisor({
        name: "fractional-cap",
        intents: { worker: makeWorker("worker") },
        route: () => END,
        maxFanOut: 2.5,
      }),
    ).toThrow(/`maxFanOut` must be an integer >= 1/);
  });
});
