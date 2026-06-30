import type { Placeholders } from "../contracts/placeholders.type";
import type {
  SystemPromptBlockContract,
  SystemPromptContract,
  SystemPromptMeta,
} from "../contracts/system-prompt.contract";
import type {
  ExportedRegistry,
  PromptDiff,
  PromptTemplateVersion,
  PromptValidateTarget,
  PromptValidationResult,
  PromptsValidateOptions,
} from "./prompts-manager.type";

/**
 * One registered prompt in the {@link PromptsManagerContract} — a named,
 * versioned `SystemPromptContract` plus the bookkeeping the manager needs to
 * resolve "latest" deterministically.
 *
 * **Role.** The unit `register()` produces and `list()` / `get()` return. The
 * registry is keyed by `name@version`, so the same `name` can hold many
 * versions side by side, each its own entry.
 */
export interface PromptsManagerEntry {
  /** Registry name (from the contract's `meta.name`). */
  readonly name: string;

  /** Version label. Defaults to the next integer when registration omits it. */
  readonly version: string;

  /**
   * Monotonic insertion order, sourced from an internal counter (never
   * `Date.now()`), so "latest" is the highest `addedAt` for a name —
   * deterministic and stable across same-tick registrations.
   */
  readonly addedAt: number;

  /** The registered prompt builder. */
  readonly contract: SystemPromptContract;

  /** Optional free-form tags for grouping / filtering. */
  readonly tags?: readonly string[];
}

/** Options for {@link PromptsManagerContract.register}. */
export interface PromptsManagerRegisterOptions {
  /** Optional tags stored alongside the entry. */
  readonly tags?: readonly string[];

  /**
   * Explicit name override. When set, it (not `contract.meta().name`) is the
   * registry name — used by `define()` / `import()` to register an anonymous
   * contract under a name without triggering the `SystemPrompt` constructor's
   * auto-registration into the process-wide default manager.
   */
  readonly name?: string;

  /** Explicit version override, paired with {@link name}. */
  readonly version?: string;
}

/**
 * Public surface of the prompts manager returned by `prompts()` and exposed as
 * `ai.prompts`.
 *
 * **Role.** A single registry of named, versioned `SystemPromptContract`
 * builders keyed by `name@version`. It owns registration (deriving the version
 * when omitted, rejecting non-idempotent duplicates), version resolution
 * (latest by insertion order), and one-call `resolve()` to the final string.
 *
 * **Responsibility.**
 * - Owns: the `name@version` registry, the monotonic `addedAt` counter, the
 *   duplicate / idempotency rule, and latest-version selection.
 * - Does NOT own: how a prompt renders (delegated to the contract's
 *   `resolve()`), the `{{placeholder}}` syntax, or block composition.
 */
export interface PromptsManagerContract {
  /**
   * Register a prompt builder. The contract must carry `meta.name`; the
   * version defaults to the next integer for that name when `meta.version` is
   * omitted. Throws `InvalidRequestError` on a duplicate `name@version` unless
   * the registered content is byte-identical (idempotent re-registration).
   * Returns the manager for chaining.
   */
  register(
    contract: SystemPromptContract,
    options?: PromptsManagerRegisterOptions,
  ): PromptsManagerContract;

  /**
   * Build a new `SystemPromptContract` — a documented alias of `ai.systemPrompt`.
   * Identical input forms: no argument → empty builder; a single string → one
   * instruction-seeded prompt; an array of blocks → used verbatim. Pass a `meta`
   * with a `name` to auto-register the result in the process-wide `ai.prompts`
   * default manager (same semantics as `ai.systemPrompt(input, { name })`).
   *
   * Provided so prompt authoring and the prompt registry share one entry point:
   * `ai.prompts.create(...)` reads identically to `ai.prompts.get(...)` /
   * `ai.prompts.resolve(...)` right beside it.
   */
  create(
    input?: string | ReadonlyArray<SystemPromptBlockContract>,
    meta?: SystemPromptMeta,
  ): SystemPromptContract;

  /**
   * Resolve a registered builder. The optional second argument selects the
   * version by its label, by a pinned tag (`get(name, "production")`), or via
   * the inline `name@selector` form folded into the first argument
   * (`get("agent@production")`, `get("agent@2")`). With no selector, returns
   * the latest by insertion order. Throws `InvalidRequestError` on an unknown
   * name, version, or tag.
   */
  get(name: string, versionOrTag?: string): SystemPromptContract;

  /** Whether any version of `name` is registered (optionally a specific version/tag). */
  has(name: string, versionOrTag?: string): boolean;

  /** Every registered name, in first-seen order. */
  list(): string[];

  /** Version labels registered for a name, oldest first. Empty when unknown. */
  versions(name: string): string[];

  /**
   * Resolve a registered prompt to its final string in one call — picks the
   * version (latest when omitted; a version label, a pinned tag, or the inline
   * `name@selector` form is accepted) and renders it against `placeholders`.
   * Throws `InvalidRequestError` on an unknown name / version / tag.
   */
  resolve(
    name: string,
    versionOrTag?: string,
    placeholders?: Placeholders,
  ): string;

  /**
   * Bulk-register many versions of one name in a single call. Each entry's
   * `template` is a raw string (wrapped into one instruction block) or an
   * explicit ordered block list (used verbatim). Versions register oldest-first
   * in array order; the same duplicate / idempotency rule as `register` applies
   * per `name@version`. Returns the manager for chaining.
   */
  define(
    name: string,
    versions: readonly PromptTemplateVersion[],
  ): PromptsManagerContract;

  /**
   * Pin a tag to a specific registered version of a name (e.g.
   * `tag("agent", "production", "2")`). The tag then resolves through
   * `get(name, tag)` / `resolve(name, tag)` / the `name@tag` inline form.
   * Re-pinning an existing tag moves it. Throws `InvalidRequestError` when the
   * name or version is unknown. Returns the manager for chaining.
   */
  tag(name: string, tag: string, version: string): PromptsManagerContract;

  /**
   * Unified prompt validation. ALWAYS runs the deterministic check — every
   * `{{key}}` placeholder with no inline default that is neither supplied
   * (`options.placeholders`) nor declared (`options.declare` + the prompt's
   * `meta.required`) is reported in `missing`, and `ok` is `true` iff `missing`
   * is empty. When `options.judge` is a model, ALSO runs a Nova-safe
   * LLM-as-judge quality pass — it never throws and degrades to an `issues`
   * note (leaving `score` undefined) on failure, so it never flips `ok`.
   *
   * `target` is a registered name (or `name@selector`), a `SystemPromptContract`
   * instance, or a raw prompt string.
   */
  validate(
    target: PromptValidateTarget,
    options?: PromptsValidateOptions,
  ): Promise<PromptValidationResult>;

  /**
   * Block-level diff between two registered versions of a name. Blocks are
   * matched positionally; the result lists added / removed / changed blocks and
   * an `identical` flag. Throws `InvalidRequestError` on an unknown name or
   * version.
   */
  diff(name: string, from: string, to: string): PromptDiff;

  /**
   * Serialize the whole registry to a portable JSON snapshot — every name, its
   * versions (flattened to `{ type, text }` blocks), pinned tags, and carried
   * `description` / `required` metadata. Round-trips through `import`.
   */
  export(): ExportedRegistry;

  /**
   * Rehydrate a registry from an `export()` snapshot. Each version re-registers
   * under its `name@version` (subject to the same duplicate / idempotency rule)
   * and pinned tags are restored. Returns the manager for chaining.
   */
  import(snapshot: ExportedRegistry): PromptsManagerContract;
}

export type { SystemPromptContract, SystemPromptMeta };
