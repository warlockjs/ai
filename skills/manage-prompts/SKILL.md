---
name: manage-prompts
description: 'Unified prompt registry — ai.prompts: one process-wide store of named, versioned systemPrompt(...) builders keyed by name@version. Register by giving a prompt a meta.name (auto-registers), resolve by get(name) / resolve(name, versionOrTag, placeholders) / the inline name@selector form, bulk-register with define(name, versions), pin tags with tag(name, tag, version), compare with diff(name, from, to), round-trip with export() / import(snapshot), and quality-check with a unified validate(target, options) (deterministic missing-placeholder check + optional Nova-safe LLM-as-judge with verdict caching). Compose registered prompts into new ones with systemPrompt().merge(name, { fromVersion }) — provenance recorded in meta.composedFrom. ai.prompt is now a thin FACADE over ai.prompts (BREAKING vs the old standalone registry). Triggers: `ai.prompts`, `ai.prompt`, `PromptsManagerContract`, `PromptsManagerEntry`, `SystemPromptContract`, `SystemPromptMeta`, `SystemPromptMergeOptions`, `PromptsValidateOptions`, `PromptValidationResult`, `PromptValidateTarget`, `PromptTemplateVersion`, `PromptDiff`, `ExportedRegistry`, `defaultPromptsManager`, `prompts()`, `promptKey`, `meta`, `name`, `version`, `composedFrom`, `fromVersion`, `register`, `create`, `get`, `has`, `list`, `versions`, `resolve`, `define`, `tag`, `validate`, `diff`, `export`, `import`, `merge`, `judge`, `judgeCache`, `criteria`; ''register a prompt by name'', ''resolve a prompt by name@version or tag'', ''pin a production tag to a prompt version'', ''diff two prompt versions'', ''export / import the prompt registry'', ''validate a prompt for missing placeholders'', ''validate a prompt against my own criteria / rules'', ''merge a registered prompt into another''; typical import `import { ai } from "@warlock.js/ai"`. Skip: composing a single prompt from persona + instruction blocks (the builder itself) — `@warlock.js/ai/write-system-prompt/SKILL.md`; runtime loadable skill bodies — `@warlock.js/ai/use-runtime-skills/SKILL.md`; eval scoring of agent outputs — `@warlock.js/ai/eval-datasets-and-ci/SKILL.md`; competing libs `langfuse` (direct), `promptfoo`.'
---

# `ai.prompts` — the unified prompt registry

`ai.prompts` is ONE process-wide registry of named, versioned `systemPrompt(...)` builders keyed by `name@version`. A `systemPrompt(input, { name })` (or any `.meta({ name })` rename) auto-registers here; `ai.prompts.get(name)` / `.resolve(name)` read them back; `systemPrompt().merge(name)` folds a registered prompt into a new one. There is exactly **one storage shape** behind the whole prompt surface — a `SystemPromptContract` keyed by `name@version` — and `ai.prompt(...)` is now a thin facade over it (see the migration note below).

```ts
import { ai } from "@warlock.js/ai";

// Register: any named systemPrompt auto-registers in ai.prompts.
ai.systemPrompt("You are support for {{product}}.", { name: "support" });

// Resolve back — latest version, or a version / pinned tag.
ai.prompts.get("support");                 // → the SystemPromptContract
ai.prompts.resolve("support", undefined, { product: "Warlock" }); // → final string
```

`ai.prompts` is the process-wide default (`defaultPromptsManager()`). For an **isolated** registry (parallel test suites, multi-tenant apps) call the `prompts()` factory — same `PromptsManagerContract`, its own store, no global side effects.

## Identity — `SystemPromptMeta` (`meta.name` / `version` / `description` / `required` / `composedFrom`)

A prompt's identity rides on its `meta`. Read it with the no-argument accessor; update it immutably with the one-argument form:

```ts
const base = ai.systemPrompt("You are support.", {
  name: "support",
  version: "1",
  description: "Tier-1 support persona.",
  required: ["product"],
});

base.meta();                          // → { name: "support", version: "1", description, required }
const v2 = base.meta({ version: "2" }); // new builder, shallow-merged meta; original untouched
```

- **`name`** — when present, the prompt auto-registers in `ai.prompts` under `name@version`. Anonymous prompts (no `name`) are never registered.
- **`version`** — free-form label (`"1"`, `"2025-draft"`). Defaults to the **next integer** for that name when omitted.
- **`description`** — human-readable purpose (carried through `export`).
- **`required`** — placeholder keys callers must supply; `validate()` reads them.
- **`composedFrom`** — deterministic source labels a prompt was merged from (e.g. `["base@2", "global@1"]`). No random suffixes — the same merge always yields the same labels.

