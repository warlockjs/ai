import type { Placeholders } from "../contracts/placeholders.type";
import type {
  SystemPromptBlockContract,
  SystemPromptContract,
  SystemPromptMeta,
} from "../contracts/system-prompt.contract";
import { InvalidRequestError } from "../errors";
import { Instruction } from "../system-prompt/instruction";
import { Persona } from "../system-prompt/persona";
import { SystemPrompt } from "../system-prompt/system-prompt";
import type {
  PromptsManagerContract,
  PromptsManagerEntry,
  PromptsManagerRegisterOptions,
} from "./prompts-manager.contract";
import type {
  ExportedPromptVersion,
  ExportedRegistry,
  PromptDiff,
  PromptDiffBlock,
  PromptJudgeCacheLike,
  PromptsManagerOptions,
  PromptTemplateVersion,
  PromptValidateTarget,
  PromptValidationResult,
  PromptsValidateOptions,
} from "./prompts-manager.type";
import {
  describeContractTarget,
  findMissingPlaceholders,
  findUnreferencedRequired,
  judgePromptBodyCached,
} from "./prompts-validate";

/**
 * Build the `name@version` registry key. Centralized so the duplicate check,
 * `get`, and `composedFrom` provenance all agree on one label shape.
 */
export function promptKey(name: string, version: string): string {
  return `${name}@${version}`;
}

/**
 * Serialize a prompt's observable content — its ordered blocks (discriminator
 * + raw template text) — into a stable signature. Two prompts with the same
 * blocks in the same order share a signature, which is how `register()` tells
 * an idempotent re-registration from a genuine clash. Meta is intentionally
 * excluded: provenance / description should not defeat idempotency.
 */
function contentSignature(contract: SystemPromptContract): string {
  return JSON.stringify(
    contract.blocks.map(block => [block.type, block.text]),
  );
}

/**
 * Reconstruct a block from its `{ type, text }` snapshot — `persona` blocks
 * become a `Persona`, everything else an `Instruction`. The inverse of the
 * flattening `export()` performs, so an imported registry resolves identically.
 */
function blockFromSnapshot(block: PromptDiffBlock): SystemPromptBlockContract {
  return block.type === "persona"
    ? new Persona(block.text)
    : new Instruction(block.text);
}

/**
 * Narrow a {@link PromptTemplateVersion} body to its ordered block list: a raw
 * string becomes one instruction block; an explicit block list is used verbatim.
 */
function blocksFromTemplate(
  template: string | readonly SystemPromptBlockContract[],
): SystemPromptBlockContract[] {
  if (typeof template === "string") {
    return [new Instruction(template)];
  }

  return [...template];
}

/**
 * Concrete `PromptsManagerContract` — a single registry of named, versioned
 * `SystemPromptContract` builders keyed by `name@version`.
 *
 * **Role.** The store behind `ai.prompts`. It holds one flat
 * `Map<string, PromptsManagerEntry>` keyed by `name@version`, plus a monotonic
 * counter that stamps each entry's `addedAt` so "latest" is deterministic
 * (highest `addedAt` for a name) without ever reading the wall clock.
 *
 * **Responsibility.**
 * - Owns: the registry map, the `addedAt` counter, the duplicate /
 *   idempotency rule, default version derivation, latest selection, the
 *   per-version tag pins, and the validate / diff / export / import surface.
 * - Does NOT own: prompt rendering (delegated to the contract's `resolve()`),
 *   block composition, or the LLM-judge mechanics (delegated to the eval
 *   `judge` scorer via `prompts-validate`).
 *
 * Users construct via the `prompts()` factory — `new PromptsManager()` is not
 * the public API.
 */
class PromptsManager implements PromptsManagerContract {
  /** Flat registry keyed by `name@version`. */
  private readonly entries = new Map<string, PromptsManagerEntry>();

  /** First-seen order of names, for a stable `list()`. */
  private readonly names: string[] = [];

  /** Per-name tag pins: `name` → (`tag` → `version`). */
  private readonly pins = new Map<string, Map<string, string>>();

