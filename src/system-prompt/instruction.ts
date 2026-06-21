import type { Placeholders } from "../contracts/placeholders.type";
import type { InstructionContract } from "../contracts/system-prompt.contract";
import { renderPlaceholders } from "./render-placeholders";

/**
 * Concrete `InstructionContract` — a reusable directive block.
 *
 * **Role.** A single addressable prompt block representing one rule the
 * agent must follow (`"Always respond in {{language|English}}."`). Exists
 * as its own type so the same instruction can be shared across many
 * prompts and agents, each render supplying its own placeholder map.
 *
 * **Responsibility.**
 * - Owns: the `type: "instruction"` discriminator, the raw template text,
 *   and the placeholder-rendering step.
 * - Does NOT own: ordering relative to other instructions, joining with a
 *   persona, or any surrounding prompt composition — those concerns live
 *   in `SystemPrompt`.
 *
 * Users construct via the `ai.instruction()` factory — `new Instruction()`
 * is not the public API (see §4.2 of code-style.md).
 *
 * @example
 * const replyInLanguage = ai.instruction("Respond in {{language|English}}.");
 *
 * const prompt = ai.systemPrompt()
 *   .persona("You are Alex.")
 *   .instruction(replyInLanguage)
 *   .instruction("Always include code examples.");
 */
export class Instruction implements InstructionContract {
  public readonly type = "instruction" as const;

  public constructor(public readonly text: string) {
    //
  }

  /**
   * Substitute `{{mustache}}` placeholders in the instruction text against
   * the supplied map. Delegates to the shared `renderPlaceholders` helper
   * so persona / instruction / system-prompt rendering stays identical.
   */
  public resolve(placeholders?: Placeholders): string {
    return renderPlaceholders(this.text, placeholders);
  }
}

/**
 * Create an `Instruction` from raw template text.
 *
 * @example
 * const replyIn = instruction("Respond in {{language|English}}.");
 * const cite = instruction("Always cite sources inline.");
 */
export function instruction(text: string): Instruction {
  return new Instruction(text);
}
