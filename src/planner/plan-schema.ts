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
 * `maxSteps` cannot be expressed on the wire (strict mode rejects
 * `maxItems`), so `validate()` enforces a hard parse-time ceiling
 * derived from it — see {@link parsedStepCeiling}.
 */
export type PlanSchema = StandardSchemaV1<PlannerPlan> & {
  "~standard": {
    /**
     * JSON Schema extension read by the native structured-output path.
     * Part of the declared type so callers don't have to re-assert it.
     */
    jsonSchema: { input: () => Record<string, unknown> };
  };
};

/**
 * Slack allowed over `maxSteps` before a returned plan is rejected
 * outright. A model that overshoots the prompt's "at most N steps" by a
 * little is normal and the runtime truncates the tail to `skipped`;
 * one that returns several times the budget is malfunctioning (or the
 * provider/proxy is not the one we think it is), and parsing it is
 * unbounded work on attacker-adjacent input.
 */
const STEP_CEILING_FACTOR = 4;

/**
 * Ceiling used when `planSchema` is built without a `maxSteps` — direct
 * callers outside `PlannerRun`, which has no runtime truncation of its
 * own to fall back on.
 */
const DEFAULT_STEP_CEILING = 100;

/**
 * Hard upper bound on the number of steps `validate()` will parse.
 *
 * Strict-mode JSON Schema can't carry `maxItems`, so nothing on the wire
 * stops a provider from returning an arbitrarily long `steps[]`; before
 * 4.15.0 the whole array was parsed, normalized and stored, and only the
 * execution loop truncated it. This is the parse-time backstop that
 * makes the bound hold regardless of what the provider honors.
 */
export function parsedStepCeiling(maxSteps?: number): number {
  if (maxSteps === undefined) {
    return DEFAULT_STEP_CEILING;
  }

  return Math.max(1, Math.ceil(maxSteps)) * STEP_CEILING_FACTOR;
}

export function planSchema(capabilityNames: string[], maxSteps?: number): PlanSchema {
  // OpenAI strict `json_schema` mode (and other native structured-output
  // providers) require EVERY property to appear in `required` — with truly
  // optional fields expressed as nullable — and reject array `minItems` /
  // `maxItems`. So the schema is strict-shaped: all keys required, the
  // optional ones nullable, no item-count bounds on the wire. Both bounds
  // live in `validate()` instead: non-empty below, and the over-long
  // ceiling that `maxItems` would have expressed.
  const stepCeiling = parsedStepCeiling(maxSteps);

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

        // Reject an over-long plan HERE, before a single step is
        // normalized — the runtime's tail truncation runs after the whole
        // array has been parsed and stored, so it bounds execution but
        // not the parsing cost of a pathological response. Rejecting
        // rather than truncating is deliberate: a plan several times its
        // budget is a malfunction worth surfacing as
        // `PlannerPlanInvalidError`, not something to silently trim into
        // a plausible-looking prefix.
        if (record.steps.length > stepCeiling) {
          return {
            issues: [
              {
                message: `plan \`steps\` must not exceed ${stepCeiling} entries (received ${record.steps.length})`,
              },
            ],
          };
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