  /** Optional process-level judge-verdict memo (absent ⇒ judge always runs live). */
  private readonly judgeCache?: PromptJudgeCacheLike;

  /** Monotonic insertion counter — the deterministic stand-in for a timestamp. */
  private counter = 0;

  public constructor(options: PromptsManagerOptions = {}) {
    this.judgeCache = options.judgeCache;
  }

  public register(
    contract: SystemPromptContract,
    options: PromptsManagerRegisterOptions = {},
  ): PromptsManagerContract {
    const meta = contract.meta();
    // An explicit override (from define() / import()) wins over the contract's
    // own meta — it lets those bulk paths register an anonymous contract under
    // a name without the SystemPrompt constructor's default-manager auto-reg.
    const name = options.name ?? meta?.name;

    if (!name) {
      throw new InvalidRequestError(
        "Cannot register a prompt without a name — set meta.name via " +
          "systemPrompt(input, { name }) or .meta({ name }).",
        { context: { meta } },
      );
    }

    const version =
      options.version ?? meta?.version ?? this.nextVersion(name);
    const key = promptKey(name, version);
    const existing = this.entries.get(key);

    if (existing) {
      // Idempotent re-registration: identical content under the same
      // name@version is a no-op, not an error. Anything else is a clash.
      if (contentSignature(existing.contract) === contentSignature(contract)) {
        return this;
      }

      throw new InvalidRequestError(
        `A different prompt is already registered as "${key}".`,
        { context: { name, version } },
      );
    }

    if (!this.names.includes(name)) {
      this.names.push(name);
    }

    this.entries.set(key, {
      name,
      version,
      addedAt: this.counter++,
      contract,
      ...(options.tags ? { tags: options.tags } : {}),
    });

    return this;
  }

  public create(
    input?: string | ReadonlyArray<SystemPromptBlockContract>,
    meta?: SystemPromptMeta,
  ): SystemPromptContract {
    // Mirror `systemPromptFactory` exactly (no import — `system-prompt.ts`
    // already depends on this module, so importing its factory back here would
    // close an import cycle). A name in `meta` auto-registers into the
    // process-wide default manager via the SystemPrompt constructor.
    if (input === undefined) {
      return new SystemPrompt([], meta);
    }

    if (typeof input === "string") {
      return new SystemPrompt([new Instruction(input)], meta);
    }

    return new SystemPrompt([...input], meta);
  }

  public get(name: string, versionOrTag?: string): SystemPromptContract {
    return this.requireEntry(name, versionOrTag).contract;
  }

  public has(name: string, versionOrTag?: string): boolean {
    const { baseName, selector } = this.parseSelector(name, versionOrTag);

    if (selector !== undefined) {
      return this.resolveSelector(baseName, selector) !== undefined;
    }

    return this.latestEntry(baseName) !== undefined;
  }

  public list(): string[] {
    return [...this.names];
  }

  public versions(name: string): string[] {
    return [...this.entries.values()]
      .filter(entry => entry.name === name)
      .sort((a, b) => a.addedAt - b.addedAt)
      .map(entry => entry.version);
  }

  public resolve(
    name: string,
    versionOrTag?: string,
    placeholders?: Placeholders,
  ): string {
    return this.requireEntry(name, versionOrTag).contract.resolve(placeholders);
  }

  public define(
    name: string,
    versions: readonly PromptTemplateVersion[],
  ): PromptsManagerContract {
    for (const entry of versions) {
      const blocks = blocksFromTemplate(entry.template);
      // Anonymous contract (no name in meta ⇒ no SystemPrompt constructor
      // auto-registration into the default manager); the name/version are
      // supplied explicitly so define() targets only THIS manager.
      const contract = new SystemPrompt(blocks);

      this.register(contract, { name, version: entry.version });
    }

    return this;
  }

  public tag(
    name: string,
    tag: string,
    version: string,
  ): PromptsManagerContract {
    // Validate the target exists before pinning — a tag to a missing version is
    // an authoring mistake, not a silent dangling pin.
    if (!this.entries.has(promptKey(name, version))) {
      throw new InvalidRequestError(
        `Cannot tag "${tag}" — no prompt registered as "${promptKey(
          name,
          version,
        )}".`,
        { context: { name, tag, version } },
      );
    }

    const nameTags = this.pins.get(name) ?? new Map<string, string>();
    nameTags.set(tag, version);
    this.pins.set(name, nameTags);

    return this;
  }

