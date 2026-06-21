import { describe, expect, it } from "vitest";
import { END } from "../contracts/end.type";
import type { SupervisorSnapshot } from "../contracts/supervisor/supervisor-snapshot.type";
import { memory as snapshotMemory } from "../snapshot/memory";
import { buildScriptedAgent } from "./_test-helpers";
import { supervisor } from "./supervisor";

function makeStore() {
  return snapshotMemory();
}

function makeScripted(name: string, description: string, content: string) {
  return buildScriptedAgent({
    name,
    description,
    responses: [{ content, finishReason: "stop" }],
  });
}

describe("supervisor — persistence + resume", () => {
  it("writes a snapshot after every iteration", async () => {
    const store = makeStore();
    const worker = makeScripted("worker", "does work", "ok");

    const supervisorInstance = supervisor({
      name: "persistor",
      intents: { worker },
      route: ctx => (ctx.iteration >= 2 ? END : "worker"),
      snapshotStore: store,
    });

    const result = await supervisorInstance.execute("topic", {
      runId: "run-A",
    });

    expect(result.error).toBeUndefined();

    const snapshot = await store.load("run-A");

    expect(snapshot).toBeDefined();
    expect(snapshot!.runId).toBe("run-A");
    expect(snapshot!.status).toBe("completed");
    expect(snapshot!.snapshots.length).toBe(3);
  });

  it("resume rehydrates the history and continues from the next iteration", async () => {
    const store = makeStore();

    // Seed a snapshot as if a prior run had completed one iteration.
    const seed: SupervisorSnapshot = {
      runId: "resumable",
      supervisorName: "resumer",
      signature: "sig-placeholder",
      input: "original-input",
      iteration: 0,
      snapshots: [
        Object.freeze({
          iteration: 0,
          result: {
            worker: Object.freeze({
              intent: "worker",
              input: "original-input",
              output: "prior",
              usage: { input: 0, output: 0, total: 0 },
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              duration: 1,
            }),
          },
          decision: {
            source: "route" as const,
            next: "worker",
            durationMs: 0,
          },
          state: {},
          artifacts: {},
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          duration: 1,
          usage: { input: 0, output: 0, total: 0 },
        }),
      ],
      status: "running",
      startedAt: new Date().toISOString(),
      savedAt: new Date().toISOString(),
    };

    const worker = makeScripted("worker", "ok", "after-resume");

    const supervisorInstance = supervisor({
      name: "resumer",
      intents: { worker },
      route: ctx => (ctx.iteration >= 2 ? END : "worker"),
      snapshotStore: store,
    });

    // Fix the seed signature to match the real one so drift doesn't fire.
    seed.signature = supervisorInstance.signature;
    await store.save(seed);

    const resumed = await supervisorInstance.resume("resumable");

    expect(resumed.error).toBeUndefined();
    // Should include the seed snapshot plus new iterations.
    expect(resumed.report.snapshots[0].result.worker.output).toBe("prior");
    expect(resumed.report.snapshots.length).toBeGreaterThanOrEqual(2);
  });

  it("throws SupervisorDriftError when signatures diverge", async () => {
    const store = makeStore();
    const worker = makeScripted("worker", "ok", "ok");

    const supervisorInstance = supervisor({
      name: "drift",
      intents: { worker },
      route: () => END,
      snapshotStore: store,
    });

    await store.save({
      runId: "run-X",
      supervisorName: "drift",
      signature: "totally-different",
      input: "x",
      iteration: 0,
      snapshots: [],
      status: "running",
      startedAt: new Date().toISOString(),
      savedAt: new Date().toISOString(),
    });

    await expect(supervisorInstance.resume("run-X")).rejects.toMatchObject({
      code: "SUPERVISOR_DRIFT",
    });
  });

  it("force: true bypasses the drift check", async () => {
    const store = makeStore();
    const worker = makeScripted("worker", "ok", "ok");

    const supervisorInstance = supervisor({
      name: "drift-force",
      intents: { worker },
      route: () => END,
      snapshotStore: store,
    });

    await store.save({
      runId: "run-F",
      supervisorName: "drift-force",
      signature: "mismatched",
      input: "x",
      iteration: -1,
      snapshots: [],
      status: "running",
      startedAt: new Date().toISOString(),
      savedAt: new Date().toISOString(),
    });

    const result = await supervisorInstance.resume("run-F", { force: true });

    // With force, drift does not throw — run proceeds and terminates.
    expect(result.report.status).toBe("completed");
  });

  it("resume without store throws SupervisorFailedError", async () => {
    const worker = makeScripted("worker", "ok", "ok");

    const supervisorInstance = supervisor({
      name: "no-store",
      intents: { worker },
      route: () => END,
    });

    await expect(supervisorInstance.resume("anything")).rejects.toMatchObject({
      code: "SUPERVISOR_FAILED",
    });
  });
});
