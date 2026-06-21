import type { Placeholders } from "../contracts/placeholders.type";
import type { PersonaContract } from "../contracts/system-prompt.contract";
import { renderPlaceholders } from "./render-placeholders";

/**
 * Concrete `PersonaContract` — a reusable "who the agent is" block.
 *
 * **Role.** A single addressable prompt block representing the agent's
 * identity (`"You are Alex, a senior TypeScript engineer."`). Exists as
 * its own type so personas can be defined once and reused across many
 * `SystemPrompt` compositions, agents, and sessions — each render can
 * supply a different placeholder map.
 *
 * **Responsibility.**
 * - Owns: the `type: "persona"` discriminator, the raw template text, and
 *   the placeholder-rendering step.
 * - Does NOT own: composition with instructions, ordering, joining, or
 *   any knowledge of the surrounding `SystemPrompt`. Those concerns live
 *   in `SystemPrompt`.
 *
 * Users construct via the `ai.persona()` factory — `new Persona()` is not
 * the public API (see §4.2 of code-style.md).
 *
 * @example
 * const alex = ai.persona("You are Alex, a TypeScript expert.");
 *
 * const prompt = ai.systemPrompt()
 *   .persona(alex)
 *   .instruction("Always cite sources.");
 */
export class Persona implements PersonaContract {
  public readonly type = "persona" as const;

  public constructor(public readonly text: string) {
    //
  }

  /**
   * Substitute `{{mustache}}` placeholders in the persona text against the
   * supplied map. Delegates to the shared `renderPlaceholders` helper so
   * persona / instruction / system-prompt rendering stays identical.
   */
  public resolve(placeholders?: Placeholders): string {
    return renderPlaceholders(this.text, placeholders);
  }
}

/**
 * Create a `Persona` from raw template text.
 *
 * @example
 * const alex = persona("You are Alex, a TypeScript expert.");
 * const greeter = persona("You are a greeter in {{language|English}}.");
 */
export function persona(text: string): Persona {
  return new Persona(text);
}
