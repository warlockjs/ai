import { readFileSync } from "node:fs";
import type { Placeholders } from "../contracts/placeholders.type";
import type {
  InstructionContract,
  PersonaContract,
  SystemPromptBlockContract,
  SystemPromptContract,
  SystemPromptMergeOptions,
  SystemPromptMeta,
} from "../contracts/system-prompt.contract";
import { InvalidRequestError } from "../errors";
import { defaultPromptsManager, promptKey } from "../prompts/prompts-manager";
import type {
  PromptValidationResult,
  PromptsValidateOptions,
} from "../prompts/prompts-manager.type";
import { Instruction } from "./instruction";
import { Persona } from "./persona";

/**
 * Monotonic source of the internal, non-registry display id every
 * `SystemPrompt` carries. Anonymous (unnamed) prompts have nothing else to
 * identify them by; this id never feeds the registry and is never derived from
 * the wall clock, so it stays stable and order-deterministic across a run.
 */
let displayIdCounter = 0;

/**
 * Narrow an arbitrary value to a `SystemPromptContract` — true when it exposes
 * the builder surface (`blocks` array + a callable `resolve`). Used by the
 * registry-aware `merge` overload to tell a folded contract from a raw block
 * or a registry name string, robustly across duplicate package copies.
 */
function isSystemPromptContract(
  value: unknown,
): value is SystemPromptContract {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { blocks?: unknown }).blocks) &&
    typeof (value as { resolve?: unknown }).resolve === "function"
  );
}

/**
 * Build the deterministic provenance label for a prompt — `name@version` when
 * it is registered, otherwise its internal display id. No random suffixes, so
 * the same source always yields the same `composedFrom` entry.
 */
