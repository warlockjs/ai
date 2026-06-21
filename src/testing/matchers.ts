import type { StandardSchemaV1 } from "@standard-schema/spec";
import { expect } from "vitest";
import {
  matchConverge,
  matchOutputShape,
  matchPassStep,
  matchRouteTo,
} from "./matcher-logic";

/**
 * Custom Vitest matchers over the unified `@warlock.js/ai` report tree.
 *
 * - `toRouteTo(intent)` — a supervisor dispatched the named intent.
 * - `toConverge()` — a supervisor terminated cleanly on its own
 *   decision (not max-iterations / cancelled / error).
 * - `toPassStep(name)` — a workflow step completed successfully.
 * - `toOutputShape(schema)` — a result's `data` validates against a
 *   Standard Schema.
 *
 * @example
 * import { registerAiMatchers } from "@warlock.js/ai";
 * registerAiMatchers();
 *
 * expect(await supervisor.execute(input)).toRouteTo("critic");
 * expect(await supervisor.execute(input)).toConverge();
 * expect(await workflow.execute(input)).toPassStep("draft");
 * expect(await agent.execute(input, { output: schema })).toOutputShape(schema);
 */
export interface AiMatchers<R = unknown> {
  /** Assert a supervisor dispatched the named intent across its run. */
  toRouteTo(intent: string): R;
  /** Assert a supervisor terminated cleanly on its own decision. */
  toConverge(): R;
  /** Assert a named workflow step completed successfully. */
  toPassStep(stepName: string): R;
  /** Assert a result's `data` validates against a Standard Schema. */
  toOutputShape(schema: StandardSchemaV1): R;
}

declare module "vitest" {
  // Vitest 4's augmentable `Matchers` interface is `Matchers<T = any>`
  // — the type parameter must match exactly (TS2428) or the
  // declaration is rejected. `T` is the assertion-chain return type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Matchers<T = any> extends AiMatchers<T> {}
}

let registered = false;

/**
 * Register the `@warlock.js/ai` custom matchers on Vitest's global
 * `expect`. Call once per test file (or in a shared import) before
 * using `toRouteTo` / `toConverge` / `toPassStep` / `toOutputShape`.
 * Idempotent — repeated calls are a no-op.
 *
 * @example
 * import { registerAiMatchers } from "@warlock.js/ai";
 * registerAiMatchers();
 */
export function registerAiMatchers(): void {
  if (registered) {
    return;
  }

  registered = true;

  expect.extend({
    toRouteTo(received: unknown, intent: string) {
      return matchRouteTo(received as never, intent);
    },
    toConverge(received: unknown) {
      return matchConverge(received as never);
    },
    toPassStep(received: unknown, stepName: string) {
      return matchPassStep(received as never, stepName);
    },
    toOutputShape(received: unknown, schema: StandardSchemaV1) {
      return matchOutputShape(received as never, schema);
    },
  });
}
