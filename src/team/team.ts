import type {
  EvaluateContext,
  EvaluateResult,
} from "../contracts/supervisor/evaluate-context.type";
import type { SupervisorIntentValue } from "../contracts/supervisor/intent-entry.type";
import type { SupervisorConfig } from "../contracts/supervisor/supervisor-config.type";
import type { SupervisorContract } from "../contracts/supervisor/supervisor.contract";
import type {
  TeamConfig,
  TeamGate,
  TeamGateFn,
  TeamMemberValue,
} from "../contracts/team/team-config.type";
import { SupervisorFailedError } from "../errors";
import { supervisor } from "../supervisor/supervisor";
import { buildQualityGate, buildVerifyGate } from "./gates";

/**
 * `ai.team(config)` — thin, transparent sugar over `ai.supervisor`.
 *
 * Builds a {@link SupervisorConfig} from the team-shaped config and
 * calls `supervisor(...)`, returning the **unchanged**
 * `SupervisorContract<TOutput>` — the same object `ai.supervisor`
 * returns, so `ctx.intents.<member>.execute()`, `.asTool()`,
 * `.resume()`, snapshots, and events all stay intact. `team()` owns no
 * loop: the manager becomes `route`/`router`, the members become
 * `intents`, and the `gate` becomes `evaluate`. Everything else passes
 * through 1:1.
 *
 * A `gate: "quality" | "verify"` string selects a pre-built `evaluate`
 * strategy ({@link buildQualityGate} / {@link buildVerifyGate}); a
 * function forwards straight to `SupervisorConfig.evaluate` (full
 * escape hatch). When the gate is a string, the resolved `fixer` (and,
 * for `"quality"`, the `reviewer`) roles are validated against
 * `members` at construction — a missing role throws an authoring-style
 * {@link SupervisorFailedError} (`context: { authoring: true }`) rather
 * than silently starving until `maxIterations`.
 *
 * @example
 * const codeTeam = ai.team({
 *   name: "code-team",
 *   goal: "Ship a tested module that passes review.",
 *   manager: techLeadRouter,
 *   members: { builder, reviewer, fixer },
 *   gate: "quality",
 *   output: v.object({ code: v.string() }),
 *   maxIterations: 6,
 * });
 *
 * const { data, report } = await codeTeam.execute("Build a debounce<T> utility.");
 */
export function team<
  TOutput = unknown,
  TState = TOutput,
  TMembers extends Record<string, TeamMemberValue> = Record<string, TeamMemberValue>,
>(config: TeamConfig<TOutput, TState, TMembers>): SupervisorContract<TOutput> {
  const supervisorConfig: SupervisorConfig<TOutput, TState> = {
    name: config.name,
    version: config.version,
    // Stamp the report/result discriminator as "team" so team runs are
    // distinguishable on the wire (Panoptic groups/filters them as their
    // own type) — the only behavioural difference from a plain supervisor.
    reportType: "team",
    intents: config.members as unknown as Record<string, SupervisorIntentValue>,
    evaluate: resolveGate<TOutput, TState, TMembers>(config),
    goal: config.goal,
    output: config.output,
    state: config.state,
    maxIterations: config.maxIterations,
    snapshotStore: config.snapshotStore,
    on: config.on,
    // Forward observability verbatim — the supervisor `team()` returns
    // routes its report through the generic Observer seam, so a team
    // inherits observation with no team-specific wiring (F1/F3).
    observe: config.observe,
  };

  // Manager → `route` XOR `router`. Reuse the supervisor's own XOR
  // validation; team() forwards exactly one of the two, so a malformed
  // manager surfaces the existing SupervisorFailedError downstream.
  if (isRouteManager(config.manager)) {
    supervisorConfig.route = config.manager.route;
  } else {
    supervisorConfig.router = config.manager;
  }

  return supervisor<TOutput, TState>(supervisorConfig);
}

/**
 * Resolve the team's `gate` into a concrete `evaluate` callback. A
 * function forwards untouched; a {@link TeamGate} string is validated
 * against `members` and desugared into the matching pre-built gate.
 */
function resolveGate<
  TOutput,
  TState,
  TMembers extends Record<string, TeamMemberValue>,
>(
  config: TeamConfig<TOutput, TState, TMembers>,
): (ctx: EvaluateContext<TState>) => EvaluateResult | Promise<EvaluateResult> {
  if (typeof config.gate === "function") {
    return config.gate as TeamGateFn<TState>;
  }

  const gate: TeamGate = config.gate;
  const fixerRole = config.roles?.fixer ?? "fixer";

  assertMemberExists(config, fixerRole, "fixer");

  if (gate === "quality") {
    const reviewerRole = config.roles?.reviewer ?? "reviewer";

    assertMemberExists(config, reviewerRole, "reviewer");

    const gateKey = config.gateKey ?? "approved";

    return buildQualityGate<TState>(gateKey, fixerRole);
  }

  const gateKey = config.gateKey ?? "passed";

  return buildVerifyGate<TState>(gateKey, fixerRole);
}

/**
 * Construction-time guard: assert the resolved role key exists in
 * `members`, throwing an authoring-style {@link SupervisorFailedError}
 * (tagged `authoring: true`) listing the missing role when it doesn't.
 */
function assertMemberExists<
  TOutput,
  TState,
  TMembers extends Record<string, TeamMemberValue>,
>(
  config: TeamConfig<TOutput, TState, TMembers>,
  role: string,
  label: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(config.members, role)) {
    throw new SupervisorFailedError(
      `ai.team("${config.name}"): gate "${config.gate as string}" needs a "${label}" member but no \`members.${role}\` key exists`,
      { context: { authoring: true } },
    );
  }
}

/**
 * Discriminate the `manager` union: `true` when it is the deterministic
 * `{ route }` form, `false` for a bare `AgentContract` / `RouterEntry`.
 */
function isRouteManager<TOutput, TState>(
  manager: TeamConfig<TOutput, TState>["manager"],
): manager is { route: NonNullable<SupervisorConfig<TOutput, TState>["route"]> } {
  return (
    typeof manager === "object" &&
    manager !== null &&
    "route" in manager &&
    typeof (manager as { route?: unknown }).route === "function"
  );
}
