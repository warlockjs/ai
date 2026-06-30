import { ai } from "../ai";
import { describe, expect, it } from "vitest";
import "./guardrail";

/**
 * The `ai.guardrail` surface — the side-effect import above must register the
 * callable factory with the detector factories attached as methods, all under
 * the one `ai.guardrail` name.
 */
describe("ai.guardrail registration", () => {
  it("registers ai.guardrail as a callable factory", () => {
    expect(typeof ai.guardrail).toBe("function");
  });

  it("attaches the built-in detector factories as methods", () => {
    expect(typeof ai.guardrail.pii).toBe("function");
    expect(typeof ai.guardrail.topic).toBe("function");
    expect(typeof ai.guardrail.injection).toBe("function");
    expect(typeof ai.guardrail.moderation).toBe("function");
  });

  it("builds a middleware via the callable and detectors via the methods", () => {
    const detector = ai.guardrail.pii({ onMatch: "block" });
    expect(detector.name).toBe("pii");

    const mw = ai.guardrail({ output: [detector] });
    expect(mw.name).toBe("guardrail");
    expect(mw.trip?.after).toBeTypeOf("function");
  });
});
