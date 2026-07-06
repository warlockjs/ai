import type {
  PromptValidationResult,
  PromptsValidateOptions,
} from "../prompts/prompts-manager.type";
import type { ModelContract } from "./model.contract";
import type { Placeholders } from "./placeholders.type";

/**
 * Base contract shared by every block that can appear inside a
 * `SystemPromptContract` — currently persona and instruction, with room for
 * future block kinds (examples, guardrails, etc.) without breaking changes.
 *
 * Blocks are discriminated by a string `type` tag — not `instanceof` — so
 * runtime checks remain robust across duplicate package copies, bundler
 * scopes, and user-supplied implementations that don't extend our classes.
 *
 * @example
 * // Narrow via the discriminator
 * if (block.type === "persona") {
 *   // block is PersonaContract
 * }
 */
export interface SystemPromptBlockContract {
  /** Discriminator for the concrete block kind. */
  readonly type: string;

  /** Raw template text, before placeholder resolution. */
  readonly text: string;

  /** Render the block with placeholders substituted in. */
  resolve(placeholders?: Placeholders): string;
}

/**
 * Contract for a persona block — the "who the agent is" layer of a system
 * prompt. A persona owns a single template string and resolves its own
 * placeholders, so the same `Persona` instance can be reused across many
 * `SystemPrompt`s or agents without recomputation.
 *
 * @example
 * const alex: PersonaContract = ai.persona("You are Alex, a TypeScript expert.");
 * alex.resolve(); // "You are Alex, a TypeScript expert."
 */
export interface PersonaContract extends SystemPromptBlockContract {
  readonly type: "persona";
}

/**
 * Contract for a single instruction block — one directive in a layered
 * system prompt. Each instruction owns its own template string and resolves
 * its placeholders independently, so the same `Instruction` instance can be
 * reused across different `SystemPrompt`s with different placeholder maps.
 *
 * @example
 * const replyInLanguage: InstructionContract =
 *   ai.instruction("Respond in {{language|English}}.");
 *
 * replyInLanguage.resolve({ language: "Arabic" });
 * // "Respond in Arabic."
 */
export interface InstructionContract extends SystemPromptBlockContract {
  readonly type: "instruction";
}

/**
 * Identity + provenance metadata attached to a `SystemPromptContract`.
 *
 * A prompt that carries a `name` becomes addressable in the `ai.prompts`
 * registry (keyed by `name@version`); anonymous prompts (no `name`) are never
 * registered and exist only for inline composition / display.
 *
 * `composedFrom` records the deterministic source labels a prompt was merged
 * from (e.g. `["base@2", "global-instructions@1"]`) — provenance with no
 * random suffixes, so the same merge always yields the same labels.
 *
 * @example
 * const base = ai.systemPrompt("You are support.", {
 *   name: "support",
 *   version: "1",
 *   description: "Tier-1 support persona.",
 * });
 */
export interface SystemPromptMeta {
  /** Registry name. When present the prompt auto-registers in `ai.prompts`. */
  readonly name?: string;

  /** Registry version label. Defaults to the next integer when omitted. */
  readonly version?: string;

  /** Human-readable description of the prompt's purpose. */
  readonly description?: string;

  /** Deterministic source labels this prompt was composed from (e.g. `["base@2"]`). */
  readonly composedFrom?: readonly string[];

  /** Placeholder keys callers must supply when resolving this prompt. */
  readonly required?: readonly string[];

  /**
   * Provenance label of the prompt this one was refined from (e.g.
   * `"support@1"`, or `"anonymous"` for an unnamed source). Stamped by
   * `refined(...).refinePrompt()` — never set by hand.
   */
  readonly refinedFrom?: string;

  /** `provider:name` of the model that produced a refined prompt's text. */
  readonly refinerModel?: string;
}

/**
 * Options for the registry-aware overload of {@link SystemPromptContract.merge}
 * that folds in a named prompt resolved from `ai.prompts`.
 */
export interface SystemPromptMergeOptions {
  /**
   * Which registered version to fold in when merging by name. Defaults to the
   * latest registered version. Ignored when merging a contract instance.
   */
  readonly fromVersion?: string;
}

