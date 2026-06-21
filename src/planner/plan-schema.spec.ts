import { describe, expect, it } from "vitest";
import { planSchema } from "./plan-schema";

/** Pull the JSON Schema form the planning agent's structured-output path consumes. */
function jsonSchemaOf(schema: ReturnType<typeof planSchema>): Record<string, unknown> {
  const standard = schema["~standard"] as {
    jsonSchema: { input: () => Record<string, unknown> };
  };

  return standard.jsonSchema.input();
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

  it("still validates a well-formed plan after the refactor", () => {
    const schema = planSchema(["search"], 2);
    const result = schema["~standard"].validate({
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