## Register / resolve — `register` / `get` / `resolve` / `has` / `list` / `versions`

```ts
const registry = ai.prompts;              // or prompts() for an isolated one

registry.register(ai.systemPrompt("You are support.", { name: "support" }));
registry.versions("support");             // ["1"] — version derived as next integer

registry.get("support");                  // latest SystemPromptContract
registry.get("support@1");                // inline name@selector
registry.resolve("support", "1", { product: "Warlock" }); // pick version + render in one call

registry.has("support");                  // boolean
registry.list();                          // every registered name, first-seen order
```

- **Version selection** — `get(name)` / `resolve(name)` return the **latest** by insertion order; pass a version label, a pinned tag, or fold it into the first arg as `name@selector` (`get("support@1")`, `resolve("support@production")`).
- **Duplicates** — re-registering the same `name@version` throws `InvalidRequestError` **unless** the content is byte-identical (idempotent re-registration is a no-op).
- **Unknown name / version / tag** → `InvalidRequestError`.
- `register()` throws if the prompt has no `meta.name`.

## `create()` — build + register in one entry point

`ai.prompts.create(input?, meta?)` is a documented alias of `ai.systemPrompt(...)` — identical input forms (no arg → empty builder; a string → one instruction; an array of blocks → verbatim). Pass `meta.name` to auto-register, so authoring and lookup read side-by-side:

```ts
ai.prompts.create("You are support for {{product}}.", { name: "support" });
ai.prompts.resolve("support", undefined, { product: "Warlock" });
```

## `define()` — bulk-register many versions

```ts
ai.prompts.define("agent", [
  { version: "1", template: "You are v1." },
  { version: "2", template: [ai.persona("You are Alex."), ai.instruction("Be concise.")] },
]);
```

A `PromptTemplateVersion`'s `template` is a raw string (wrapped into one instruction block) or an explicit ordered block list (verbatim). Versions register **oldest-first** in array order; the same duplicate / idempotency rule applies per `name@version`. Returns the manager for chaining.

## `tag()` — pin a moving label to a version

```ts
ai.prompts.tag("agent", "production", "2");   // pin "production" → version 2

ai.prompts.get("agent", "production");        // resolves through the tag
ai.prompts.resolve("agent", "production");
ai.prompts.get("agent@production");           // inline form
```

Re-pinning an existing tag moves it. An unknown name / version throws `InvalidRequestError`. Tags survive `export` / `import`.

## `validate()` — unified deterministic + optional LLM-judge

```ts
const report = await ai.prompts.validate("support", {
  placeholders: { product: "Warlock" }, // values you intend to supply
  declare: ["language"],                  // extra keys to treat as known
  judge: judgeModel,                      // optional — turns on the LLM-as-judge pass
  criteria: [                             // optional — YOUR rules, replaces the built-in rubric
    "Addresses the user by {{name}}",
    "Never gives medical advice",
    "Stays under 200 words",
  ],
});

report.ok;       // true iff no required placeholder is missing (DETERMINISTIC verdict alone)
report.missing;  // placeholder keys referenced with no default, unsupplied, undeclared
report.score;    // 0..1 — present ONLY when a judge ran and produced a usable verdict
report.issues;   // advisory judge reasons / a degrade note — present only when a judge was supplied
```

- **Always** runs the deterministic check: every `{{key}}` with no inline default that is neither supplied (`placeholders`), declared (`declare`), nor in the prompt's `meta.required` lands in `missing`; `ok` is `true` iff `missing` is empty.
- **`judge`** adds a **Nova-safe** LLM-as-judge quality pass — it **never throws** and degrades to an `issues` note (leaving `score` undefined) on failure, so a flaky judge can **never flip `ok`**.
- **`criteria`** (a string or a list of short rules) grades the prompt against **your own rules** instead of the built-in quality rubric — `score` / `issues` then reflect your criteria (a failed rule is named in `issues`). Only used when `judge` is also set; folded into the `judgeCache` key so different rules re-run. Still advisory — never flips `ok`.
- **`target`** is a registered name (or `name@selector`), a `SystemPromptContract` instance, or a raw prompt string.
- **`judgeCache`** (per-call or via the `prompts({ judgeCache })` factory option) memoizes judge verdicts by a content hash of the resolved body + the judge model id — a structural `{ get, set }` subset of `@warlock.js/cache`'s `CacheDriver`, so the cache package stays a strictly **optional** peer.

`systemPrompt().validate(options?)` is the per-builder sugar — `ai.prompts.validate(this, options)` under the hood, same result shape.

## `diff()` — block-level version diff

