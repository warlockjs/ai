import { agent } from "../agent/agent";
import type { AgentContract } from "../contracts/agent/agent.contract";
import type { ModelContract } from "../contracts/model.contract";
import type { SystemPromptContract } from "../contracts/system-prompt.contract";
import { judge } from "../eval/judge-scorer";
import { PROMPT_JUDGE_RUBRIC } from "../prompt/prompt-validate";
import type { PromptJudgeCacheLike } from "./prompts-manager.type";

/**
 * Placeholder matcher — kept in lock-step with the matcher
 * `renderPlaceholders` (`src/system-prompt/render-placeholders.ts`) and the
 * legacy `prompt-validate` lint both use, so the deterministic validator sees
 * the exact same `{{key}}` / `{{a.b}}` / `{{key|default}}` set the renderer
 * substitutes. Global so every occurrence is collected.
 */
const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * One parsed placeholder occurrence — the key path (the part before any
 * `|default`) and whether the occurrence carried an inline default.
 */
type ParsedPlaceholder = {
  /** The dot-path key, e.g. `language` or `user.name`. */
  readonly path: string;
  /** Whether THIS occurrence declared an inline `{{key|default}}` fallback. */
  readonly hasDefault: boolean;
};

/**
 * Collect every distinct placeholder occurrence from a template, in first-seen
 * order. A key is considered to "have a default" only when EVERY occurrence of
 * it carries one — a single bare `{{key}}` means the renderer can leave it
 * unresolved, so the key is still required.
 */
function collectPlaceholders(template: string): ParsedPlaceholder[] {
  const byPath = new Map<string, boolean>();
  const order: string[] = [];

  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const [rawPath, rawDefault] = match[1].split("|");
    const path = rawPath.trim();

    if (path.length === 0) {
      continue;
    }

    const hasDefault = rawDefault !== undefined;

    if (!byPath.has(path)) {
      byPath.set(path, hasDefault);
      order.push(path);
    } else {
      // A key only counts as defaulted when ALL of its occurrences default.
      byPath.set(path, (byPath.get(path) ?? false) && hasDefault);
    }
  }

  return order.map(path => ({ path, hasDefault: byPath.get(path) ?? false }));
}

/**
 * Run the deterministic (model-free) half of validation over a resolved prompt
 * body. Reports every `{{key}}` placeholder that has NO inline default and is
 * neither supplied in `provided` nor declared in `declared` (the prompt's
 * `meta.required` plus any caller-declared keys).
 *
 * Pure and synchronous — the only required half of `validate`; the LLM-judge
 * half is optional and layered on top.
 *
 * @param text - The resolved prompt body (placeholders may still be present).
 * @param provided - Placeholder keys the caller has supplied a value for.
 * @param declared - Placeholder keys declared as known/required (e.g. `meta.required`).
 */
export function findMissingPlaceholders(
  text: string,
  provided: ReadonlySet<string>,
  declared: ReadonlySet<string>,
): string[] {
  const missing: string[] = [];

  for (const { path, hasDefault } of collectPlaceholders(text)) {
    if (hasDefault) {
      continue;
    }

    if (provided.has(path) || declared.has(path)) {
      continue;
    }

    missing.push(path);
  }

  return missing;
}

/**
 * A `meta.required` key absent from the template entirely — declared as
 * required but never referenced — is itself a defect worth surfacing. Returns
 * the declared keys that appear nowhere in the body.
 */
export function findUnreferencedRequired(
  text: string,
  required: readonly string[],
): string[] {
  const present = new Set(collectPlaceholders(text).map(p => p.path));

  return required.filter(key => !present.has(key));
}

/**
 * Build the one-shot judge agent the optional LLM-as-judge pass runs. Mirrors
 * the legacy `prompt.ts` judge agent (strict-JSON instruction so the verdict
 * parses even without an output schema), so the two validate paths share one
 * judging contract.
 */
function buildJudgeAgent(model: ModelContract): AgentContract<unknown> {
  return agent({
    name: "prompt-quality-judge",
    model,
    systemPrompt:
      "You are a strict prompt-quality grader. Respond with JSON only: " +
      '{ "score": <0..1>, "passed": <true|false>, "reason": "<short explanation>" }.',
  });
}

/** Outcome of the optional LLM-as-judge pass over a resolved prompt body. */
export type JudgeOutcome = {
  /**
   * The judge score in `[0, 1]`, or `undefined` when the judge degraded
   * (errored, returned no parseable verdict, or threw) — never a misleading
   * `0` masquerading as a real verdict.
   */
  readonly score?: number;
  /** Human-readable issues raised by the judge (its reason, or a degrade note). */
  readonly issues: string[];
};

