/**
 * Return shape for `nextStep` callbacks — controls workflow routing.
 *
 * - `{ goto: string }` — jump to a named step
 * - `{ end: true }` — terminate the workflow successfully
 * - `void` / `undefined` — fall through (next declared step, or next
 *   level of routing resolution)
 */
export type NextStepResult =
  | { goto: string }
  | { end: true }
  | void
  | undefined;
