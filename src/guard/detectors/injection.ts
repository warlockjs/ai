import type {
  GuardrailMatch,
  GuardrailVerdict,
  InjectionDetectorOptions,
  SyncGuardrailDetector,
} from "../contracts";

const DETECTOR_NAME = "injection";

/**
 * Built-in jailbreak / prompt-injection marker phrases. Each entry is a
 * case-insensitive substring (matched lowercased) paired with the rule
 * label surfaced on the {@link GuardrailMatch} (`injection.<label>`).
 *
 * The set targets the canonical override / role-reset / exfiltration
 * patterns rather than trying to be exhaustive — a curated, low-false-
 * positive seed that callers extend with their own `markers`. Phrases are
 * deliberately specific (`"ignore previous instructions"`, not the bare
 * word `"ignore"`) so ordinary prose does not trip the rule.
 */
const BUILT_IN_MARKERS: readonly { readonly phrase: string; readonly label: string }[] = [
  { phrase: "ignore previous instructions", label: "override" },
  { phrase: "ignore all previous instructions", label: "override" },
  { phrase: "ignore the above instructions", label: "override" },
  { phrase: "disregard previous instructions", label: "override" },
  { phrase: "disregard all previous instructions", label: "override" },
  { phrase: "forget previous instructions", label: "override" },
  { phrase: "forget all previous instructions", label: "override" },
  { phrase: "ignore your instructions", label: "override" },
  { phrase: "override your instructions", label: "override" },
  { phrase: "do not follow your instructions", label: "override" },
  { phrase: "you are now", label: "role-reset" },
  { phrase: "act as", label: "role-reset" },
  { phrase: "pretend to be", label: "role-reset" },
  { phrase: "developer mode", label: "jailbreak" },
  { phrase: "jailbreak", label: "jailbreak" },
  { phrase: "dan mode", label: "jailbreak" },
  { phrase: "do anything now", label: "jailbreak" },
  { phrase: "bypass your", label: "jailbreak" },
  { phrase: "ignore your guidelines", label: "jailbreak" },
  { phrase: "ignore your safety", label: "jailbreak" },
  { phrase: "ignore the rules", label: "jailbreak" },
  { phrase: "without any restrictions", label: "jailbreak" },
  { phrase: "reveal your system prompt", label: "exfiltration" },
  { phrase: "print your system prompt", label: "exfiltration" },
  { phrase: "show your system prompt", label: "exfiltration" },
  { phrase: "repeat your instructions", label: "exfiltration" },
  { phrase: "what are your instructions", label: "exfiltration" },
  { phrase: "reveal your prompt", label: "exfiltration" },
];

/**
 * A compiled marker — either a literal substring (matched case-insensitively
 * against the lowercased text) or a caller-supplied `RegExp` (tested as-is).
 * `label` is the namespaced rule suffix (`injection.<label>`); for built-in
 * phrases it is the threat category, for caller markers the index.
 */
interface CompiledMarker {
  readonly label: string;
  readonly phrase?: string;
  readonly pattern?: RegExp;
}

/**
 * The zero-dependency built-in injection detector — the internal class
 * behind the {@link injection} factory. Scans for jailbreak / prompt-
 * injection marker phrases (built-in set + caller `markers`) and returns a
 * `block` or `flag` verdict (per `onMatch`) listing every match, or `allow`
 * when the text is clean.
 *
 * Detection only: a detector never throws or mutates the pipeline — the
 * `guard()` factory translates the verdict into the trip's throw / record
 * mechanics.
 */
class InjectionDetector implements SyncGuardrailDetector {
  public readonly name = DETECTOR_NAME;

  /** The compiled built-in + caller markers, scanned in registration order. */
  private readonly markers: readonly CompiledMarker[];

  /** Whether a match escalates to `block` (`true`) or stays a `flag`. */
  private readonly block: boolean;

  public constructor(options: InjectionDetectorOptions = {}) {
    this.block = options.onMatch === "block";
    this.markers = compileMarkers(options.markers ?? []);
  }