function provenanceLabel(prompt: SystemPromptContract): string {
  const meta = prompt.meta();

  if (meta?.name) {
    return promptKey(meta.name, meta.version ?? "1");
  }

  return prompt instanceof SystemPrompt ? prompt.id : "anonymous";
}

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
  /**
   * Internal, non-registry id for display / provenance. Stable for the life of
   * the instance; sourced from a monotonic counter, never the wall clock.
   * Anonymous prompts are identified solely by this id.
   */
  public readonly id: string;

  public constructor(
    public readonly blocks: readonly SystemPromptBlockContract[] = [],
    private readonly metaData?: SystemPromptMeta,
  ) {
    this.id = `prompt#${displayIdCounter++}`;

    // Auto-register the moment a builder acquires a name — whether through the
    // `systemPrompt(input, { name })` factory or a `.meta({ name })` rename.
    // Forks built by `persona()` / `instruction()` / `merge()` deliberately
    // drop the name (they pass no meta), so they stay anonymous and never land
    // in the registry unless explicitly re-named.
    if (metaData?.name) {
      defaultPromptsManager().register(this);
    }
  }

  /**
   * Read the current metadata snapshot (no argument) or derive a renamed
   * builder (with `meta`). The accessor returns `undefined` for an anonymous
   * prompt; the updater shallow-merges `meta` onto the current metadata and
   * returns a fresh builder. Naming the result registers it in `ai.prompts`.
   */
  public meta(): SystemPromptMeta | undefined;
  public meta(meta: SystemPromptMeta): SystemPromptContract;
  public meta(
    meta?: SystemPromptMeta,
  ): SystemPromptMeta | undefined | SystemPromptContract {
    if (meta === undefined) {
      return this.metaData;
    }

    return new SystemPrompt(this.blocks, { ...this.metaData, ...meta });
  }

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
   * Fold predefined blocks, another prompt contract, or a registered prompt
   * name into this builder. Three forms share one method:
   *
   * - `merge(...blocks)` — N pre-built `ai.persona()` / `ai.instruction()`
   *   blocks. A `persona` block sets/replaces the single, leading persona;
   *   every other block appends in order. `base.merge(reviewer, style, lang)`
   *   equals `base.persona(reviewer).instruction(style).instruction(lang)`.
   * - `merge(contract)` — another prompt; its blocks fold in (persona
   *   replaces, instructions append) and `meta.composedFrom` records the
   *   provenance of both sides.
   * - `merge(name, { fromVersion })` — a prompt resolved from `ai.prompts`
   *   (latest version unless `fromVersion` selects another); throws
   *   `InvalidRequestError` when the name / version is unregistered.
   *
   * Immutable — the original builder is untouched; passing zero blocks returns
   * an equivalent builder. The folded result is anonymous (no `name`), so it
   * is never auto-registered even though it carries `composedFrom` provenance.
   */
  public merge(
    ...blocks: readonly SystemPromptBlockContract[]
  ): SystemPromptContract;
  public merge(source: SystemPromptContract): SystemPromptContract;
  public merge(
    name: string,
    options?: SystemPromptMergeOptions,
  ): SystemPromptContract;
  public merge(
    first?:
      | SystemPromptBlockContract
      | SystemPromptContract
      | string,
    // `undefined` is part of the element union so the `merge(name, options?)`
    // overload's optional trailing `options?` (i.e. `… | undefined`) stays
    // assignable to this implementation signature.
    ...rest: readonly (
      | SystemPromptBlockContract
      | SystemPromptMergeOptions
      | undefined
    )[]
  ): SystemPromptContract {
    // Registry-name form: resolve from ai.prompts at the chosen version.
    if (typeof first === "string") {
      const options = rest[0] as SystemPromptMergeOptions | undefined;
      const resolved = defaultPromptsManager().get(first, options?.fromVersion);

      return this.mergeContract(resolved);
    }

    // Contract form: fold another prompt's blocks + record provenance.
    if (isSystemPromptContract(first)) {
      return this.mergeContract(first);
    }

    // Variadic block form (the original behavior).
    const all = [
      ...(first ? [first] : []),
      ...rest,
    ] as readonly SystemPromptBlockContract[];

    return this.foldBlocks(this, all);
  }

  /**
   * Fold an ordered list of blocks onto a starting prompt: persona blocks
   * set/replace the single leading persona; every other block appends in
   * order. The shared core of the variadic-block `merge` and the contract fold.
   */
  private foldBlocks(
    start: SystemPromptContract,
    blocks: readonly SystemPromptBlockContract[],
  ): SystemPromptContract {
    return blocks.reduce<SystemPromptContract>((prompt, block) => {
      if (block.type === "persona") {
        return prompt.persona(block as PersonaContract);
      }

      return new SystemPrompt([...prompt.blocks, block]);
    }, start);
  }

  /**
   * Fold another prompt contract into this one (persona replaces, instructions
   * append) and stamp the deterministic `composedFrom` provenance — this
   * prompt's existing provenance (or its own label) followed by the folded
   * source's label. The result is anonymous so it never auto-registers.
   */
  private mergeContract(
    source: SystemPromptContract,
  ): SystemPromptContract {
    const folded = this.foldBlocks(this, source.blocks);

    const baseProvenance =
      this.metaData?.composedFrom ??
      (this.metaData?.name ? [provenanceLabel(this)] : []);

    const composedFrom = [...baseProvenance, provenanceLabel(source)];

    // Carry forward only provenance — never the name — so the merged result is
    // a fresh anonymous prompt (immutable rename = new key; original stays).
    return new SystemPrompt(folded.blocks, { composedFrom });
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

  /**
   * Validate this prompt via the process-wide `ai.prompts` manager — sugar for
   * `ai.prompts.validate(this, options)`. Runs the deterministic placeholder
   * check and, when `options.judge` is supplied, the Nova-safe LLM-as-judge
   * pass. Never throws on a judge failure; `ok` tracks the deterministic
   * verdict alone.
   */
  public validate(
    options?: PromptsValidateOptions,
  ): Promise<PromptValidationResult> {
    return defaultPromptsManager().validate(this, options);
  }
}

/**
 * Public factory for `SystemPrompt`, callable directly or via its
 * `fromFile` static. Exists as a named interface so the callable signature
 * and the `fromFile` attachment travel together as one public type.
 */
export interface SystemPromptFactory {
  (
    input?: string | ReadonlyArray<SystemPromptBlockContract>,
    meta?: SystemPromptMeta,
  ): SystemPrompt;

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
  meta?: SystemPromptMeta,
): SystemPrompt {
  if (input === undefined) {
    return new SystemPrompt([], meta);
  }

  if (typeof input === "string") {
    return new SystemPrompt([new Instruction(input)], meta);
  }

  return new SystemPrompt([...input], meta);
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
 * Pass a second `meta` argument to name the prompt — a named prompt
 * auto-registers in `ai.prompts` under `name@version` (version defaults to the
 * next integer). Forks (`.persona()`, `.instruction()`, `.merge()`) are
 * anonymous unless re-named via `.meta({ name })`.
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
