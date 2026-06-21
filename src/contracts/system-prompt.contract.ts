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
   * Resolve all placeholders across every block, producing the final system
   * prompt string. Blocks render in insertion order, separated by a blank line.
   *
   * Supports `{{key}}`, `{{nested.key}}`, and `{{key|default}}` syntax.
   *
   * @param placeholders - Values to inject into `{{mustache}}` slots.
   */
  resolve(placeholders?: Placeholders): string;
}
