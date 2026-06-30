import type { SystemPromptContract } from "../contracts/system-prompt.contract";
import {
  defaultPromptsManager,
  prompts as createPromptsManager,
} from "../prompts/prompts-manager";
import type { PromptsManagerContract } from "../prompts/prompts-manager.contract";
import { Instruction } from "../system-prompt/instruction";
import { renderPlaceholders } from "../system-prompt/render-placeholders";
import { SystemPrompt } from "../system-prompt/system-prompt";
import { PromptNotFoundError, PromptValidationError } from "./errors";
import {
  syncLangfusePrompts,
  warmLangfuse,
} from "./prompt-langfuse-sync";
import {
  buildValidationReport,
  judgePrompt,
  staticLint,
} from "./prompt-validate";
import { agent } from "../agent/agent";
import type { AgentContract } from "../contracts/agent/agent.contract";
import type { ModelContract } from "../contracts/model.contract";
import type {
  PromptEntry,
  PromptRegistryContract,
  PromptRegistryOptions,
  PromptResolveOptions,
  PromptValidateOptions,
  PromptValidationReport,
  PromptVersion,
  ResolvedPrompt,
} from "./prompt.type";

/**
 * Build the one-shot judge agent the `validate()` LLM-as-judge pass runs.
 * Name-bearing (the eval `judge` scorer requires a usable agent) and seeded
 * with a strict-JSON instruction so its verdict parses even without an output
 * schema. Kept module-private so the registry's only model dependency is the
 * `agent()` factory.
 */
function buildJudgeAgent(model: ModelContract): AgentContract<unknown> {
  return agent({
    name: "prompt-quality-judge",
    model,
    systemPrompt:
      "You are a strict prompt-quality grader. Respond with JSON only: " +
      '{ "score": <0..1>, "passed": <true|false>, "reason": "<short explanation>" }.',
  });
}

/**
 * Build the `SystemPromptContract` a single {@link PromptVersion} maps to: its
 * `template` becomes one instruction block, and its `required` keys ride along
 * as `meta.required` so the unified manager (and `validate`) can see them.
 *
 * Deliberately ANONYMOUS (no `meta.name`) so the `SystemPrompt` constructor
 * never auto-registers this version into the process-wide `ai.prompts` default
 * manager — each `prompt()` registry owns its OWN isolated
 * {@link PromptsManagerContract}, the single storage shape behind this facade.
 */
function versionToContract(version: PromptVersion): SystemPromptContract {
  return new SystemPrompt([new Instruction(version.template)], {
    ...(version.required ? { required: version.required } : {}),
  });
}

/**
 * Legacy `PromptRegistryContract` — now a THIN FACADE over the unified
 * {@link PromptsManagerContract} (`ai.prompts`).
 *
 * **Role.** The store behind `ai.prompt(...)`. Historically it held a private
 * `Map<string, PromptVersion[]>`; it now delegates ALL storage to a private,
 * per-instance {@link PromptsManagerContract}, so there is exactly ONE storage
 * shape across the whole prompt surface: a `SystemPromptContract` keyed by
 * `name@version`. A version's raw `template` string maps to a single
 * instruction block and its `required` keys to `meta.required`.
 *
 * **Responsibility.**
 * - Owns: the legacy method surface (`register` / `add` / `versions` /
 *   `resolve` / `validate` / `sync`) and the back-compat behaviors — duplicate
 *   version rejection, required-key assertion on `resolve()`, the
 *   `{ score, notes }` validation report shape, and the optional Langfuse sync.
 * - Does NOT own: the actual storage (delegated to the internal manager),
 *   placeholder rendering (delegated to `renderPlaceholders`), or the unified
 *   validation primitives (delegated to `prompt-validate`).
 *
 * Each `prompt(options)` call builds its own isolated manager — so parallel
 * test suites and multi-tenant apps never share mutable global prompt state,
 * exactly as before the unification.
 *
 * Users construct via the `prompt()` factory — `new PromptRegistry()` is not
 * the public API.
 */
class PromptRegistry implements PromptRegistryContract {
  /** The single backing store — one isolated unified manager per registry. */
  private readonly manager: PromptsManagerContract;

  /** Per-name version metadata mirror, kept so `versions()` returns the rich
   * {@link PromptVersion} shape (template + required + meta) the legacy API
   * promised — the manager itself only stores the flattened contract. */
  private readonly versionMeta = new Map<string, PromptVersion[]>();

