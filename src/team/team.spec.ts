import { describe, expect, it, vi } from "vitest";
import { END } from "../contracts/end.type";
import type { IntentRunEntry } from "../contracts/supervisor/intent-entry.type";
import type { TeamMemberValue } from "../contracts/team/team-config.type";
import { SupervisorFailedError } from "../errors";
import { mockRouter } from "../mock/mock-router";
import { memory as snapshotMemory } from "../snapshot/memory";
import { buildScriptedAgent, routerDecision, schema } from "../supervisor/_test-helpers";
import { team } from "./team";

/**
 * Wrap a callback `IntentRunEntry` as a team member. Members are typed
 * as `AgentContract | WorkflowInstance`, but `team()` forwards them
 * verbatim as supervisor `intents` — which accept callback entries at
 * runtime. The cast keeps the specs deterministic (no LLM) while
 * exercising the real strip-merge-into-state path the gates read.
 */
function member(entry: IntentRunEntry): TeamMemberValue {
  return entry as unknown as TeamMemberValue;
}

/** A member that writes a fixed state slice via its `output` schema. */
function writes<T extends Record<string, unknown>>(
  description: string,
  slice: T,
): TeamMemberValue {
  return member({
    run: async () => slice,
    description,
    output: schema<T>((value) => ({ value: value as T })),
  });
}

describe("ai.team — desugaring to a real supervisor", () => {
  it("returns an object satisfying SupervisorContract", () => {
    const built = team({
      name: "shape-team",
      manager: { route: mockRouter([END]) },
      members: { fixer: writes("fixer", {}) },
      gate: () => ({ satisfied: true }),
    });

    expect(built.name).toBe("shape-team");
    expect(typeof built.execute).toBe("function");
    expect(typeof built.stream).toBe("function");
    expect(typeof built.resume).toBe("function");
    expect(typeof built.asTool).toBe("function");
    expect(typeof built.on).toBe("function");
    expect(typeof built.off).toBe("function");
  });

  it("forwards `manager: { route }` as the supervisor route path", async () => {
    const route = vi.fn(mockRouter(["builder", END]));

    const built = team({
      name: "route-team",
      manager: { route },
      members: { builder: writes("builder", { code: "x" }), fixer: writes("fixer", {}) },
      gate: () => ({ satisfied: true }),
    });

    const result = await built.execute("go");

    expect(result.error).toBeUndefined();
    expect(route).toHaveBeenCalled();
    expect(result.report.terminatedBy).toBe("evaluate");
  });

  it('stamps type "team" on the report + result so team runs are distinguishable from a plain supervisor', async () => {
    const built = team({
      name: "typed-team",
      manager: { route: mockRouter([END]) },
      members: { fixer: writes("fixer", {}) },
      gate: () => ({ satisfied: true }),
    });

    const result = await built.execute("go");

    expect(result.error).toBeUndefined();
    expect(result.type).toBe("team");
    expect(result.report.type).toBe("team");
  });

  it("forwards a bare agent `manager` as the supervisor router path", async () => {
    const router = buildScriptedAgent({
      name: "lead",
      description: "lead",
      responses: [
        { content: routerDecision("builder"), finishReason: "stop" },
        { content: routerDecision(END), finishReason: "stop" },
      ],
    });

    const built = team({
      name: "router-team",
      manager: router,
      members: {
        builder: member({ run: async () => ({}), description: "builds" }),
        fixer: member({ run: async () => ({}), description: "fixes" }),
      },
      gate: () => undefined,
    });

    const result = await built.execute("build it");

    expect(result.error).toBeUndefined();
    const dispatched = result.report.snapshots.flatMap((snapshot) =>
      Object.keys(snapshot.result),
    );
    expect(dispatched).toContain("builder");
  });

  it("forwards `members` verbatim as `intents` (escape hatch reachable)", async () => {
    let escapeHatchHit = false;

    const built = team({
      name: "intents-team",
      manager: {
        route: mockRouter(["caller", END]),
      },
      members: {
        caller: member({
          run: async (ctx) => {
            await ctx.intents.helper.execute();
            return {};
          },
          description: "calls helper via the escape hatch",
        }),
        helper: member({
          run: async () => {
            escapeHatchHit = true;
            return {};
          },
          description: "helper",
        }),
        fixer: writes("fixer", {}),
      },
      gate: () => ({ satisfied: true }),
    });

    await built.execute("go");

    expect(escapeHatchHit).toBe(true);
  });
});