/**
 * Run the optional LLM-as-judge pass over a resolved prompt body, REUSING the
 * eval `judge` scorer (the same path `prompt().validate` uses) so there is no
 * second judging implementation.
 *
 * **Nova-safe by contract.** The judge NEVER throws here: the eval scorer
 * already degrades a broken judge to `score: 0` with a failure reason, and any
 * exception that still escapes (model wiring, agent construction) is caught.
 * Both degrade paths surface `score: undefined` plus an issue note — so a flaky
 * judge can never fail an otherwise-valid prompt.
 *
 * @param text - The resolved prompt body under evaluation.
 * @param model - The model that powers the judge agent.
 */
export async function judgePromptBody(
  text: string,
  model: ModelContract,
): Promise<JudgeOutcome> {
  try {
    const judgeAgent = buildJudgeAgent(model);
    const scorer = judge({ agent: judgeAgent, rubric: PROMPT_JUDGE_RUBRIC });

    const verdict = await scorer({
      case: { name: "prompt-quality", input: "Grade the system prompt below." },
      text,
      // `result` is unused by the judge scorer's prompt builder; a minimal
      // stand-in keeps the structural contract satisfied without a real run.
      result: { text } as never,
      output: undefined,
    });

    // The eval scorer signals a degraded judge with score 0 + a diagnostic
    // reason ("judge failed: …" / "judge returned no parseable verdict"). Treat
    // that as "no usable score" rather than a real 0 verdict.
    const degraded =
      verdict.score === 0 &&
      typeof verdict.reason === "string" &&
      /^judge (failed|returned no parseable)/.test(verdict.reason);

    if (degraded) {
      return {
        issues: [`LLM-judge unavailable: ${verdict.reason}`],
      };
    }

    return {
      score: verdict.score,
      issues: verdict.reason ? [verdict.reason] : [],
    };
  } catch (error) {
    // Last-resort guard: never let a judge failure throw out of validate().
    const message = error instanceof Error ? error.message : String(error);

    return {
      issues: [`LLM-judge unavailable: ${message}`],
    };
  }
}

/**
 * Non-cryptographic 53-bit string hash (cyrb53) — deterministic across runs
 * and platforms, with no `node:crypto` dependency (keeps the validate path
 * usable in any runtime). Mirrors the VCR request hash; collision-resistant
 * enough for a per-prompt judge-verdict keyspace. Returned as base-36.
 */
function hashString(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);

    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);

  return combined.toString(36);
}

/**
 * Build the judge-verdict cache key for a resolved prompt body + judge model.
 * Combines the model's `provider:name` identity with a content hash of the
 * body, so the same prompt graded by the same judge hits the cache, while any
 * change to either misses it.
 */
export function judgeCacheKey(text: string, model: ModelContract): string {
  return `prompts.judge.${model.provider}:${model.name}.${hashString(text)}`;
}

/**
 * Run the judge pass with an OPTIONAL memo cache in front. On a hit, the stored
 * {@link JudgeOutcome} is returned without a model call; on a miss, the live
 * judge runs and a USABLE verdict (one carrying a `score`) is written back.
 * Degraded outcomes (no score) are NOT cached — a transient judge failure must
 * never poison the memo. A `null`/absent cache degrades to a direct judge call.
 *
 * Cache I/O is itself fault-tolerant: a `get`/`set` that rejects is swallowed
 * so a flaky cache can never break (or fail) validation.
 *
 * @param text - The resolved prompt body under evaluation.
 * @param model - The judge model.
 * @param cache - Optional verdict memo (any `CacheDriver`-like get/set surface).
 */
export async function judgePromptBodyCached(
  text: string,
  model: ModelContract,
  cache?: PromptJudgeCacheLike,
): Promise<JudgeOutcome> {
  if (!cache) {
    return judgePromptBody(text, model);
  }

  const key = judgeCacheKey(text, model);

  const cached = await readJudgeCache(cache, key);

  if (cached) {
    return cached;
  }

  const outcome = await judgePromptBody(text, model);

  // Only memoize a usable verdict — never a degraded (scoreless) one.
  if (outcome.score !== undefined) {
    await writeJudgeCache(cache, key, outcome);
  }

  return outcome;
}

/** Read a cached verdict, swallowing any cache fault (treated as a miss). */
async function readJudgeCache(
  cache: PromptJudgeCacheLike,
  key: string,
): Promise<JudgeOutcome | undefined> {
  try {
    const value = await cache.get<JudgeOutcome>(key);

    return value ?? undefined;
  } catch {
    return undefined;
  }
}

/** Write a verdict, swallowing any cache fault (best-effort memo). */
async function writeJudgeCache(
  cache: PromptJudgeCacheLike,
  key: string,
  outcome: JudgeOutcome,
): Promise<void> {
  try {
    await cache.set(key, outcome);
  } catch {
    // Best-effort — a failed memo write never affects the validation result.
  }
}

/**
 * Resolve the body + declared-required keys for a validation target that is a
 * `SystemPromptContract` (named or anonymous). The declared set is the
 * prompt's `meta.required` (when present).
 */
export function describeContractTarget(contract: SystemPromptContract): {
  text: string;
  required: readonly string[];
} {
  const meta = contract.meta();

  return {
    text: contract.resolve(),
    required: meta?.required ?? [],
  };
}
