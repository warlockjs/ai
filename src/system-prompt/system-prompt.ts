import { readFileSync } from "node:fs";
import type { Placeholders } from "../contracts/placeholders.type";
import type {
  InstructionContract,
  PersonaContract,
  SystemPromptBlockContract,
  SystemPromptContract,
} from "../contracts/system-prompt.contract";
import { InvalidRequestError } from "../errors";
import { Instruction } from "./instruction";
import { Persona } from "./persona";

/**
 * Concrete `SystemPromptContract` — an immutable layered prompt builder.
 *
 * **Role.** The top-level composer for a system prompt: it holds an ordered
 * list of typed blocks (persona + instructions) and resolves the whole
 * stack into one final string when the agent is about to call the model.
 *
 * **Responsibility.**
 * - Owns: the ordered `blocks` list and the block-join rules (insertion
 *   order, blank-line separator, trim).
 * - Does NOT own: how any individual block is rendered (delegated to each
 *   block's `resolve()`), the placeholder syntax (delegated to
 *   `renderPlaceholders`), or any knowledge of the agent, model, or
 *   session consuming the resolved text.
 *
 * Blocks are discriminated by a string `type` tag (`"persona"` /
 * `"instruction"`) rather than `instanceof`, so user-supplied blocks that
 * implement `SystemPromptBlockContract` interoperate seamlessly with blocks
 * built via `ai.persona()` / `ai.instruction()` — even across duplicate
 * package copies or bundler scope boundaries.
 *
 * The builder is **immutable** — every `.persona()` / `.instruction()`
 * call returns a fresh `SystemPrompt` instance sharing nothing mutable
 * with its parent. This makes forking a base prompt into specialized
 * variants a safe, side-effect-free operation.
 *
 * Users construct via the `ai.systemPrompt()` factory — `new SystemPrompt()`
 * is not the public API (see §4.2 of code-style.md). Modeled as a class so
 * that methods live on the prototype (one copy shared across every forked
 * instance) and downstream code can branch via `instanceof SystemPrompt`.
 *
 * @example
 * // Chainable form
 * const alex = ai.persona("You are Alex, a TypeScript expert.");
 * const replyIn = ai.instruction("Respond in {{language|English}}.");
 *
 * const base = ai.systemPrompt().persona(alex).instruction(replyIn);
 * const arabicVariant = base.instruction("Prefer Arabic comments.");
 *
 * base.resolve({ language: "English" });
 * arabicVariant.resolve({ language: "Arabic" });
 *
 * @example
 * // Array form — insertion order is preserved exactly
 * const prompt = ai.systemPrompt([
 *   ai.persona("You are Alex, a TypeScript expert."),
 *   ai.instruction("Respond in {{language|English}}."),
 * ]);
 */
export class SystemPrompt implements SystemPromptContract {
  public constructor(
    public readonly blocks: readonly SystemPromptBlockContract[] = [],
  ) {}

  /**
   * Build a system prompt by reading the file at `path` once, synchronously,
   * at construction time. The file's UTF-8 contents seed a single instruction
   * block — the same semantics as the string-seed form of `systemPrompt()` —
   * so placeholders inside the file (`{{language|English}}`) resolve at
   * `resolve()` time and the result can be forked with further
   * `.persona()` / `.instruction()` calls.
   *
   * One-shot by design: the file is read exactly once here, never re-read on
   * `resolve()`. Reads are synchronous so the call stays a drop-in for the
   * synchronous `systemPrompt()` factory and the synchronous `resolve()` API.
   *
   * Throws `InvalidRequestError` when the file cannot be read (missing path,
   * permission denied) — surfacing the underlying cause so a typo in the
   * prompt path fails loudly at construction instead of silently producing an
   * empty prompt.
   *
   * @param path - Filesystem path to the prompt template file.
   *
   * @example
   * const prompt = SystemPrompt.fromFile("./prompts/support-agent.md");
   *
   * const localized = prompt.instruction("Respond in {{language|English}}.");
   * localized.resolve({ language: "Arabic" });
   */
  public static fromFile(path: string): SystemPrompt {
    let contents: string;

    try {
      contents = readFileSync(path, "utf8");
    } catch (error) {
      throw new InvalidRequestError(
        `Failed to read system prompt file "${path}" — ${
          error instanceof Error ? error.message : String(error)
        }`,
        { context: { path }, cause: error },
      );
    }

    return new SystemPrompt([new Instruction(contents)]);
  }

