import type { StepDefinition } from "../contracts/workflow/step.contract";
import type { WorkflowDefinition } from "../contracts/workflow/workflow.contract";

function stepFingerprint(step: StepDefinition): unknown {
  const tag = step.parallel
    ? "parallel"
    : step.agent
      ? "agent"
      : step.run
        ? "run"
        : "empty";

  const agentName = step.agent?.name;

  return {
    n: step.name,
    t: tag,
    a: agentName,
    c: step.parallel?.map(child => stepFingerprint(child)) ?? null,
  };
}

/**
 * FNV-1a 32-bit hash — deterministic, no crypto dependency.
 */
function hash(input: string): string {
  let h = 0x811c9dc5;

  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }

  return h.toString(16).padStart(8, "0");
}

export function computeSignature<T>(definition: WorkflowDefinition<any, T, any, any>): string {
  const fingerprint = {
    n: definition.name,
    v: definition.version ?? null,
    s: definition.steps.map(step => stepFingerprint(step)),
  };

  return hash(JSON.stringify(fingerprint));
}
