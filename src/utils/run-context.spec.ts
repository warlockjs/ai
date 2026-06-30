import { describe, expect, it } from "vitest";
import type { BaseReport } from "../contracts/result/base-report.type";
import {
  captureChildReport,
  currentRunFrame,
  withoutRunFrame,
  withRunFrame,
} from "./run-context";

/**
 * Unit coverage for the ambient run-frame primitive that powers
 * auto-nesting of agents invoked directly inside an orchestration
 * intent callback. The orchestration integration is proven end-to-end
 * in `supervisor/auto-nest-callback-agents.spec.ts`; this file pins the
 * frame mechanics (install / read / capture / suppress / nest) in
 * isolation.
 */

function makeReport(runId: string): BaseReport {
  return {
    runId,
    rootRunId: runId,
    name: runId,
    type: "agent",
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:00.001Z",
    duration: 1,
    usage: { input: 1, output: 1, total: 2 },
    children: [],
  };
}

describe("run-context ambient frame", () => {
  it("has no frame outside any withRunFrame scope", () => {
    expect(currentRunFrame()).toBeUndefined();
    expect(captureChildReport(makeReport("a"))).toBe(false);
  });

  it("exposes the installed frame inside withRunFrame and tears it down after", () => {
    const sink: BaseReport[] = [];

    withRunFrame({ sink, rootRunId: "root", parentRunId: "parent" }, () => {
      const frame = currentRunFrame();
      expect(frame).toBeDefined();
      expect(frame!.rootRunId).toBe("root");
      expect(frame!.parentRunId).toBe("parent");
    });

    expect(currentRunFrame()).toBeUndefined();
  });

  it("captureChildReport pushes the report and relinks its lineage to the frame", () => {
    const sink: BaseReport[] = [];
    const report = makeReport("child");

    const captured = withRunFrame(
      { sink, rootRunId: "root", parentRunId: "parent", sessionId: "sess" },
      () => captureChildReport(report),
    );

    expect(captured).toBe(true);
    expect(sink).toHaveLength(1);
    expect(sink[0]).toBe(report);
    expect(report.rootRunId).toBe("root");
    expect(report.parentRunId).toBe("parent");
    expect(report.sessionId).toBe("sess");
  });

  it("withoutRunFrame suppresses an enclosing frame so a nested capture is a no-op", () => {
    const sink: BaseReport[] = [];

    withRunFrame({ sink, rootRunId: "root", parentRunId: "parent" }, () => {
      const captured = withoutRunFrame(() => {
        // Inside the suppression scope the ambient frame is gone.
        expect(currentRunFrame()).toBeUndefined();

        return captureChildReport(makeReport("inner"));
      });
      expect(captured).toBe(false);

      // Outer frame is restored after the suppression scope returns.
      expect(currentRunFrame()?.rootRunId).toBe("root");
    });

    // The suppression frame restores the outer frame after it returns —
    // the outer sink was never written to by the suppressed capture.
    expect(sink).toHaveLength(0);
  });

  it("survives async boundaries — a capture several awaits deep still finds the frame", async () => {
    const sink: BaseReport[] = [];

    await withRunFrame(
      { sink, rootRunId: "root", parentRunId: "parent" },
      async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        captureChildReport(makeReport("deep"));
      },
    );

    expect(sink).toHaveLength(1);
    expect(sink[0].name).toBe("deep");
  });

  it("nests frames — an inner frame shadows the outer for its own subtree only", () => {
    const outerSink: BaseReport[] = [];
    const innerSink: BaseReport[] = [];

    withRunFrame({ sink: outerSink, rootRunId: "outer", parentRunId: "o" }, () => {
      withRunFrame({ sink: innerSink, rootRunId: "inner", parentRunId: "i" }, () => {
        captureChildReport(makeReport("grandchild"));
      });

      // Back in the outer frame after the inner scope returns.
      captureChildReport(makeReport("child"));
    });

    expect(innerSink.map((r) => r.name)).toEqual(["grandchild"]);
    expect(outerSink.map((r) => r.name)).toEqual(["child"]);
  });
});