/**
 * A source that {@link SystemPromptContract.merge} can fold in: a pre-built
 * block, another prompt contract (its blocks are folded — persona replaces,
 * instructions append), or a registered prompt name resolved from `ai.prompts`.
 */
export type SystemPromptMergeSource =
  | SystemPromptBlockContract
  | SystemPromptContract
  | string;

/**
 * Structural store a refined prompt pins its compiled text into — the same
 * `get` / `set` subset of `@warlock.js/cache`'s `CacheDriver` that
 * `PromptJudgeCacheLike` uses, so any cache driver satisfies it while
 * `@warlock.js/cache` stays an optional peer.
 *
 * Semantically a **store, not a cache**: a pinned refinement is re-generated
 * only when an input changes (source text, refiner model, criteria, recipe
 * version) — never evicted-and-silently-recomputed over time. Prefer a
 * persistent/shared backend (redis, pg) so one process pays the refinement
 * and the fleet reads the pin.
 */
export interface RefinedPromptStoreLike {
  /** Read a pinned value, or `null` on a miss. */
  get<T = unknown>(key: string): Promise<T | null>;

  /** Pin a value (TTL / options ignored by this path — pins don't expire). */
  set(key: string, value: unknown, ttlOrOptions?: unknown): Promise<unknown>;
}

/**
 * Configuration for {@link SystemPromptContract.refined} — the prompt
 * compiler. `model` writes the refined text; `criteria` steers the rewrite;
 * `store` pins the result across processes.
 */
export interface RefinedSystemPromptOptions {
  /** The refiner model that rewrites the prompt (one call per unique input). */
  readonly model: ModelContract;

  /**
   * Rules the rewritten prompt must satisfy, on top of the built-in
   * refinement recipe — same shape and meaning as `validate({ criteria })`
   * (validate *grades* against criteria; refined *rewrites* against them).
   * A single string is used verbatim; a list becomes a numbered rule set.
   */
  readonly criteria?: string | readonly string[];

  /**
   * Where the compiled text is pinned. Omitted ⇒ the pin lives on the
   * refined prompt instance for the process lifetime (compile once per
   * instance); pass a shared store for cross-process / persistent pinning.
   */
  readonly store?: RefinedPromptStoreLike;
}

/** Per-call options for `refine()` / `refinePrompt()`. */
export interface PromptRefineOptions {
  /**
   * Skip the pinned value and compile a fresh take (the new result replaces
   * the pin). Use when you want another attempt at the same source.
   */
  readonly fresh?: boolean;
}

/**
 * Immutable builder for composing a layered system prompt out of persona and
 * instruction blocks. Every mutating method returns a fresh builder — the
 * original is never mutated, so base prompts can be forked into specialized
 * variants without side effects.
 *
 * Blocks are stored in a single ordered list and rendered in insertion order.
 * The array-form factory (`systemPrompt([...])`) gives you full control over
 * placement; the chainable form defaults to persona-first by prepending new
 * personas (or replacing an existing one in place).
 *
 * Both `persona()` and `instruction()` accept either a raw string (auto-
 * wrapped into a `Persona` / `Instruction`) or a pre-built contract
 * instance. Passing instances lets the same block be reused across many
 * prompts with each prompt supplying its own placeholder map at resolve time.
 *
 * @example
 * // Chainable form
 * const alex = ai.persona("You are Alex, a TypeScript expert.");
 * const replyIn = ai.instruction("Respond in {{language|English}}.");
 *
 * const prompt = ai.systemPrompt()
 *   .persona(alex)
 *   .instruction(replyIn)
 *   .instruction("Always include working code examples.");
 *
 * @example
 * // Array form — insertion order is preserved exactly
 * const prompt = ai.systemPrompt([
 *   ai.persona("You are Alex, a TypeScript expert."),
 *   ai.instruction("Respond in {{language|English}}."),
 *   ai.instruction("Always include working code examples."),
 * ]);
 *
 * const arabic = prompt.resolve({ language: "Arabic" });
 */
export interface SystemPromptContract {
  /** All blocks in render order. Read-only snapshot — use `persona()` / `instruction()` to derive a new builder. */
  readonly blocks: readonly SystemPromptBlockContract[];

