---
name: use-runtime-skills
description: 'Progressive-disclosure agent skills with ai.skills({...}) and the first-class `skills` option on ai.agent — an always-injected cheap metadata catalog plus an on-demand loadSkill tool, backed by directory / url / store sources. Covers inject ("all" | {select:"semantic",topK,embedder}), maxLoadsPerRun, scope tags, the MockSkillsStore, semantic preload, and the inert-by-default Phase-2 self-authoring (saveSkill + default-DENY review gate → promote). Triggers: `ai.skills`, `SkillsConfig`, `SkillsContract`, `SkillSource`, `SkillInjectMode`, `SkillRecord`, `SkillCatalogEntry`, `loadSkill`, `loadSkillTool`, `saveSkill`, `saveSkillTool`, `SkillReviewGate`, `runReviewGate`, `MockSkillsStore`, `proceduralSkillStore`, `maxLoadsPerRun`, `inject`, `scope`, `review`, the agent `skills:` option; ''give an agent loadable skills'', ''progressive disclosure of instructions'', ''catalog of skills the model pulls on demand'', ''semantic preload of skill bodies'', ''let an agent author and review a skill''; typical import `import { ai } from "@warlock.js/ai"`. Skip: composing static system prompts — `@warlock.js/ai/write-system-prompt/SKILL.md`; durable agent memory tiers — `@warlock.js/ai/use-ai-memory/SKILL.md`; defining callable tools — `@warlock.js/ai/define-ai-tool/SKILL.md`.'
---

# `ai.skills()` — runtime skills with progressive disclosure

A **skill is text injected into an agent's context — it never runs code.** `ai.skills(config)` builds a `SkillsContract`: the mechanism behind the first-class `skills` agent option. The agent always injects a cheap **metadata catalog** (one line per in-scope skill) and registers a `loadSkill` tool so the model pulls a skill's full **body** only when it needs it (progressive disclosure). Bodies are withheld until loaded — keeping context lean.

## The first-class agent option (the supported way)

```ts
import { ai } from "@warlock.js/ai";

const agent = ai.agent({
  model: openai.model({ name: "gpt-4o" }),
  systemPrompt: "You are a build assistant.",
  skills: {                                   // a SkillsConfig OR an ai.skills(...) instance
    name: "build-skills",
    sources: [{ type: "directory", path: "./agent-skills" }],
  },
});
```

When `skills` is set the agent owns the runtime flow at execute time: it **prepends the always-injected catalog** (and, under `inject`, the preloaded bodies) in front of your system prompt, auto-registers `loadSkill` (plus `saveSkill` only when a `review` gate is configured), and threads the run id so `maxLoadsPerRun` is enforced per execution. **Omitted ⇒ no skills behavior; the agent runs byte-for-byte as today.** The option accepts a raw `SkillsConfig` (the agent passes it to `skills()` for you) or a pre-built `SkillsContract`.

## Factory config — `SkillsConfig`

```ts
const lib = ai.skills({
  name: "build-skills",                        // surfaced in analytics + the catalog block
  sources: [{ type: "directory", path: "./agent-skills" }], // >= 1; later source wins on name clash
  inject: { select: "semantic", topK: 2, embedder },        // body-injection policy (see below)
  maxLoadsPerRun: 4,                           // cap on loadSkill calls per run. default 5
  scope: { tags: ["frontend"] },               // only skills whose tags intersect are catalogued
  review: { approve, store },                  // Phase 2 — absent ⇒ saveSkill is NOT exposed
  analytics: (event) => track(event),          // optional efficacy sink (errors swallowed)
});
```

### Sources — `SkillSource` (discriminated by `type`, never `kind`)

- `{ type: "directory", path }` — reads `path/<folder>/SKILL.md` off disk (lazy `node:fs/promises`).
- `{ type: "url", url, headers? }` — `fetch()`es a JSON manifest of skills.
- `{ type: "store", store }` — any `SkillsStoreContract`, e.g. `MockSkillsStore`.

Sources merge in order; a later source wins on a name collision.

