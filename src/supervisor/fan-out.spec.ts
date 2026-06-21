import { describe, expect, it } from "vitest";
import { END } from "../contracts/end.type";
import type { IntentEntry } from "../contracts/supervisor/intent-entry.type";
import type { Next } from "../contracts/supervisor/next.type";
import { buildScriptedAgent } from "./_test-helpers";
import { fanOut } from "./fan-out";
import { supervisor } from "./supervisor";

/**
 * Unit coverage for `ai.fanOut()` — spreading one unit into `n`
 * distinctly-keyed intent entries for voting / self-consistency.
 * Asserts key generation, description inheritance, guard rails, and
 * end-to-end parallel dispatch under a deterministic-route supervisor.
 */
function makeWriter(name = "writer") {
  return buildScriptedAgent({
    name,
    description: "Drafts an answer",
    responses: [{ content: "draft", finishReason: "stop" }],
  });
}

describe("ai.fanOut — key generation", () => {
  it("produces `<name>1..<name>n` keys from the unit name", () => {
    const writer = makeWriter();

    const entries = fanOut(writer, 3);

    expect(Object.keys(entries)).toEqual(["writer1", "writer2", "writer3"]);
  });

  it("uses an explicit keyPrefix when supplied", () => {
    const writer = makeWriter();

    const entries = fanOut(writer, 2, { keyPrefix: "sample" });

    expect(Object.keys(entries)).toEqual(["sample1", "sample2"]);
  });

  it("references the same underlying unit on every entry", () => {
    const writer = makeWriter();

    const entries = fanOut(writer, 2);

    expect(entries.writer1.agent).toBe(writer);
    expect(entries.writer2.agent).toBe(writer);
  });
});

describe("ai.fanOut — description handling", () => {
  it("inherits the unit description by default", () => {
    const writer = makeWriter();

    const entries = fanOut(writer, 2);

    expect(entries.writer1.description).toBe("Drafts an answer");
  });

  it("applies an explicit description override to every entry", () => {
    const writer = makeWriter();

    const entries = fanOut(writer, 2, { description: "Independent sample" });

    expect(entries.writer1.description).toBe("Independent sample");
    expect(entries.writer2.description).toBe("Independent sample");
  });

  it("omits description when the unit has none and none is supplied", () => {
    const anonymous = buildScriptedAgent({ name: "draft", responses: [] });

    const entries = fanOut(anonymous, 2);
    const entry: IntentEntry = entries.draft1;

    expect(entry.description).toBeUndefined();
  });
});

describe("ai.fanOut — guards", () => {
  it("throws when the first argument is not dispatchable", () => {
    expect(() => fanOut({} as never, 2)).toThrow(/must be an agent or workflow/);
  });

  it("throws when count is below 1", () => {
    const writer = makeWriter();

    expect(() => fanOut(writer, 0)).toThrow(/integer >= 1/);
  });

  it("throws when count is not an integer", () => {
    const writer = makeWriter();

    expect(() => fanOut(writer, 2.5)).toThrow(/integer >= 1/);
  });

  it("throws when the unit has no name and no keyPrefix is supplied", () => {
    const unit = { execute: () => undefined } as never;

    expect(() => fanOut(unit, 2)).toThrow(/no usable `name`/);
  });
});

describe("ai.fanOut — composes into a supervisor", () => {
  it("dispatches every sample in parallel under a route callback", async () => {
    const writer = makeWriter();

    const supervisorInstance = supervisor({
      name: "self-consistency",
      intents: {
        ...fanOut(writer, 3),
      },
      route: (ctx): Next => (ctx.iteration === 0 ? ["writer1", "writer2", "writer3"] : END),
      maxIterations: 2,
    });

    const result = await supervisorInstance.execute("question");

    expect(result.error).toBeUndefined();
    expect(Object.keys(result.report.snapshots[0].result).sort()).toEqual([
      "writer1",
      "writer2",
      "writer3",
    ]);
  });
});