  public async validate(
    target: PromptValidateTarget,
    options: PromptsValidateOptions = {},
  ): Promise<PromptValidationResult> {
    const { text, required } = this.describeTarget(target);

    const provided = new Set(Object.keys(options.placeholders ?? {}));
    const declared = new Set<string>([
      ...required,
      ...(options.declare ?? []),
    ]);

    const missing = findMissingPlaceholders(text, provided, declared);

    // A declared-required key that the body never references is itself a
    // defect — surface it as an issue (it does not affect `missing` / `ok`,
    // which track unresolved placeholders).
    const unreferenced = findUnreferencedRequired(text, required);

    const ok = missing.length === 0;

    if (!options.judge) {
      if (unreferenced.length === 0) {
        return { ok, missing };
      }

      return {
        ok,
        missing,
        issues: unreferenced.map(
          key => `Required key "${key}" is never referenced in the prompt.`,
        ),
      };
    }

    // Per-call cache override wins over the manager-level memo.
    const cache = options.judgeCache ?? this.judgeCache;
    const judgeOutcome = await judgePromptBodyCached(text, options.judge, cache);

    const issues = [
      ...unreferenced.map(
        key => `Required key "${key}" is never referenced in the prompt.`,
      ),
      ...judgeOutcome.issues,
    ];

    return {
      ok,
      missing,
      ...(judgeOutcome.score !== undefined ? { score: judgeOutcome.score } : {}),
      issues,
    };
  }

  public diff(name: string, from: string, to: string): PromptDiff {
    const fromBlocks = this.snapshotBlocks(this.requireExact(name, from));
    const toBlocks = this.snapshotBlocks(this.requireExact(name, to));

    const added: PromptDiffBlock[] = [];
    const removed: PromptDiffBlock[] = [];
    const changed: { from: PromptDiffBlock; to: PromptDiffBlock }[] = [];

    const max = Math.max(fromBlocks.length, toBlocks.length);

    for (let index = 0; index < max; index++) {
      const left = fromBlocks[index];
      const right = toBlocks[index];

      if (left && !right) {
        removed.push(left);
        continue;
      }

      if (!left && right) {
        added.push(right);
        continue;
      }

      if (left && right && (left.type !== right.type || left.text !== right.text)) {
        changed.push({ from: left, to: right });
      }
    }

    return {
      name,
      from,
      to,
      added,
      removed,
      changed,
      identical:
        added.length === 0 && removed.length === 0 && changed.length === 0,
    };
  }

  public export(): ExportedRegistry {
    return {
      prompts: this.names.map(name => ({
        name,
        versions: this.versions(name).map(version =>
          this.exportVersion(name, version),
        ),
      })),
    };
  }

  public import(snapshot: ExportedRegistry): PromptsManagerContract {
    for (const exported of snapshot.prompts) {
      for (const version of exported.versions) {
        const blocks = version.blocks.map(blockFromSnapshot);
        // Anonymous (no `name` in meta) so the SystemPrompt constructor does
        // not auto-register into the default manager; description / required
        // ride along for round-trip fidelity. Name/version are explicit so the
        // import lands only on THIS manager.
        const contract = new SystemPrompt(blocks, {
          ...(version.description ? { description: version.description } : {}),
          ...(version.required ? { required: version.required } : {}),
        });

        this.register(contract, {
          name: exported.name,
          version: version.version,
        });

        for (const tag of version.tags ?? []) {
          this.tag(exported.name, tag, version.version);
        }
      }
    }

    return this;
  }

