import type { ModelContract } from "../contracts/model.contract";
import type { Placeholders } from "../contracts/placeholders.type";
import type { SystemPromptBlockContract } from "../contracts/system-prompt.contract";

/**
 * The minimal cache surface the judge-verdict memo needs — a structural subset
 * of `@warlock.js/cache`'s `CacheDriver` (`get` / `set`). Typed structurally
 * (not imported) so `@warlock.js/cache` stays a strictly OPTIONAL peer: a
 * consumer that never validates with a judge never needs the cache package.
 * Any `CacheDriver` instance satisfies this.
 */
export interface PromptJudgeCacheLike {
  /** Read a cached value, or `null` on a miss. */
  get<T = unknown>(key: string): Promise<T | null>;
  /** Write a value (TTL / options ignored by this memo path). */
  set(key: string, value: unknown, ttlOrOptions?: unknown): Promise<unknown>;
}

/**
 * Options for the `prompts(options?)` factory.
 */
export interface PromptsManagerOptions {
  /**
   * Optional cache that memoizes LLM-judge verdicts. Keyed by a content hash of
   * the resolved prompt body + the judge model's id, so a re-validation of the
   * same prompt with the same judge skips the model call. Absent ⇒ every judge
   * pass runs live (a pure no-op seam — `@warlock.js/cache` stays optional).
   */
  readonly judgeCache?: PromptJudgeCacheLike;
}

/**
 * What {@link PromptsManagerContract.validate} accepts as its target:
 * - a registered prompt **name** (resolved to its latest version, or a tagged /
 *   `name@version` selector — same syntax `get` accepts);
 * - a `SystemPromptContract` instance (named or anonymous);
 * - a raw prompt **string** (validated verbatim, no registry lookup).
 */
export type PromptValidateTarget = string | SystemPromptBlockContract | object;

/**
 * Options for {@link PromptsManagerContract.validate}.
 */
export interface PromptsValidateOptions {
  /**
   * Placeholder values the caller intends to supply at resolve time. Any
   * `{{key}}` present in these (or carrying an inline default, or declared in
   * `meta.required`) is NOT reported as missing.
   */
  readonly placeholders?: Placeholders;

  /**
   * Extra placeholder keys to treat as known/declared (beyond the prompt's own
   * `meta.required`). A key listed here is never reported missing.
   */
  readonly declare?: readonly string[];

  /**
   * Optional model that powers the LLM-as-judge quality pass. When omitted,
   * `validate` runs the deterministic placeholder check only and returns no
   * `score`. The judge is Nova-safe — it never throws and degrades to an
   * `issues` note (leaving `score` undefined) on any failure.
   */
  readonly judge?: ModelContract;

  /**
   * Per-call judge-verdict cache override. When set, takes precedence over the
   * manager's `judgeCache` for this call only. Same memo semantics: only used
   * when `judge` is also supplied.
   */
  readonly judgeCache?: PromptJudgeCacheLike;
}

/**
 * Unified result of {@link PromptsManagerContract.validate}.
 *
 * `ok` is the deterministic verdict alone — `true` iff no required placeholder
 * is missing. The optional LLM-judge `score` / `issues` are advisory and never
 * flip `ok`, so a flaky judge can't fail an otherwise-valid prompt.
 */
export interface PromptValidationResult {
  /** `true` when no required placeholder is missing (deterministic verdict). */
  readonly ok: boolean;

  /** Placeholder keys referenced with no default, unsupplied and undeclared. */
  readonly missing: string[];

  /**
   * LLM-judge quality score in `[0, 1]`. Present only when a `judge` model was
   * supplied AND the judge produced a usable verdict; `undefined` when no judge
   * ran or the judge degraded.
   */
  readonly score?: number;

  /**
   * Advisory findings — the judge's reason(s) and/or a degrade note. Present
   * (possibly empty) only when a `judge` model was supplied.
   */
  readonly issues?: string[];
}

/**
 * One version in a bulk {@link PromptsManagerContract.define} call (or a
 * `.templates([...])` builder call): a version label plus its body, given
 * either as a raw string (wrapped into a single instruction block) or as an
 * explicit ordered list of blocks (used verbatim).
 */
export interface PromptTemplateVersion {
  /** Version label, e.g. `"1"`, `"2"`, `"2025-draft"`. */
  readonly version: string;

  /**
   * The version body. A string becomes one instruction block; an array of
   * blocks is registered verbatim, preserving order.
   */
  readonly template: string | readonly SystemPromptBlockContract[];
}

/**
 * One block in a {@link PromptDiff} — its discriminator and raw text, so a diff
 * is comparable without resolving placeholders.
 */
export interface PromptDiffBlock {
  /** Block discriminator (`"persona"` / `"instruction"` / …). */
  readonly type: string;
  /** Raw template text. */
  readonly text: string;
}

/**
 * Block-level diff between two registered versions of a prompt, returned by
 * {@link PromptsManagerContract.diff}. Blocks are matched positionally.
 */
export interface PromptDiff {
  /** The prompt name diffed. */
  readonly name: string;
  /** The left/from version label. */
  readonly from: string;
  /** The right/to version label. */
  readonly to: string;
  /** Blocks present in `to` but not at the same position in `from`. */
  readonly added: PromptDiffBlock[];
  /** Blocks present in `from` but not at the same position in `to`. */
  readonly removed: PromptDiffBlock[];
  /** Blocks at the same position whose `type` or `text` changed. */
  readonly changed: { from: PromptDiffBlock; to: PromptDiffBlock }[];
  /** `true` when the two versions have identical blocks in identical order. */
  readonly identical: boolean;
}

/**
 * The portable JSON shape of a single registered version, used by
 * {@link PromptsManagerContract.export} / `import`. Blocks are flattened to
 * `{ type, text }` so the registry round-trips without live builder instances.
 */
export interface ExportedPromptVersion {
  readonly version: string;
  readonly blocks: PromptDiffBlock[];
  /** Tags pinned to this exact version (via `tag(name, tag, version)`). */
  readonly tags?: string[];
  /** Carried-through `meta.description`, when present. */
  readonly description?: string;
  /** Carried-through `meta.required`, when present. */
  readonly required?: string[];
}

/**
 * The portable JSON shape of one registered name and all its versions, used by
 * {@link PromptsManagerContract.export} / `import`.
 */
export interface ExportedPrompt {
  readonly name: string;
  readonly versions: ExportedPromptVersion[];
}

/**
 * The full portable registry snapshot returned by
 * {@link PromptsManagerContract.export} and accepted by `import`.
 */
export interface ExportedRegistry {
  readonly prompts: ExportedPrompt[];
}
