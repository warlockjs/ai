import type {
  GuardrailMatch,
  GuardrailVerdict,
  SyncGuardrailDetector,
  TopicFilterOptions,
} from "../contracts";

/** Detector name, used as the namespace prefix on every {@link GuardrailMatch.rule}. */
const DETECTOR_NAME = "topic";

/**
 * Locate the first occurrence of `term` in `text`. A `string` matches
 * case-insensitively as a substring; a `RegExp` is tested as-is (its own
 * flags decide case-sensitivity). Returns the inclusive `[start, end]`
 * span on a hit, or `undefined` when the term is absent.
 */
function locate(text: string, term: string | RegExp): readonly [number, number] | undefined {
  if (typeof term === "string") {
    if (term.length === 0) {
      return undefined;
    }

    const index = text.toLowerCase().indexOf(term.toLowerCase());

    if (index === -1) {
      return undefined;
    }

    return [index, index + term.length - 1];
  }

  // RegExp: run a non-global copy so a caller-supplied `/g` term cannot leak
  // `lastIndex` between calls and so `.exec` reports a deterministic first hit.
  const probe = new RegExp(term.source, term.flags.replace(/[gy]/g, ""));
  const match = probe.exec(text);

  if (match === null) {
    return undefined;
  }

  return [match.index, match.index + match[0].length - 1];
}

/** A human-readable label for a deny/allow term, used in the match rule + reason. */
function describeTerm(term: string | RegExp): string {
  return typeof term === "string" ? term : term.source;
}

/**
 * Build the built-in **topic filter** (`ai.guardrail.topic`) — a
 * zero-runtime-dependency {@link GuardrailDetector} that gates text against a
 * deny list, an allow list, or both.
 *
 * - **`deny`** — any term that appears triggers `onMatch`. A `string`
 *   matches case-insensitively as a substring; a `RegExp` is tested as-is.
 *   The deny list is checked first; the first hit decides the verdict.
 * - **`allow`** — when set, text matching **none** of the allow terms
 *   triggers `onMatch` (an allow-list miss). Text matching at least one
 *   allow term passes the allow gate.
 *
 * `onMatch` is `"block"` (default) or `"flag"`. With neither list supplied
 * the detector is a no-op that always allows.
 *
 * @example
 * ai.guardrail.topic({ deny: ["medical advice", /diagnos\w+/i] });
 *
 * @example
 * // Stay on-topic: anything not about billing is flagged.
 * ai.guardrail.topic({ allow: ["billing", "invoice", "refund"], onMatch: "flag" });
 */
export function topic(options: TopicFilterOptions): SyncGuardrailDetector {
  const deny = options.deny ?? [];
  const allow = options.allow ?? [];
  const onMatch = options.onMatch ?? "block";

  return {
    name: DETECTOR_NAME,
    check(text: string): GuardrailVerdict {
      // Deny list: the first present term decides the verdict.
      for (const term of deny) {
        const span = locate(text, term);

        if (span !== undefined) {
          const label = describeTerm(term);
          const match: GuardrailMatch = {
            rule: `${DETECTOR_NAME}.deny.${label}`,
            span,
            label,
          };
          const reason = options.reason ?? `Denied topic matched: ${label}.`;

          return verdict(onMatch, reason, [match]);
        }
      }

      // Allow list: matching NONE of the terms is a miss → trigger onMatch.
      if (allow.length > 0) {
        const matchedAny = allow.some(term => locate(text, term) !== undefined);

        if (!matchedAny) {
          const match: GuardrailMatch = {
            rule: `${DETECTOR_NAME}.allow.miss`,
            label: "allow-miss",
          };
          const reason =
            options.reason ?? "Text matched none of the allowed topics.";

          return verdict(onMatch, reason, [match]);
        }
      }

      return { type: "allow" };
    },
  };
}

/**
 * Fold the resolved action into a `block` or `flag` verdict. Topic never
 * redacts — it cannot meaningfully rewrite a whole-text policy miss — so the
 * action is constrained to `"block" | "flag"` at the type level.
 */
function verdict(
  action: "block" | "flag",
  reason: string,
  matches: readonly GuardrailMatch[],
): GuardrailVerdict {
  if (action === "block") {
    return { type: "block", reason, matches };
  }

  return { type: "flag", reason, matches };
}