  /**
   * Identity + provenance metadata. Read it via the no-argument
   * {@link SystemPromptContract.meta} accessor (`prompt.meta()`); it is
   * present when the prompt was given a name (via `systemPrompt(input, meta)`
   * or `.meta({ name })`) or acquired `composedFrom` provenance through a
   * `merge`, and `undefined` for a bare anonymous prompt.
   *
   * Exposed as a method (not a bare field) because the same `meta` identifier
   * also serves as the immutable updater — see the call signatures below.
   */

  /**
   * No-argument form: read the current metadata snapshot (or `undefined` when
   * the prompt is anonymous and carries no provenance).
   */
  meta(): SystemPromptMeta | undefined;

  /**
   * Updater form: return a new builder with `meta` merged onto the current
   * metadata (shallow). Immutable — the original is untouched. Giving the
   * result a `name` registers it in `ai.prompts` under `name@version`
   * (version defaults to the next integer); renaming a forked prompt creates
   * a new registry key while the original entry stays put.
   */
  meta(meta: SystemPromptMeta): SystemPromptContract;

  /**
   * Set (or replace) the persona block. Returns a new builder. If a persona
   * already exists it's replaced in place (preserving its position);
   * otherwise the new persona is prepended. Only one persona per prompt.
   */
  persona(persona: PersonaContract | string): SystemPromptContract;

  /**
   * Append an instruction block. Returns a new builder. Multiple calls
   * accumulate — instructions render in the order they were added.
   */
  instruction(instruction: InstructionContract | string): SystemPromptContract;

  /**
   * Merge N predefined blocks into the prompt in one call. Each block is
   * folded in order through the same per-type rules as `persona()` /
   * `instruction()`: a `persona` block sets/replaces the single, leading
   * persona; every other block is appended in order. Accepts pre-built
   * `ai.persona()` / `ai.instruction()` blocks (or any `SystemPromptBlockContract`)
   * for reuse across prompts. Returns a new builder; the original is untouched.
   */
  merge(...blocks: readonly SystemPromptBlockContract[]): SystemPromptContract;

  /**
   * Fold in another prompt's blocks. A persona block replaces this prompt's
   * persona; instruction (and any other) blocks append in order. The result's
   * `meta.composedFrom` records the deterministic source labels of both this
   * prompt and the folded one (e.g. `["base@2", "global-instructions@1"]`).
   * Returns a new builder; the original is untouched.
   */
  merge(source: SystemPromptContract): SystemPromptContract;

  /**
   * Fold in a prompt resolved from the `ai.prompts` registry by name. Uses the
   * latest registered version unless `options.fromVersion` selects another.
   * Throws `InvalidRequestError` when the name (or requested version) is not
   * registered. Provenance is recorded in `meta.composedFrom`.
   */
  merge(
    name: string,
    options?: SystemPromptMergeOptions,
  ): SystemPromptContract;

  /**
   * Resolve all placeholders across every block, producing the final system
   * prompt string. Blocks render in insertion order, separated by a blank line.
   *
   * Supports `{{key}}`, `{{nested.key}}`, and `{{key|default}}` syntax.
   *
   * @param placeholders - Values to inject into `{{mustache}}` slots.
   */
  resolve(placeholders?: Placeholders): string;

  /**
   * Sugar over `ai.prompts.validate(this, options)`. Runs the deterministic
   * placeholder check (missing required `{{keys}}`) and, when `options.judge`
   * is a model, the Nova-safe LLM-as-judge quality pass. The result's `ok`
   * reflects the deterministic verdict alone; a flaky judge never flips it.
   */
  validate(options?: PromptsValidateOptions): Promise<PromptValidationResult>;

  /**
   * Derive the **compiled** form of this prompt: a lazy wrapper that rewrites
   * the human-authored text into a model-optimized version via
   * `options.model` the first time it is used by an agent, pins the result
   * (in `options.store` when given, else on the instance), and serves the
   * pinned text from then on. The source prompt stays the editing surface;
   * the refined text is a derived artifact — re-compiled only when the
   * source text, refiner model, `criteria`, or built-in recipe change.
   *
   * The wrapper is a full `SystemPromptContract`, so it drops in anywhere a
   * prompt does. Refinement is advisory on the agent path: if the refiner
   * fails, the ORIGINAL prompt is served (warned once, never thrown).
   * Placeholders are contract, not prose — the compiled text keeps the exact
   * `{{placeholder}}` set or the refinement is rejected.
   *
   * @example
   * const support = ai.systemPrompt(
   *   [ai.persona("You are a friendly assistant."), ai.instruction("Help {{name}} with orders.")],
   *   { name: "support" },
   * ).refined({ model: anthropic.model({ name: "claude-sonnet-4-5" }) });
   *
   * const agent = ai.agent({ model, systemPrompt: support }); // compiles lazily on first run
   */
  refined(options: RefinedSystemPromptOptions): RefinedSystemPromptContract;