  /**
   * Inspect `text` for any built-in or caller marker. Returns `allow` when
   * none hit, otherwise the configured `block` / `flag` verdict carrying a
   * {@link GuardrailMatch} per hit (with a `[start, end]` span for literal
   * substrings; regex hits report a span only when the match is locatable).
   */
  public check(text: string): GuardrailVerdict {
    const matches = this.scan(text);

    if (matches.length === 0) {
      return { type: "allow" };
    }

    const reason = `Detected ${matches.length} prompt-injection marker(s).`;

    if (this.block) {
      return { type: "block", reason, matches };
    }

    return { type: "flag", reason, matches };
  }

  /** Collect every marker hit in `text`, in marker registration order. */
  private scan(text: string): GuardrailMatch[] {
    const lowered = text.toLowerCase();
    const matches: GuardrailMatch[] = [];

    for (const marker of this.markers) {
      if (marker.phrase !== undefined) {
        const start = lowered.indexOf(marker.phrase);

        if (start !== -1) {
          matches.push({
            rule: `${DETECTOR_NAME}.${marker.label}`,
            label: marker.label,
            span: [start, start + marker.phrase.length - 1],
          });
        }

        continue;
      }

      // Caller-supplied RegExp — tested against the original (not lowered)
      // text so author-controlled case sensitivity is preserved.
      const pattern = marker.pattern;

      if (pattern === undefined) {
        continue;
      }

      const result = pattern.exec(text);

      if (result !== null) {
        const start = result.index;

        matches.push({
          rule: `${DETECTOR_NAME}.${marker.label}`,
          label: marker.label,
          span: [start, start + result[0].length - 1],
        });
      }
    }

    return matches;
  }
}

/**
 * Compile the built-in phrase set plus any caller `markers` into a single
 * ordered list. A caller `string` becomes a lowercased substring matcher
 * (labelled `custom`); a caller `RegExp` is carried as-is (labelled
 * `custom`). Built-ins keep their threat-category label.
 */
function compileMarkers(
  extra: readonly (string | RegExp)[],
): readonly CompiledMarker[] {
  const compiled: CompiledMarker[] = BUILT_IN_MARKERS.map((entry) => ({
    label: entry.label,
    phrase: entry.phrase,
  }));

  for (const marker of extra) {
    if (typeof marker === "string") {
      compiled.push({ label: "custom", phrase: marker.toLowerCase() });

      continue;
    }

    compiled.push({ label: "custom", pattern: marker });
  }

  return compiled;
}

/**
 * Build the built-in `injection` detector (surfaced as
 * `ai.guardrail.injection(options?)`). Matches a curated set of jailbreak /
 * prompt-injection marker phrases — override (`"ignore previous
 * instructions"`), role-reset (`"you are now"`), jailbreak (`"developer
 * mode"`, `"do anything now"`), and exfiltration (`"reveal your system
 * prompt"`) — extensible with caller `markers` (case-insensitive substrings
 * or `RegExp`s).
 *
 * Zero runtime dependency: matching is pure string / regex. On a hit the
 * verdict is `flag` by default (record but allow); pass `onMatch: "block"`
 * to reject instead — commonly used on the `input` phase, where the core
 * `trip.before` seam supports `block` / `flag` only.
 *
 * @param options - Extra `markers` and the `onMatch` action (`"flag"` | `"block"`).
 * @returns A {@link SyncGuardrailDetector} for the guard's `input` / `output` / `tool` arrays.
 *
 * @example
 * const guard = ai.guardrail({
 *   input: [ai.guardrail.injection({ onMatch: "block" })],
 *   output: [ai.guardrail.injection()], // flag-only on the model's reply
 * });
 *
 * @example
 * // Extend the built-in set with a house rule.
 * ai.guardrail.injection({ markers: [/system\s*:\s*override/i, "sudo mode"] });
 */
export function injection(
  options?: InjectionDetectorOptions,
): SyncGuardrailDetector {
  return new InjectionDetector(options);
}
