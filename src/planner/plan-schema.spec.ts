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
  it("emits steps.maxItems when maxSteps is provided", () => {
    const json = jsonSchemaOf(planSchema(["a", "b"], 3));
    const steps = (json.properties as { steps: Record<string, unknown> }).steps;

    expect(steps.maxItems).toBe(3);
    expect(steps.minItems).toBe(1);
  });

  it("omits steps.maxItems when maxSteps is absent", () => {
    const json = jsonSchemaOf(planSchema(["a", "b"]));
    const steps = (json.properties as { steps: Record<string, unknown> }).steps;

    expect(steps.maxItems).toBeUndefined();
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
