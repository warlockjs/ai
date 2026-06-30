import type {
  SkillAnalyticsEvent,
  SkillReviewGate,
} from "./contracts/skills-config.type";
import type { SkillRecord } from "./contracts/skill-record.type";

/** Outcome of running a candidate through the review gate. */
export type ReviewOutcome =
  | { promoted: true; record: SkillRecord; reason?: string }
  | { promoted: false; reason?: string };

/**
 * Run a candidate through the **default-DENY** review gate (Phase 2).
 *
 * The gate's `approve(candidate)` decides: only `{ approve: true }`
 * promotes the candidate to a new audited version via `gate.store.promote`.
 * Everything else — `{ approve: false }`, a malformed result, or a THROW
 * (fail-closed) — leaves the candidate inert and emits a `denied` event.
 * On approval, a `promoted` event fires with the new version.
 *
 * Analytics errors are swallowed by the supplied sink wrapper; this runner
 * never throws — a gate that throws is simply treated as a denial.
 *
 * @example
 * const outcome = await runReviewGate(candidate, gate, emit);
 * if (outcome.promoted) console.log("now at v" + outcome.record.version);
 */
export async function runReviewGate(
  candidate: SkillRecord,
  gate: SkillReviewGate,
  emit?: (event: SkillAnalyticsEvent) => void,
): Promise<ReviewOutcome> {
  let verdict: { approve: boolean; reason?: string };

  try {
    verdict = await gate.approve(candidate);
  } catch (error) {
    // Fail-closed: a throwing gate is a denial, never an accidental promotion.
    const reason = error instanceof Error ? error.message : String(error);

    emit?.({ type: "denied", skill: candidate.name, version: candidate.version });

    return { promoted: false, reason };
  }

  if (!verdict || verdict.approve !== true) {
    emit?.({ type: "denied", skill: candidate.name, version: candidate.version });

    return { promoted: false, reason: verdict?.reason };
  }

  const record = await gate.store.promote(candidate.name);

  emit?.({ type: "promoted", skill: record.name, version: record.version });

  return { promoted: true, record, reason: verdict.reason };
}
