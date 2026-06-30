import type {
  PromptValidationResult,
  PromptsValidateOptions,
} from "../prompts/prompts-manager.type";
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
}
