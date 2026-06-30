import { humanApproval } from "./human-approval";
import { resume } from "./resume";
import { interruptMemory, interruptPg, interruptRedis } from "./stores";

/**
 * The assembled `ai.human.*` namespace — the human-in-the-loop surface
 * mounted onto the shared `ai` object in `../ai`.
 *
 * - `approval(options)` — the `tool.before` approval-gate middleware.
 * - `resume(id, decision, options)` — out-of-process durable resume.
 * - `interrupt.{memory,pg,redis}()` — the
 *   {@link import("./contracts").InterruptStore} factories (memory ships
 *   real; pg/redis lazily import their optional-peer driver).
 *
 * Declared as a standalone object so `../ai` can spread it onto the `ai`
 * literal and pin the `Ai.human` member to this exact shape with no casts.
 * Lives here (not inlined into `../ai`) to keep the human factories grouped
 * with the rest of the human module and avoid `../ai` reaching into each
 * store/middleware file directly.
 */
export const human = {
  approval: humanApproval,
  resume,
  interrupt: {
    memory: interruptMemory,
    pg: interruptPg,
    redis: interruptRedis,
  },
};
