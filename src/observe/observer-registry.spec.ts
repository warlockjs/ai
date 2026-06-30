import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionReport } from "../contracts/result/execution-report.type";
import {
  clearObservers,
  getObservers,
  isObserveAll,
  registerObserver,
  setObserveAll,
} from "./observer-registry";
import type { Observer } from "./observer.contract";
import { resolveObservers } from "./resolve-observers";

/**
 * Minimal fake report — `Observer.collect` only carries it through, so a
 * structural stub typed as `ExecutionReport` is enough for these tests.
 */
function fakeReport(runId: string): ExecutionReport {
  return {
    runId,
    rootRunId: runId,
    name: "fake",
    type: "agent",
    status: "completed",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    duration: 0,
    usage: { input: 0, output: 0, total: 0 },
    children: [],
  };
}

/** A fake observer that records every report handed to it. */
function makeFakeObserver(): Observer & { collected: ExecutionReport[] } {
  const collected: ExecutionReport[] = [];

  return {
    collected,
    collect(report) {
      collected.push(report);
    },
  };
}

describe("observer-registry", () => {
  afterEach(() => {
    // Reset module-level state so registrations don't leak between specs.
    clearObservers();
  });

  it("registers an observer and reads it back via getObservers", () => {
    const observer = makeFakeObserver();

    expect(getObservers()).toHaveLength(0);

    registerObserver(observer);

    expect(getObservers()).toHaveLength(1);
    expect(getObservers()[0]).toBe(observer);
  });

  it("preserves registration order across multiple observers", () => {
    const a = makeFakeObserver();
    const b = makeFakeObserver();

    registerObserver(a);
    registerObserver(b);

    expect([...getObservers()]).toEqual([a, b]);
  });

  it("defaults observeAll to false and toggles it", () => {
    expect(isObserveAll()).toBe(false);

    setObserveAll(true);
    expect(isObserveAll()).toBe(true);

    setObserveAll(false);
    expect(isObserveAll()).toBe(false);
  });

  it("clearObservers resets both the list and the observeAll flag", () => {
    registerObserver(makeFakeObserver());
    setObserveAll(true);

    clearObservers();

    expect(getObservers()).toHaveLength(0);
    expect(isObserveAll()).toBe(false);
  });

  describe("resolveObservers", () => {
    it("returns [] for observe:false (opt out)", () => {
      registerObserver(makeFakeObserver());
      setObserveAll(true);

      expect(resolveObservers(false)).toEqual([]);
    });

    it("returns the registered observers for observe:true", () => {
      const observer = makeFakeObserver();
      registerObserver(observer);

      const resolved = resolveObservers(true);

      expect([...resolved]).toEqual([observer]);
    });

    it("returns only the given observer for an Observer object (flow-local)", () => {
      const global = makeFakeObserver();
      const local = makeFakeObserver();
      registerObserver(global);

      const resolved = resolveObservers(local);

      expect([...resolved]).toEqual([local]);
    });

    it("undefined follows observeAll: [] when off, registered when on", () => {
      const observer = makeFakeObserver();
      registerObserver(observer);

      expect(resolveObservers(undefined)).toEqual([]);

      setObserveAll(true);

      expect([...resolveObservers(undefined)]).toEqual([observer]);
    });

    it("routes a report to a flow-local observer via collect", async () => {
      const local = makeFakeObserver();
      const report = fakeReport("run_1");

      for (const observer of resolveObservers(local)) {
        await observer.collect(report);
      }

      expect(local.collected).toEqual([report]);
    });
  });
});