```ts
const diff = ai.prompts.diff("agent", "1", "2");

diff.identical;  // true when both versions have identical blocks in identical order
diff.added;      // blocks in `to` not at the same position in `from`
diff.removed;    // blocks in `from` not at the same position in `to`
diff.changed;    // [{ from, to }] — same position, type/text changed
```

Blocks are matched **positionally**. Unknown name / version → `InvalidRequestError`.

## `export()` / `import()` — portable JSON round-trip

```ts
const snapshot = ai.prompts.export();   // ExportedRegistry — every name, version, pinned tag, description/required
otherRegistry.import(snapshot);          // rehydrate (same duplicate / idempotency rule; tags restored)
```

Each version flattens to `{ type, text }` blocks so the registry round-trips without live builder instances — commit a snapshot, ship it, restore it elsewhere.

## Compose registered prompts — `systemPrompt().merge(name, { fromVersion })`

`merge` folds another prompt's blocks into a new builder (persona **replaces**, instructions **append**) and records `meta.composedFrom`:

```ts
ai.systemPrompt("Always answer in {{language|English}}.", { name: "global", version: "1" });

const supportPrompt = ai.systemPrompt("You are support for {{product}}.")
  .merge("global", { fromVersion: "1" });  // fold the registered prompt by name

supportPrompt.meta()?.composedFrom;        // ["…", "global@1"] — deterministic provenance
```

`merge` accepts three source forms: a pre-built block, another `SystemPromptContract`, or a **registered name** resolved from `ai.prompts` (latest version unless `options.fromVersion` selects another — an unknown name / version throws `InvalidRequestError`).

## `ai.prompt(...)` — now a thin facade (⚠ breaking vs the old registry)

`ai.prompt` has **two** call forms, both backed by the unified manager — there is no longer a separate prompt store:

```ts
// (a) Resolve a globally-registered prompt from ai.prompts by name.
ai.systemPrompt("You are support.", { name: "support" });
const sp = ai.prompt("support");          // → SystemPromptContract (latest)
const v1 = ai.prompt("support", "1");     // → a specific version / pinned tag

// (b) Build an ISOLATED legacy-shaped registry (PromptRegistryContract).
const reg = ai.prompt({
  prompts: [{ name: "summarizer", versions: [{ version: "1", template: "Summarize: {{text}}" }] }],
});
const resolved = reg.resolve("summarizer", { placeholders: { text } });
resolved.toSystemPrompt();                 // drop-in for ai.agent({ systemPrompt })
```

**⚠ Migration.** Before unification, `ai.prompt(...)` only built a standalone, self-contained registry with its **own private** storage. It now:

1. Adds the **string overload** `ai.prompt(name, versionOrTag?)` → resolves from the shared `ai.prompts` manager. (New capability — `ai.prompt("x")` used to be a type error.)
2. Backs the **options form** (`ai.prompt({ ... })` → `PromptRegistryContract`) by an internal `PromptsManagerContract`, so its storage shape and validation primitives are now the unified ones. The legacy method surface (`register` / `add` / `versions` / `resolve` / `validate` / `sync` + the `{ score, notes }` report shape) is **unchanged**, and each `ai.prompt({ ... })` call still returns its **own isolated** registry — no shared global state.

If you only ever called `ai.prompt({ ... })` and used the returned registry, **no code change is needed**. The new behavior is additive: prefer `ai.prompts` (the unified manager) for new code; reach for `ai.prompt({ ... })` only when you want the legacy `ResolvedPrompt` / `toSystemPrompt()` ergonomics or the optional Langfuse sync. The legacy facade's reference — `register` / `add` / `resolve(name, { version, placeholders })` / `validate` (`{ score, notes }`) / `sync()` (lazy `langfuse` peer) — is documented inline in `src/prompt/prompt.ts`.

## See also

- [`@warlock.js/ai/write-system-prompt/SKILL.md`](@warlock.js/ai/write-system-prompt/SKILL.md) — the `systemPrompt()` / `persona()` / `instruction()` builder, `.meta()`, and `merge()` this registry stores and composes
- [`@warlock.js/ai/refine-prompts/SKILL.md`](@warlock.js/ai/refine-prompts/SKILL.md) — `systemPrompt().refined({ model, criteria, store })`, the prompt compiler; register its `refinePrompt()` output as a next version to `diff` original vs refined
- [`@warlock.js/ai/eval-datasets-and-ci/SKILL.md`](@warlock.js/ai/eval-datasets-and-ci/SKILL.md) — the eval `judge` scorer `validate()`'s LLM pass reuses
- [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md) — wiring a resolved prompt into an agent, plus the judge-safe agent preset (`ai.agent.judge`)