  public constructor(private readonly options: PromptRegistryOptions = {}) {
    this.manager = createPromptsManager();

    for (const entry of options.prompts ?? []) {
      this.register(entry);
    }

    if (options.langfuse) {
      warmLangfuse(options.langfuse);
    }
  }

  /**
   * Register a whole entry. Merges onto an existing name's history; a
   * duplicate version label throws {@link PromptValidationError}.
   */
  public register(entry: PromptEntry): PromptRegistryContract {
    for (const version of entry.versions) {
      this.add(entry.name, version);
    }

    // An entry with an empty version list still creates the name so `has`
    // / `list` reflect it.
    if (!this.versionMeta.has(entry.name)) {
      this.versionMeta.set(entry.name, []);
    }

    return this;
  }

  /**
   * Add a new version to a name (creating it when absent). A duplicate
   * version label throws {@link PromptValidationError} — never a silent
   * overwrite.
   */
  public add(name: string, version: PromptVersion): PromptRegistryContract {
    const mirror = this.versionMeta.get(name) ?? [];

    if (mirror.some(existing => existing.version === version.version)) {
      throw new PromptValidationError(
        `Prompt "${name}" already has a version labeled "${version.version}".`,
        { context: { name, version: version.version } },
      );
    }

    this.manager.register(versionToContract(version), {
      name,
      version: version.version,
    });

    this.versionMeta.set(name, [...mirror, version]);

    return this;
  }

  /** Whether a name is registered. */
  public has(name: string): boolean {
    return this.versionMeta.has(name);
  }

  /** Every registered prompt name, in registration order. */
  public list(): string[] {
    return [...this.versionMeta.keys()];
  }

  /** Versions registered for a name, latest last. Throws on an unknown name. */
  public versions(name: string): PromptVersion[] {
    const mirror = this.versionMeta.get(name);

    if (!mirror) {
      throw new PromptNotFoundError(name);
    }

    return [...mirror];
  }

  /**
   * Resolve + render. Picks the requested or latest version, validates the
   * version's `required` keys against the merged placeholders, then renders by
   * delegating to the shared `renderPlaceholders` over the contract's text.
   */
  public resolve(name: string, options: PromptResolveOptions = {}): ResolvedPrompt {
    const picked = this.pickVersion(name, options.version);
    const placeholders = options.placeholders ?? {};

    this.assertRequired(name, picked, placeholders);

    // Render the RAW template (placeholders intact) against the merged values —
    // resolving the contract first would bake inline `{{key|default}}` defaults
    // in and shadow an explicitly-supplied value. The stored block text is the
    // single source of the un-rendered template.
    const contract = this.manager.get(name, picked.version);
    const template = contract.blocks[0]?.text ?? picked.template;
    const text = renderPlaceholders(template, placeholders);

    return {
      name,
      version: picked.version,
      text,
      toSystemPrompt: () => new SystemPrompt([new Instruction(text)]),
    };
  }

  /**
   * Quality-check a raw prompt body or a registered prompt (by name). Backed by
   * the unified deterministic validate primitives plus the LLM-as-judge pass,
   * but returns the legacy `{ score, notes }` report shape so existing callers
   * keep working.
   *
   * Always runs the static lint; runs the LLM-as-judge pass too when a model is
   * resolvable. Never throws when no judge model is available.
   */
  public async validate(
    textOrName: string,
    options: PromptValidateOptions = {},
  ): Promise<PromptValidationReport> {
    const text = this.resolveValidationText(textOrName, options.version);
    const staticNotes = staticLint(text);

    const model = options.model ?? this.options.judgeModel;

    if (!model) {
      return buildValidationReport(staticNotes);
    }

    const judgeResult = await judgePrompt(text, model, buildJudgeAgent);

    return buildValidationReport(staticNotes, judgeResult);
  }

  /**
   * Synchronize named prompts with Langfuse-prompts. No-op (resolves) when no
   * `langfuse` option was configured. The resolved (rendered) body + the
   * `name@version` label are what is pushed/pulled.
   */
  public async sync(): Promise<void> {
    if (!this.options.langfuse) {
      return;
    }

    await syncLangfusePrompts(
      this.options.langfuse,
      this.list(),
      this.snapshotEntries(),
      entry => this.register(entry),
    );
  }