  /**
   * Return a new builder with the persona block set. If a persona already
   * exists it's replaced in place (preserving its position in `blocks`);
   * otherwise the new persona is prepended so persona-first remains the
   * default for chain-built prompts. Accepts either raw text (auto-wrapped
   * via `new Persona`) or an existing `PersonaContract` instance for reuse
   * across prompts.
   */
  public persona(value: PersonaContract | string): SystemPromptContract {
    const block = typeof value === "string" ? new Persona(value) : value;
    const existingIndex = this.blocks.findIndex(
      candidate => candidate.type === "persona",
    );

    if (existingIndex >= 0) {
      const next = [...this.blocks];
      next[existingIndex] = block;

      return new SystemPrompt(next) as this;
    }

    return new SystemPrompt([block, ...this.blocks]);
  }

  /**
   * Return a new builder with the given instruction appended. Instructions
   * render in insertion order. Accepts either raw text (auto-wrapped via
   * `new Instruction`) or an existing `InstructionContract` instance for
   * cross-prompt reuse.
   */
  public instruction(
    value: InstructionContract | string,
  ): SystemPromptContract {
    const block = typeof value === "string" ? new Instruction(value) : value;

    return new SystemPrompt([...this.blocks, block]);
  }

  /**
   * Resolve every block against the placeholder map, join the results with
   * blank-line separators (in insertion order), and trim. Returns an empty
   * string when no blocks are present — callers treat that as "no system
   * message".
   */
  public resolve(placeholders?: Placeholders): string {
    return this.blocks
      .map(block => block.resolve(placeholders))
      .join("\n\n")
      .trim();
  }
}

/**
 * Public factory for `SystemPrompt`, callable directly or via its
 * `fromFile` static. Exists as a named interface so the callable signature
 * and the `fromFile` attachment travel together as one public type.
 */
export interface SystemPromptFactory {
  (input?: string | ReadonlyArray<SystemPromptBlockContract>): SystemPrompt;

  /**
   * Build a system prompt from a file read once at construction. Delegates
   * to {@link SystemPrompt.fromFile}, so `ai.systemPrompt.fromFile(path)` and
   * `SystemPrompt.fromFile(path)` behave identically.
   *
   * @example
   * const prompt = ai.systemPrompt.fromFile("./prompts/support-agent.md");
   */
  fromFile(path: string): SystemPrompt;
}

function systemPromptFactory(
  input?: string | ReadonlyArray<SystemPromptBlockContract>,
): SystemPrompt {
  if (input === undefined) {
    return new SystemPrompt();
  }

  if (typeof input === "string") {
    return new SystemPrompt([new Instruction(input)]);
  }

  return new SystemPrompt([...input]);
}

/**
 * Create a new immutable system-prompt builder.
 *
 * **Role.** Public factory for `SystemPrompt` — keeps user-facing code
 * free of `new` and consistent with `ai.tool()`, `ai.agent()`,
 * `ai.persona()`, `ai.instruction()`.
 *
 * Input forms:
 * - No argument → empty builder, chain `.persona()` / `.instruction()`
 * - Single string → seeded with one instruction for quick one-shot prompts
 * - Array of blocks → used verbatim, preserving insertion order
 * - `.fromFile(path)` → seeded from a file read once at construction
 *
 * @example
 * // Composed builder
 * const prompt = systemPrompt()
 *   .persona("You are Alex, a senior TypeScript engineer.")
 *   .instruction("Always include working code examples.")
 *   .instruction("Respond in {{language|English}}.");
 *
 * prompt.resolve({ language: "Arabic" });
 *
 * @example
 * // One-shot seed
 * const prompt = systemPrompt("Answer only with JSON matching the schema.");
 *
 * @example
 * // From a file, read once at construction
 * const prompt = systemPrompt.fromFile("./prompts/support-agent.md");
 *
 * @example
 * // Array form — fully declarative
 * const prompt = systemPrompt([
 *   ai.persona("You are Alex."),
 *   ai.instruction("Always cite sources."),
 *   ai.instruction("Respond in {{language|English}}."),
 * ]);
 */
export const systemPrompt: SystemPromptFactory = Object.assign(
  systemPromptFactory,
  { fromFile: SystemPrompt.fromFile },
);
