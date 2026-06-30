import type { ModelContract } from "../contracts/model.contract";
import type { Placeholders } from "../contracts/placeholders.type";
import type { SystemPrompt } from "../system-prompt/system-prompt";
import type { LangfuseClientLike } from "./prompt-langfuse-sync.type";

/**
 * One immutable version of a named prompt.
 *
 * **Role.** A single addressable snapshot of a prompt body, tagged with a
 * free-form `version` label and (optionally) the placeholder keys it
 * requires. Many versions accumulate under one {@link PromptEntry} so a
 * registered prompt can evolve while older versions stay resolvable.
 *
 * The `template` uses the exact same `{{placeholder}}` syntax the shared
 * `renderPlaceholders` helper supports — `{{key}}`, `{{a.b.c}}`,
 * `{{key|default}}` — so a version's body renders identically to a
 * `systemPrompt(string)` seed.
 */
export type PromptVersion = {
  /** Monotonic version label, e.g. `"1"`, `"2"`, `"2025-06-draft"`. Free-form string. */
  version: string;
  /** The prompt body — same `{{placeholder}}` syntax `renderPlaceholders` supports. */
  template: string;
  /**
   * Placeholder keys this version requires. When set, `.resolve()` throws a
   * {@link PromptValidationError} if any are missing from the merged
   * placeholders — closing the silent-passthrough gap `renderPlaceholders`
   * leaves for an unsupplied `{{key}}`. Absent = no required-key validation.
   */
  required?: string[];
  /** Optional free-form metadata (author note, model hint, etc.). */
  meta?: Record<string, unknown>;
};

/**
 * A named prompt and its ordered version history.
 *
 * **Role.** The unit `register()` ingests and `versions()` returns. The
 * `versions` array is ordered oldest-first; the **last** entry is the
 * default resolved when no explicit `version` is requested.
 */
export type PromptEntry = {
  /** Unique name used for lookup, e.g. `"support-agent"`. */
  name: string;
  /** Ordered version history; the last entry is the default. */
  versions: PromptVersion[];
};

/**
 * Options for {@link PromptRegistryContract.resolve}.
 */
export type PromptResolveOptions = {
  /** Pick a specific version by its label. Default: the latest registered version. */
  version?: string;
  /** Values for the template's `{{placeholders}}`. */
  placeholders?: Placeholders;
};

/**
 * Outcome of {@link PromptRegistryContract.resolve} — the picked version, its
 * rendered text, and a one-call bridge to a `SystemPrompt`.
 */
export type ResolvedPrompt = {
  /** The prompt name that was resolved. */
  name: string;
  /** The version label that was picked. */
  version: string;
  /** The rendered string (placeholders substituted). */
  text: string;
  /**
   * A `SystemPrompt` seeded with the rendered text — the exact same seed
   * `systemPrompt(string)` produces (`new SystemPrompt([new Instruction(text)])`),
   * so it is a drop-in for `ai.agent({ systemPrompt })`.
   */
  toSystemPrompt(): SystemPrompt;
};

/** Severity of a single {@link PromptValidationReport} finding. */
export type PromptValidationSeverity = "info" | "warn" | "error";

/** One finding in a {@link PromptValidationReport}. */
export type PromptValidationNote = {
  /** How serious this finding is — drives the most-severe-first ordering. */
  severity: PromptValidationSeverity;
  /** Human-readable description of the finding. */
  message: string;
  /** Optional concrete rewrite/fix for this finding. */
  suggestion?: string;
};

/**
 * Result of {@link PromptRegistryContract.validate} — an overall quality
 * score plus individual findings, most severe first.
 */
export type PromptValidationReport = {
  /** Overall quality score, `0`–`1`, from the LLM-as-judge rubric + static lint. */
  score: number;
  /** Individual findings, most severe first. */
  notes: PromptValidationNote[];
};

