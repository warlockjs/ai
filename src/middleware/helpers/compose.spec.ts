import { describe, expect, it } from "vitest";
import type { AgentMiddleware } from "../../contracts/middleware";
import { composeMiddleware } from "./compose";

const mw = (name: string): AgentMiddleware => ({ name });

describe("composeMiddleware", () => {
  it("flattens arrays and single entries into one ordered array", () => {
    const a = mw("a");
    const b = mw("b");
    const c = mw("c");
    const d = mw("d");

    const out = composeMiddleware([a, b], c, [d]);

    expect(out.map(entry => entry.name)).toEqual(["a", "b", "c", "d"]);
  });

  it("preserves registration order across sources (no sorting, no dedup)", () => {
    const duplicate = mw("dup");

    const out = composeMiddleware([duplicate], duplicate);

    expect(out).toHaveLength(2);
    expect(out[0]).toBe(duplicate);
    expect(out[1]).toBe(duplicate);
  });

  it("handles empty sources cleanly", () => {
    const out = composeMiddleware([], [mw("x")], []);

    expect(out.map(entry => entry.name)).toEqual(["x"]);
  });
});