### Injection — `inject` (`SkillInjectMode`)

The metadata catalog is **always** injected (it's cheap). `inject` controls whether any **bodies** are auto-injected up front:

- **omitted** (default) — inject NO bodies; the model pulls them via `loadSkill`. Pure progressive disclosure.
- `"all"` — inject every body up front (small libraries only).
- `{ select: "semantic", topK, embedder?, threshold? }` — embed the run input, rank the catalog by cosine similarity, inject the top-`topK` bodies. Needs an embedder (passed here, or lazily auto-resolved).

## `SkillsContract` surface

```ts
interface SkillsContract {
  readonly name: string;
  catalog(scopeInput?: string): Promise<SkillCatalogEntry[]>;  // cheap metadata, body omitted
  catalogPrompt(scopeInput?: string): Promise<string>;          // catalog rendered as a system block
  preload(input: string): Promise<SkillRecord[]>;               // bodies per `inject`; [] when omitted
  tools(runId?: string): AgentToolEntry<any, any>[];            // loadSkill always; saveSkill iff review
}
```

A `SkillCatalogEntry` is `Pick<SkillRecord, "name"|"description"|"version"|"tags"|"type">` — the **structural omission of `body`** is the type-level guarantee the catalog never carries skill bodies. A `SkillRecord` adds the full `body` plus `type: "authored" | "promoted" | "candidate"`.

## `maxLoadsPerRun` — a budget, not a throw

`loadSkill` calls are capped per run (default 5). Exhaustion is an **error RESULT the model self-corrects from**, never a throw — the tool returns `{ error }` and the loop continues. `runId` scopes both the budget and analytics correlation.

## Stores

```ts
import { ai, MockSkillsStore } from "@warlock.js/ai";

const store = new MockSkillsStore([
  { name: "scaffold", description: "Scaffold a form", version: 1, body: "...", type: "authored" },
]);
const lib = ai.skills({ name: "build", sources: [{ type: "store", store }] });
```

`MockSkillsStore` is an in-memory `SkillsStoreContract` that ships with the package (construct via `new` — it is a concrete test/utility store, not a factory-fronted primitive). It holds the latest record per name, filters out `candidate`s from `list()` / `load()`, and exposes `saveCandidate` / `promote`. `proceduralSkillStore` is also exported (unifies proven procedural memories with named skills).

## Phase 2 — self-authoring (inert by default)

Self-authoring is **gated and OFF unless a `review` gate is wired**:

- Without `review`, the `saveSkill` tool is **never registered** — a candidate can never be written, let alone injected.
- With `review: { approve, store }`, `saveSkill` writes an **INERT** `type: "candidate"` (`version: 0`), filtered out of every catalog/load until promoted.
- The `SkillReviewGate.approve(candidate)` is **default-DENY**: only `{ approve: true }` promotes the candidate to a new audited version (`promote` → `type: "promoted"`, `version + 1`). Anything else — `{ approve: false }`, a malformed result, or a **throw** (fail-closed) — keeps it inert. `runReviewGate(candidate, gate, emit?)` runs this and never throws (a throwing gate is a denial), emitting `promoted` / `denied` analytics events.

The three interchangeable approve shapes — a policy fn, a validator agent, a human callback — all reduce to one `Promise<{ approve: boolean; reason? }>`.

## Analytics

The optional `analytics` sink fires `catalogued` / `loaded` / `used` / `saved` / `promoted` / `denied` events `{ type, skill, version, runId?, outcome? }`. Errors from the sink are swallowed (mirroring the agent's `onUsage` / `onComplete`), so analytics never crash a run.

## See also

- [`@warlock.js/ai/write-system-prompt/SKILL.md`](@warlock.js/ai/write-system-prompt/SKILL.md) — static persona / instruction blocks (vs. dynamic loaded skills)
- [`@warlock.js/ai/use-ai-memory/SKILL.md`](@warlock.js/ai/use-ai-memory/SKILL.md) — the procedural memory tier `proceduralSkillStore` unifies with
- [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md) — the agent the `skills` option attaches to