/** Options for {@link PromptRegistryContract.validate}. */
export type PromptValidateOptions = {
  /**
   * Model that powers the LLM-as-judge pass. When omitted (and no registry
   * default `judgeModel` is set), `validate()` returns the static-lint
   * findings only — never throwing.
   */
  model?: ModelContract;
  /**
   * Validate a registered prompt's specific version (only meaningful when the
   * first argument is a registered name). Default: the latest version.
   */
  version?: string;
};

/**
 * Public surface of the prompt registry returned by `prompt(options?)`.
 *
 * **Role.** A named, versioned, typed catalog wrapping `systemPrompt` /
 * `SystemPrompt.fromFile` with `{{placeholder}}` validation, a `validate()`
 * quality check (static lint + LLM-as-judge), and an optional Langfuse sync.
 *
 * Mutating methods (`register` / `add`) return the same registry for chaining.
 */
export type PromptRegistryContract = {
  /**
   * Register a whole entry (name + its version history). Returns the registry
   * for chaining. A name registered twice merges the new versions onto the
   * existing history (duplicate version labels throw a
   * {@link PromptValidationError}).
   */
  register(entry: PromptEntry): PromptRegistryContract;
  /**
   * Add a new version to an existing name (creating the name when absent).
   * A duplicate `version` label throws a {@link PromptValidationError} —
   * never a silent overwrite.
   */
  add(name: string, version: PromptVersion): PromptRegistryContract;
  /** Whether a name is registered. */
  has(name: string): boolean;
  /** Every registered prompt name. */
  list(): string[];
  /**
   * Resolve + render. Throws {@link PromptNotFoundError} on an unknown name
   * and {@link PromptValidationError} when the picked version's `required`
   * keys are missing from the merged placeholders.
   */
  resolve(name: string, options?: PromptResolveOptions): ResolvedPrompt;
  /** Versions registered for a name, latest last. Throws {@link PromptNotFoundError} on miss. */
  versions(name: string): PromptVersion[];
  /**
   * Quality-check a prompt body (raw text) or a registered prompt (by name).
   * Runs a cheap static lint (length, undeclared/unresolved `{{placeholders}}`,
   * missing role line) PLUS, when a model is resolvable, an LLM-as-judge pass
   * over a clarity / role / output-format / conflict rubric — reusing the eval
   * `judge` scorer. With no judge model, returns the static-lint findings only
   * and never throws.
   */
  validate(
    textOrName: string,
    options?: PromptValidateOptions,
  ): Promise<PromptValidationReport>;
  /**
   * Synchronize named prompts with Langfuse-prompts. Lazily imports the
   * optional `langfuse` peer; pulls named prompts into the catalog and/or
   * pushes local versions per the configured `direction`. Throws a curated
   * install error when `langfuse` is not installed.
   */
  sync(): Promise<void>;
};

/**
 * Optional Langfuse-prompts sync configuration (see {@link PromptRegistryOptions}).
 */
export type PromptLangfuseSyncOptions = {
  /** A pre-built Langfuse client. When supplied, the SDK is never imported. */
  client?: LangfuseClientLike;
  /** Langfuse public key — used to construct a client when `client` is omitted. */
  publicKey?: string;
  /** Langfuse secret key — used to construct a client when `client` is omitted. */
  secretKey?: string;
  /** Langfuse host base URL. Optional; defaults to the SDK's own default. */
  baseUrl?: string;
  /** Sync direction. `"pull"` (default) pulls remote prompts; `"push"` pushes local; `"both"` does both. */
  direction?: "pull" | "push" | "both";
};

/**
 * Options for the `prompt(options?)` factory.
 */
export type PromptRegistryOptions = {
  /** Seed entries at construction. */
  prompts?: PromptEntry[];
  /**
   * Default model for the `validate()` LLM-as-judge pass when a call does not
   * pass its own `model`. Absent = `validate()` is static-lint-only unless a
   * per-call model is supplied.
   */
  judgeModel?: ModelContract;
  /**
   * Optional Langfuse-prompts sync. Lazily imports `langfuse`; pulls named
   * prompts on `.sync()` and (optionally) pushes local versions. Absent =
   * fully local, no network.
   */
  langfuse?: PromptLangfuseSyncOptions;
};
