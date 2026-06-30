import { ai } from "../ai";
import { describe, expect, it } from "vitest";
// Side-effect import through the PUBLIC barrel — the documented
// `import "@warlock.js/ai"` usage. Proves the root entry wires the
// full `ai.guardrail` surface (factory + detector methods), not just the
// internal `./guardrail` module that `guardrail.spec.ts` imports directly.
import "./index";

/**
 * Registration smoke test for the public package entry. The `declare module`
 * augmentation in `./guardrail` types `ai.guardrail`, and the runtime
 * `Object.assign(guard, { pii, topic, injection, moderation })` attaches the
 * detector factories — all under the single `ai.guardrail` name.
 */
describe("@warlock.js/ai public registration", () => {
  it("registers ai.guardrail as a callable factory via the barrel side effect", () => {
    expect(typeof ai.guardrail).toBe("function");
  });

  it("attaches every built-in detector factory as a method on ai.guardrail", () => {
    expect(typeof ai.guardrail.pii).toBe("function");
    expect(typeof ai.guardrail.topic).toBe("function");
    expect(typeof ai.guardrail.injection).toBe("function");
    expect(typeof ai.guardrail.moderation).toBe("function");
  });

  it("the callable produces an AgentMiddleware and the methods produce detectors", () => {
    const detector = ai.guardrail.injection();
    expect(typeof detector.check).toBe("function");

    const middleware = ai.guardrail({ input: [detector] });
    expect(middleware.name).toBe("guardrail");
    expect(middleware.trip?.before).toBeTypeOf("function");
  });
});