describe("ai.team — quality gate", () => {
  it("terminates when state.approved is truthy", async () => {
    const built = team({
      name: "quality-pass",
      manager: { route: mockRouter(["reviewer"], { onExhausted: "repeat" }) },
      members: {
        reviewer: writes("reviewer", { approved: true, notes: "" }),
        fixer: writes("fixer", {}),
      },
      gate: "quality",
    });

    const result = await built.execute("review please");

    expect(result.error).toBeUndefined();
    expect(result.report.terminatedBy).toBe("evaluate");
  });

  it("reassigns to fixer with feedback when state.approved is falsy", async () => {
    let fixerRan = false;

    const built = team({
      name: "quality-fix",
      // iter 0 routes to the reviewer; the gate then reassigns to the
      // fixer (proving the falsy-approved branch), and the fixer writes
      // `approved: true` so the gate terminates next pass.
      manager: { route: mockRouter(["reviewer"], { onExhausted: "repeat" }) },
      members: {
        reviewer: writes("reviewer", { approved: false, notes: "tighten the types" }),
        fixer: member({
          run: async () => {
            fixerRan = true;
            return { approved: true };
          },
          description: "fixer",
          output: schema<{ approved: boolean }>((v) => ({
            value: v as { approved: boolean },
          })),
        }),
      },
      gate: "quality",
      maxIterations: 6,
    });

    const result = await built.execute("review please");

    expect(result.error).toBeUndefined();
    expect(fixerRan).toBe(true);
    expect(result.report.terminatedBy).toBe("evaluate");
  });
});

describe("ai.team — verify gate", () => {
  it("terminates when state.passed is truthy", async () => {
    const built = team({
      name: "verify-pass",
      manager: { route: mockRouter(["tester"], { onExhausted: "repeat" }) },
      members: {
        tester: writes("tester", { passed: true }),
        fixer: writes("fixer", {}),
      },
      gate: "verify",
    });

    const result = await built.execute("test it");

    expect(result.error).toBeUndefined();
    expect(result.report.terminatedBy).toBe("evaluate");
  });

  it("reassigns to fixer when state.passed is falsy", async () => {
    let fixerRan = false;

    const built = team({
      name: "verify-fix",
      manager: { route: mockRouter(["tester"], { onExhausted: "repeat" }) },
      members: {
        tester: writes("tester", { passed: false }),
        fixer: member({
          run: async () => {
            fixerRan = true;
            return { passed: true };
          },
          description: "fixer",
          output: schema<{ passed: boolean }>((v) => ({
            value: v as { passed: boolean },
          })),
        }),
      },
      gate: "verify",
      maxIterations: 6,
    });

    const result = await built.execute("test it");

    expect(result.error).toBeUndefined();
    expect(fixerRan).toBe(true);
    expect(result.report.terminatedBy).toBe("evaluate");
  });
});

describe("ai.team — custom gate function", () => {
  it("forwards a `gate` function straight to evaluate untouched", async () => {
    const gate = vi.fn(() => ({ satisfied: true }) as const);

    const built = team({
      name: "fn-gate",
      manager: { route: mockRouter(["worker"], { onExhausted: "repeat" }) },
      members: { worker: writes("worker", {}) },
      gate,
    });

    const result = await built.execute("go");

    expect(result.error).toBeUndefined();
    expect(gate).toHaveBeenCalled();
    expect(result.report.terminatedBy).toBe("evaluate");
  });
});

describe("ai.team — role + gateKey overrides", () => {
  it("remaps reviewer and fixer via `roles`", async () => {
    const built = team({
      name: "roles-remap",
      manager: { route: mockRouter(["critic"], { onExhausted: "repeat" }) },
      members: {
        critic: writes("critic", { approved: true, notes: "" }),
        repair: writes("repair", {}),
      },
      gate: "quality",
      roles: { reviewer: "critic", fixer: "repair" },
    });

    const result = await built.execute("go");

    expect(result.error).toBeUndefined();
    expect(result.report.terminatedBy).toBe("evaluate");
  });

  it("reads a custom `gateKey`", async () => {
    const built = team({
      name: "custom-key",
      manager: { route: mockRouter(["tester"], { onExhausted: "repeat" }) },
      members: {
        tester: writes("tester", { green: true }),
        fixer: writes("fixer", {}),
      },
      gate: "verify",
      gateKey: "green",
    });

    const result = await built.execute("go");

    expect(result.error).toBeUndefined();
    expect(result.report.terminatedBy).toBe("evaluate");
  });
});

