import { describe, expect, it } from "vitest";
import { parsedStepCeiling, planSchema } from "./plan-schema";

/** Pull the JSON Schema form the planning agent's structured-output path consumes. */
function jsonSchemaOf(schema: ReturnType<typeof planSchema>): Record<string, unknown> {
  return schema["~standard"].jsonSchema.input();
}

describe("planSchema", () => {
  it("emits a strict-mode-compatible schema (every property required, no item bounds)", () => {
    // Guards the OpenAI strict-mode contract: every object must list ALL
    // its properties in `required` (optionals expressed as nullable), and
    // no array may carry minItems/maxItems — both 400 under strict
    // `json_schema`. Regression guard for the planner's plan schema.
    const assertStrict = (node: Record<string, unknown>): void => {
      expect(node.minItems).toBeUndefined();
      expect(node.maxItems).toBeUndefined();

      if (node.type === "object" && node.properties) {
        const props = node.properties as Record<string, Record<string, unknown>>;
        const keys = Object.keys(props);
        const required = (node.required as string[]) ?? [];

        expect(required).toEqual(expect.arrayContaining(keys));
        expect(required).toHaveLength(keys.length);

        for (const key of keys) {
          assertStrict(props[key]);
        }
      }

      if (node.items) {
        assertStrict(node.items as Record<string, unknown>);
      }
    };

    assertStrict(jsonSchemaOf(planSchema(["a", "b"], 3)));
  });

  it("never emits steps.maxItems (strict-incompatible; maxSteps is enforced at runtime)", () => {
    const steps = (json: Record<string, unknown>) =>
      (json.properties as { steps: Record<string, unknown> }).steps;

    expect(steps(jsonSchemaOf(planSchema(["a", "b"], 3))).maxItems).toBeUndefined();
    expect(steps(jsonSchemaOf(planSchema(["a", "b"]))).maxItems).toBeUndefined();
  });

  it("still validates a well-formed plan after the refactor", async () => {
    const schema = planSchema(["search"], 2);
    // Standard Schema permits an async `validate`; awaiting is the
    // contract-correct way to reach the result either way.
    const result = await schema["~standard"].validate({
      steps: [{ capability: "search", input: "go" }],
      summary: "do the thing",
    });

    expect("issues" in result).toBe(false);
    if (!("issues" in result)) {
      expect(result.value.steps).toHaveLength(1);
      expect(result.value.summary).toBe("do the thing");
    }
  });

  it("rejects an empty steps array", () => {
    const schema = planSchema(["search"]);
    const result = schema["~standard"].validate({ steps: [] });

    expect("issues" in result).toBe(true);
  });
});

/**
 * Parse-time step ceiling (4.15.0 security hardening). Strict-mode JSON
 * Schema can't carry `maxItems`, so nothing on the wire stopped a
 * provider from returning an arbitrarily long `steps[]`; the runtime
 * loop's tail truncation only runs AFTER the whole array has been
 * normalized and stored. The bound now holds at parse time, and rejects
 * rather than silently trimming — an over-long plan is a malfunction
 * worth surfacing, not a prefix worth executing.
 */
describe("planSchema — parsed step ceiling (security)", () => {
  const stepsOf = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      capability: "search",
      input: `step ${index}`,
    }));

  it("exposes a ceiling of maxSteps * 4, and 100 when maxSteps is absent", () => {
    expect(parsedStepCeiling(3)).toBe(12);
    expect(parsedStepCeiling(10)).toBe(40);
    expect(parsedStepCeiling()).toBe(100);
  });

  it("rejects a plan longer than the ceiling instead of truncating it", async () => {
    const schema = planSchema(["search"], 3);
    const result = await schema["~standard"].validate({ steps: stepsOf(13) });

    expect("issues" in result).toBe(true);
    if ("issues" in result && result.issues) {
      expect(result.issues[0].message).toMatch(
        /`steps` must not exceed 12 entries \(received 13\)/,
      );
    }
  });

  it("rejects a pathological plan built without a maxSteps", async () => {
    const schema = planSchema(["search"]);
    const result = await schema["~standard"].validate({ steps: stepsOf(5000) });

    expect("issues" in result).toBe(true);
  });

  it("still accepts an over-maxSteps plan within the ceiling — the runtime truncates the tail", async () => {
    const schema = planSchema(["search"], 3);
    const result = await schema["~standard"].validate({ steps: stepsOf(12) });

    expect("issues" in result).toBe(false);
    if (!("issues" in result)) {
      expect(result.value.steps).toHaveLength(12);
    }
  });
});
