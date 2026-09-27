import { createHash } from "node:crypto";

/**
 * Serialize a JSON-compatible value deterministically by sorting every
 * object key recursively.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);

  return `{${entries.join(",")}}`;
}

type ApprovalBindingInput = {
  agentName: string;
  sessionId?: string;
  toolName: string;
  args: unknown;
};

/**
 * Create the stable identity for an approval's exact gated tool call.
 */
export function createApprovalBindingKey(input: ApprovalBindingInput): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}
