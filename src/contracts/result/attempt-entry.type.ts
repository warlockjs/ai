import type { AIError } from "../../errors/ai-error";

/**
 * One row in an executable's retry history. Captures a single
 * attempt's timing + outcome — populated wherever retry happens:
 *
 * - **Workflow** — per-step retry loop (native, see `step-runner.ts`),
 *   surfaced at `StepSnapshot.attemptHistory`.
 * - **Agent / Tool / Supervisor** — middleware-driven retries write
 *   here via `MiddlewareState`; the executable surfaces them at
 *   `BaseReport.attempts` so Panoptic / cost dashboards see the
 *   real call count, not just the surviving success.
 *
 * The shape is intentionally minimal — start-end-duration + status +
 * error. Richer per-attempt forensics (input snapshot, partial output)
 * stay out of the universal contract; consumers that need them attach
 * via `error.context` or middleware-specific extensions.
 *
 * @example
 * const entry: AttemptEntry = {
 *   index: 1,
 *   startedAt: "2026-05-12T09:00:00.000Z",
 *   endedAt:   "2026-05-12T09:00:00.450Z",
 *   duration: 450,
 *   status: "failed",
 *   error: new ProviderRateLimitError("429"),
 * };
 */
export type AttemptEntry = {
  /** 1-based attempt index. */
  index: number;
  startedAt: string;
  endedAt: string;
  duration: number;
  status: "success" | "failed";
  error?: AIError;
};
