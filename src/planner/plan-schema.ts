import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { PlannerPlan, PlannerStep } from "../contracts/planner/planner-plan.type";

/**
 * Build the Standard Schema the planning agent emits — an ordered
 * `{ steps: [...], summary? }` plan whose every step references one of
 * `capabilityNames` via the `capability` field.
 *
 * Mirrors the router's hand-built schema approach
 * (`supervisor/router-factory.ts`): the JSON Schema extension carries
 * the capability names as an `enum` so capable providers enforce the
 * choice natively, while `validate()` still accepts the shape softly so
 * providers without native structured output can pass a parsed object
 * through. Validation is intentionally lenient on `capability` — an
 * unknown name is surfaced later by the planner as a typed
 * `PlannerPlanInvalidError`, with the full forensic context, rather
 * than as an opaque schema issue here.
 *
 * `maxSteps`, when provided, is emitted as the `steps` array's
 * `maxItems` so capable providers refuse to over-produce up front
 * (the planner still truncates the tail to `skipped` defensively).
 */
export function planSchema(
  capabilityNames: string[],
  maxSteps?: number,
): StandardSchemaV1<PlannerPlan> {
  // OpenAI strict `json_schema` mode (and other native structured-output
  // providers) require EVERY property to appear in `required` — with truly
  // optional fields expressed as nullable — and reject array `minItems` /
  // `maxItems`. So the schema is strict-shaped: all keys required, the
  // optional ones nullable, no item-count bounds. A non-empty plan is
  // enforced in `validate()`, and `maxSteps` by the runtime's tail
  // truncation, so neither bound is needed on the wire.
  void maxSteps;

  const jsonSchema = {
    type: "object",
    properties: {
      summary: {
        type: ["string", "null"],
        description: "One-line summary of the overall strategy.",
      },
      steps: {
        type: "array",
        description: "Ordered steps to execute, one capability dispatch each.",
        items: stepItemsSchema(capabilityNames),
      },
    },
    required: ["summary", "steps"],
    additionalProperties: false,
  };

  return {
    "~standard": {
      version: 1,
      vendor: "warlock-planner",
      jsonSchema: {
        input: () => jsonSchema,
      },
      validate(value: unknown): StandardSchemaV1.Result<PlannerPlan> {
        if (!value || typeof value !== "object") {
          return { issues: [{ message: "plan must be an object" }] };
        }

        const record = value as { steps?: unknown; summary?: unknown };

        if (!Array.isArray(record.steps) || record.steps.length === 0) {
          return { issues: [{ message: "plan `steps` must be a non-empty array" }] };
        }

        const steps: PlannerStep[] = [];

        for (const raw of record.steps) {
          const normalized = normalizeStep(raw);

          if (!normalized) {
            return {
              issues: [{ message: "each plan step must carry a string `capability` and `input`" }],
            };
          }

          steps.push(normalized);
        }

        const summary = typeof record.summary === "string" ? record.summary : undefined;

        return { value: summary !== undefined ? { steps, summary } : { steps } };
      },
    } as StandardSchemaV1<PlannerPlan>["~standard"] & {
      jsonSchema: { input: () => Record<string, unknown> };
    },
  };
}

/** Per-step JSON Schema object — one capability dispatch. */
function stepItemsSchema(capabilityNames: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      id: {
        type: ["string", "null"],
        description: "Stable step id, referenced by dependsOn.",
      },
      capability: {
        type: "string",
        enum: capabilityNames,
        description: "Name of the capability to dispatch for this step.",
      },
      input: {
        type: "string",
        description: "Concrete input passed to the capability's execute().",
      },
      reason: { type: ["string", "null"], description: "Why this step exists." },
      dependsOn: {
        type: ["array", "null"],
        items: { type: "string" },
        description: "Ids of steps this one conceptually follows.",
      },
    },
    // Strict mode: every property required; the genuinely-optional ones
    // (id / reason / dependsOn) are nullable. `validate()` treats null and
    // missing identically, so a model emitting `null` round-trips fine.
    required: ["id", "capability", "input", "reason", "dependsOn"],
    additionalProperties: false,
  };
}

/**
 * Coerce one raw step object into a {@link PlannerStep}, returning
 * `undefined` when the mandatory `capability` / `input` strings are
 * missing. Optional fields are copied only when well-typed.
 */
function normalizeStep(raw: unknown): PlannerStep | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const record = raw as {
    id?: unknown;
    capability?: unknown;
    input?: unknown;
    reason?: unknown;
    dependsOn?: unknown;
  };

  if (typeof record.capability !== "string" || record.capability.length === 0) {
    return undefined;
  }

  if (typeof record.input !== "string") {
    return undefined;
  }

  const step: PlannerStep = {
    capability: record.capability,
    input: record.input,
  };

  if (typeof record.id === "string") {
    step.id = record.id;
  }

  if (typeof record.reason === "string") {
    step.reason = record.reason;
  }

  if (Array.isArray(record.dependsOn) && record.dependsOn.every((entry) => typeof entry === "string")) {
    step.dependsOn = record.dependsOn as string[];
  }

  return step;
}