  /**
   * Flatten a registered version into its portable `{ version, blocks, tags?,
   * description?, required? }` snapshot for `export()`.
   */
  private exportVersion(name: string, version: string): ExportedPromptVersion {
    const entry = this.requireExact(name, version);
    const meta = entry.contract.meta();
    const tags = this.tagsForVersion(name, version);

    return {
      version,
      blocks: this.snapshotBlocks(entry),
      ...(tags.length > 0 ? { tags } : {}),
      ...(meta?.description ? { description: meta.description } : {}),
      ...(meta?.required ? { required: [...meta.required] } : {}),
    };
  }

  /** Every tag currently pinned to a specific `name@version`, in pin order. */
  private tagsForVersion(name: string, version: string): string[] {
    const nameTags = this.pins.get(name);

    if (!nameTags) {
      return [];
    }

    const tags: string[] = [];

    for (const [tag, pinnedVersion] of nameTags) {
      if (pinnedVersion === version) {
        tags.push(tag);
      }
    }

    return tags;
  }

  /** Flatten an entry's blocks to `{ type, text }` snapshots. */
  private snapshotBlocks(entry: PromptsManagerEntry): PromptDiffBlock[] {
    return entry.contract.blocks.map(block => ({
      type: block.type,
      text: block.text,
    }));
  }

  /**
   * Resolve the body + declared-required keys for any `validate` target: a
   * registered name (or `name@selector`), a `SystemPromptContract` instance, or
   * a raw string.
   */
  private describeTarget(target: PromptValidateTarget): {
    text: string;
    required: readonly string[];
  } {
    if (typeof target === "string") {
      // An inline `name@selector` (or a bare registered name) resolves through
      // the registry; anything else is a raw prompt body validated verbatim.
      const { baseName, selector } = this.parseSelector(target, undefined);
      const entry = selector
        ? this.resolveSelector(baseName, selector)
        : this.latestEntry(baseName);

      if (entry) {
        return describeContractTarget(entry.contract);
      }

      return { text: target, required: [] };
    }

    if (isSystemPromptContract(target)) {
      return describeContractTarget(target);
    }

    if (isBlock(target)) {
      return { text: target.text, required: [] };
    }

    throw new InvalidRequestError(
      "validate() target must be a registered name, a SystemPromptContract, " +
        "a prompt block, or a raw string.",
      { context: { target } },
    );
  }

  /**
   * The next integer version label for a name — `"1"` for the first, then the
   * count of existing versions plus one. String-typed to match the free-form
   * `version` label shape.
   */
  private nextVersion(name: string): string {
    const count = [...this.entries.values()].filter(
      entry => entry.name === name,
    ).length;

    return String(count + 1);
  }

  /** Pick the highest-`addedAt` entry for a name, or `undefined` when absent. */
  private latestEntry(name: string): PromptsManagerEntry | undefined {
    let latest: PromptsManagerEntry | undefined;

    for (const entry of this.entries.values()) {
      if (entry.name !== name) {
        continue;
      }

      if (!latest || entry.addedAt > latest.addedAt) {
        latest = entry;
      }
    }

    return latest;
  }

  /**
   * Split a name argument into its base name + optional selector. The selector
   * comes from the explicit second argument when present, else from an inline
   * `name@selector` in the first argument. A bare name yields no selector.
   */
  private parseSelector(
    name: string,
    versionOrTag: string | undefined,
  ): { baseName: string; selector: string | undefined } {
    if (versionOrTag !== undefined) {
      return { baseName: name, selector: versionOrTag };
    }

    const at = name.indexOf("@");

    if (at > 0) {
      return { baseName: name.slice(0, at), selector: name.slice(at + 1) };
    }

    return { baseName: name, selector: undefined };
  }

  /**
   * Resolve a selector (a version label OR a pinned tag) to a concrete entry.
   * Version labels win over tags when both could match — the explicit label is
   * the more specific intent. Returns `undefined` when neither resolves.
   */
  private resolveSelector(
    name: string,
    selector: string,
  ): PromptsManagerEntry | undefined {
    const byVersion = this.entries.get(promptKey(name, selector));

    if (byVersion) {
      return byVersion;
    }

    const pinnedVersion = this.pins.get(name)?.get(selector);

    if (pinnedVersion !== undefined) {
      return this.entries.get(promptKey(name, pinnedVersion));
    }

    return undefined;
  }