  /**
   * Optional async pre-resolution hook. When present, consumers that are
   * about to call the synchronous `resolve()` on an async boundary (the
   * agent input builder) await it first, letting a lazily-compiled prompt
   * finish its work. Plain builders don't implement it; implementations
   * must never throw (degrade to the original text instead).
   */
  materialize?(): Promise<void>;
}

/**
 * The compiled form of a system prompt, returned by
 * {@link SystemPromptContract.refined}. A full drop-in prompt contract plus
 * the explicit compilation surface: `refine()` hands back the compiled
 * template text (for admin routes, previews, boot warmup, CI), and
 * `refinePrompt()` hands back a composable `SystemPromptContract` built from
 * it. All three consumption paths — lazy agent use, `refine()`, and
 * `refinePrompt()` — share one compilation pipeline and one pin.
 */
export interface RefinedSystemPromptContract extends SystemPromptContract {
  /** The human-authored prompt this wrapper compiles — always the source of truth. */
  readonly source: SystemPromptContract;

  /**
   * Chaining stays compiled: every derivation edits the SOURCE and re-wraps
   * it with the same refinement options, so the return type stays refined —
   * and the pin invalidates naturally (new source ⇒ new key).
   */
  persona(persona: PersonaContract | string): RefinedSystemPromptContract;

  /** See {@link RefinedSystemPromptContract.persona} — chaining stays compiled. */
  instruction(
    instruction: InstructionContract | string,
  ): RefinedSystemPromptContract;

  /** See {@link RefinedSystemPromptContract.persona} — chaining stays compiled. */
  merge(
    ...blocks: readonly SystemPromptBlockContract[]
  ): RefinedSystemPromptContract;
  merge(source: SystemPromptContract): RefinedSystemPromptContract;
  merge(
    name: string,
    options?: SystemPromptMergeOptions,
  ): RefinedSystemPromptContract;

  /** Read the SOURCE prompt's metadata — a compiled prompt keeps its source identity. */
  meta(): SystemPromptMeta | undefined;

  /** Rename the SOURCE and re-wrap — refinement survives the rename. */
  meta(meta: SystemPromptMeta): RefinedSystemPromptContract;

  /**
   * Compile now (or read the pin) and return the refined template **string**.
   * Still a template: the exact `{{placeholder}}` set of the source survives
   * verbatim, so the text stays parametric. Store-first — an unchanged input
   * returns the pinned text without a model call; `{ fresh: true }` forces a
   * new take (which replaces the pin).
   *
   * Unlike the lazy agent path, this explicit call **throws**
   * `PromptRefinementError` when the refiner fails or breaks placeholder
   * parity — a route/CI caller needs the failure, not a silent fallback.
   */
  refine(options?: PromptRefineOptions): Promise<string>;

  /**
   * Same compilation, returned as a new `SystemPromptContract` (one
   * instruction block holding the refined template) for composition:
   * hand it to an agent, `.resolve(placeholders)`, `.merge(...)`,
   * `validate({ criteria })`, or `.meta({ name })` it to register the
   * compiled text as a next version (unlocking `ai.prompts.diff` as the
   * original-vs-refined review flow). Carries `meta.refinedFrom` /
   * `meta.refinerModel` provenance and the source's `required` keys; never
   * auto-registers — registry versions stay human-intentional.
   */
  refinePrompt(options?: PromptRefineOptions): Promise<SystemPromptContract>;

  /**
   * The advisory compilation hook the agent path awaits: compiles + pins on
   * first call, no-op once pinned, and NEVER throws — on any refiner failure
   * it warns once and leaves `resolve()` serving the original text.
   */
  materialize(): Promise<void>;
}