  /**
   * Pick the requested (or latest) {@link PromptVersion} for a name from the
   * mirror, throwing {@link PromptNotFoundError} on an unknown name or version.
   */
  private pickVersion(name: string, version?: string): PromptVersion {
    const mirror = this.versionMeta.get(name);

    if (!mirror || mirror.length === 0) {
      throw new PromptNotFoundError(name);
    }

    const picked = version
      ? mirror.find(candidate => candidate.version === version)
      : mirror[mirror.length - 1];

    if (!picked) {
      throw new PromptNotFoundError(name, {
        context: { name, version },
      });
    }

    return picked;
  }

  /**
   * Resolve the text `validate()` should grade: a registered name yields its
   * picked version's raw `template`; anything else is treated as the raw body.
   */
  private resolveValidationText(textOrName: string, version?: string): string {
    const mirror = this.versionMeta.get(textOrName);

    if (!mirror || mirror.length === 0) {
      return textOrName;
    }

    const picked = version
      ? mirror.find(candidate => candidate.version === version)
      : mirror[mirror.length - 1];

    return picked ? picked.template : textOrName;
  }

  /**
   * Throw {@link PromptValidationError} listing every `required` key absent
   * from the merged placeholders. A no-op when the version declares none.
   */
  private assertRequired(
    name: string,
    version: PromptVersion,
    placeholders: Record<string, unknown>,
  ): void {
    if (!version.required || version.required.length === 0) {
      return;
    }

    const missing = version.required.filter(
      key => placeholders[key] === undefined || placeholders[key] === null || placeholders[key] === "",
    );

    if (missing.length > 0) {
      throw new PromptValidationError(
        `Prompt "${name}" version "${version.version}" is missing required placeholder${
          missing.length > 1 ? "s" : ""
        }: ${missing.join(", ")}.`,
        { context: { name, version: version.version, missing } },
      );
    }
  }

  /** Snapshot the catalog as `PromptEntry[]` (for the Langfuse push path). */
  private snapshotEntries(): PromptEntry[] {
    return [...this.versionMeta.entries()].map(([name, versions]) => ({
      name,
      versions: [...versions],
    }));
  }
}

/**
 * Create a versioned, typed prompt registry — a thin facade over the unified
 * `ai.prompts` manager.
 *
 * **Role.** Public factory for {@link PromptRegistryContract}. Keeps
 * user-facing code free of `new` and consistent with `ai.memory`,
 * `ai.orchestrator`, `ai.batch` (all return instances). Each call returns a
 * fresh, isolated registry backed by its own unified manager, so parallel test
 * suites and multi-tenant apps never share mutable global prompt state.
 *
 * @param options - Seed entries, an optional default judge model, and an
 *   optional Langfuse sync.
 *
 * @example
 * const prompts = prompt({
 *   prompts: [
 *     {
 *       name: "support-agent",
 *       versions: [
 *         { version: "1", template: "You are support for {{product}}. Reply in {{language|English}}." },
 *         { version: "2", template: "You are senior support for {{product}}.", required: ["product"] },
 *       ],
 *     },
 *   ],
 * });
 *
 * const resolved = prompts.resolve("support-agent", { placeholders: { product: "Warlock" } });
 * const agent = ai.agent({ model, systemPrompt: resolved.toSystemPrompt() });
 * // resolved.version === "2"; a missing `product` would throw PromptValidationError.
 *
 * @example
 * // Resolve a globally-registered prompt by name from `ai.prompts`.
 * ai.systemPrompt("You are support.", { name: "support" });
 * const sp = ai.prompt("support"); // → the registered SystemPromptContract
 */
function promptFactory(
  name: string,
  versionOrTag?: string,
): SystemPromptContract;
function promptFactory(options?: PromptRegistryOptions): PromptRegistryContract;
function promptFactory(
  first?: string | PromptRegistryOptions,
  versionOrTag?: string,
): SystemPromptContract | PromptRegistryContract {
  // String form: resolve a globally-registered prompt from the process-wide
  // `ai.prompts` manager (the single unified registry). This is the thin
  // facade's read path onto the shared store.
  if (typeof first === "string") {
    return defaultPromptsManager().get(first, versionOrTag);
  }

  // Options form: build an isolated registry backed by its own unified manager.
  return new PromptRegistry(first);
}

/**
 * Create a versioned prompt registry, OR resolve a globally-registered prompt
 * by name from `ai.prompts`.
 *
 * - `prompt(options?)` → a fresh, isolated {@link PromptRegistryContract}.
 * - `prompt(name, versionOrTag?)` → the `SystemPromptContract` registered under
 *   `name` in the process-wide `ai.prompts` manager (latest version by default,
 *   or a specific version / pinned tag).
 */
export const prompt: typeof promptFactory = promptFactory;