  /**
   * Resolve an entry by name (+ optional version / tag / inline selector),
   * throwing {@link InvalidRequestError} when the name or the requested
   * selector is unknown. The single lookup path `get` / `resolve` share.
   */
  private requireEntry(
    name: string,
    versionOrTag?: string,
  ): PromptsManagerEntry {
    const { baseName, selector } = this.parseSelector(name, versionOrTag);

    if (selector !== undefined) {
      const entry = this.resolveSelector(baseName, selector);

      if (!entry) {
        throw new InvalidRequestError(
          `No prompt registered as "${baseName}" with version/tag "${selector}".`,
          { context: { name: baseName, selector } },
        );
      }

      return entry;
    }

    const latest = this.latestEntry(baseName);

    if (!latest) {
      throw new InvalidRequestError(
        `No prompt registered under name "${baseName}".`,
        { context: { name: baseName } },
      );
    }

    return latest;
  }

  /**
   * Resolve a name + EXACT version label to its entry (no tag fallback), for
   * `diff` / `export` where a concrete version is always required. Throws
   * {@link InvalidRequestError} on a miss.
   */
  private requireExact(name: string, version: string): PromptsManagerEntry {
    const entry = this.entries.get(promptKey(name, version));

    if (!entry) {
      throw new InvalidRequestError(
        `No prompt registered as "${promptKey(name, version)}".`,
        { context: { name, version } },
      );
    }

    return entry;
  }
}

/**
 * Narrow an arbitrary value to a `SystemPromptContract` — true when it exposes
 * the builder surface (`blocks` array + a callable `resolve`) AND a callable
 * `meta`. Robust across duplicate package copies (no `instanceof`).
 */
function isSystemPromptContract(
  value: unknown,
): value is SystemPromptContract {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { blocks?: unknown }).blocks) &&
    typeof (value as { resolve?: unknown }).resolve === "function" &&
    typeof (value as { meta?: unknown }).meta === "function"
  );
}

/**
 * Narrow an arbitrary value to a single `SystemPromptBlockContract` — true when
 * it carries a string `type` + `text` and a callable `resolve` but is NOT a
 * full prompt (no `blocks` array). Lets `validate` accept a lone block.
 */
function isBlock(value: unknown): value is SystemPromptBlockContract {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { text?: unknown }).text === "string" &&
    typeof (value as { resolve?: unknown }).resolve === "function"
  );
}

/**
 * Create a new, isolated prompts manager.
 *
 * **Role.** Public factory for {@link PromptsManagerContract} — keeps
 * user-facing code free of `new` and consistent with the other `ai.*`
 * factories. Each call returns a fresh registry, so parallel test suites and
 * multi-tenant apps never share mutable global prompt state.
 *
 * The process-wide instance that named `systemPrompt(...)` builders
 * auto-register into is `ai.prompts` (see {@link defaultPromptsManager}).
 *
 * @param options - Optional wiring, notably a `judgeCache` that memoizes
 *   LLM-judge verdicts (absent ⇒ every judge pass runs live).
 *
 * @example
 * const registry = prompts();
 * registry.register(systemPrompt("You are support.", { name: "support" }));
 * registry.resolve("support"); // "You are support."
 *
 * @example
 * // Memoize judge verdicts across validations.
 * const registry = prompts({ judgeCache: new MemoryCacheDriver() });
 */
export function prompts(options?: PromptsManagerOptions): PromptsManagerContract {
  return new PromptsManager(options);
}

/**
 * The process-wide default manager that named prompts auto-register into.
 *
 * Held as a module-level singleton (lazily created on first access) so
 * `system-prompt.ts` can register a named builder without importing the
 * `PromptsManager` class — keeping the auto-registration seam free of a
 * runtime import cycle.
 */
let defaultManager: PromptsManagerContract | undefined;

/** Accessor for the process-wide default {@link PromptsManagerContract}. */
export function defaultPromptsManager(): PromptsManagerContract {
  if (!defaultManager) {
    defaultManager = new PromptsManager();
  }

  return defaultManager;
}