describe("ai.team — construction-time validation", () => {
  it("throws an authoring error when the fixer member is missing", () => {
    expect(() =>
      team({
        name: "no-fixer",
        manager: { route: mockRouter([END]) },
        members: { reviewer: writes("reviewer", {}) },
        gate: "quality",
      }),
    ).toThrow(SupervisorFailedError);
  });

  it("throws an authoring error when the reviewer member is missing (quality)", () => {
    let thrown: unknown;

    try {
      team({
        name: "no-reviewer",
        manager: { route: mockRouter([END]) },
        members: { fixer: writes("fixer", {}) },
        gate: "quality",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SupervisorFailedError);
    expect((thrown as SupervisorFailedError).context).toMatchObject({
      authoring: true,
    });
  });

  it("does not require a reviewer for the verify gate", () => {
    expect(() =>
      team({
        name: "verify-no-reviewer",
        manager: { route: mockRouter([END]) },
        members: { tester: writes("tester", {}), fixer: writes("fixer", {}) },
        gate: "verify",
      }),
    ).not.toThrow();
  });
});

describe("ai.team — pass-throughs", () => {
  it("forwards goal, output, state, maxIterations, and on to the supervisor", async () => {
    const onRouterDecided = vi.fn();

    const built = team<{ done: boolean }, { done: boolean }>({
      name: "passthrough",
      goal: "Finish the job.",
      manager: { route: mockRouter(["worker"], { onExhausted: "repeat" }) },
      members: {
        worker: member({
          run: async () => ({ done: true }),
          description: "worker",
          output: schema<{ done: boolean }>((v) => ({
            value: v as { done: boolean },
          })),
        }),
        fixer: writes("fixer", {}),
      },
      gate: (ctx) => (ctx.state.done ? { satisfied: true } : undefined),
      output: schema<{ done: boolean }>((v) => {
        const record = v as { done?: unknown };
        return typeof record.done === "boolean"
          ? { value: { done: record.done } }
          : { issues: [{ message: "done required" }] };
      }),
      state: { done: false },
      maxIterations: 3,
      on: { "supervisor.router.decided": onRouterDecided },
    });

    const result = await built.execute("go");

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ done: true });
    expect(onRouterDecided).toHaveBeenCalled();
  });

  it("round-trips through a memory snapshot store on resume", async () => {
    const store = snapshotMemory();
    const runId = "team-resume-1";

    const built = team({
      name: "resume-team",
      manager: { route: mockRouter(["reviewer"], { onExhausted: "repeat" }) },
      members: {
        reviewer: writes("reviewer", { approved: true, notes: "" }),
        fixer: writes("fixer", {}),
      },
      gate: "quality",
      snapshotStore: store,
    });

    const first = await built.execute("go", { runId });
    expect(first.error).toBeUndefined();

    const resumed = await built.resume(runId);
    expect(resumed.error).toBeUndefined();
    expect(resumed.report.status).toBe("completed");
  });
});

describe("ai.team — end-to-end review/fix loop", () => {
  it("loops builder → gate-reassigns fixer → fixer approves → satisfied", async () => {
    const visited: string[] = [];

    const built = team({
      name: "code-team",
      // iter 0 builds; `state.approved` is unset so the quality gate
      // reassigns to the fixer (proving the reassignTo path), and the
      // fixer writes approved=true so the gate is satisfied next pass.
      manager: {
        route: mockRouter(["builder"], { onExhausted: "repeat" }),
      },
      members: {
        builder: member({
          run: async () => {
            visited.push("builder");
            return { code: "v1" };
          },
          description: "builder",
          output: schema<{ code: string }>((v) => ({
            value: v as { code: string },
          })),
        }),
        reviewer: member({
          run: async () => {
            visited.push("reviewer");
            return { approved: false, notes: "needs work" };
          },
          description: "reviewer",
          output: schema<{ approved: boolean; notes: string }>((v) => ({
            value: v as { approved: boolean; notes: string },
          })),
        }),
        fixer: member({
          run: async () => {
            visited.push("fixer");
            return { code: "v2", approved: true };
          },
          description: "fixer",
          output: schema<{ code: string; approved: boolean }>((v) => ({
            value: v as { code: string; approved: boolean },
          })),
        }),
      },
      gate: "quality",
      maxIterations: 8,
    });

    const result = await built.execute("Build a debounce util.");

    expect(result.error).toBeUndefined();
    expect(result.report.terminatedBy).toBe("evaluate");
    expect(visited).toEqual(["builder", "fixer"]);
  });
});
