---
name: refine-prompts
description: 'Prompt compiler — systemPrompt(...).refined({ model, criteria, store }): humans keep writing human prompt text (dev code or admin-panel textareas); the refined wrapper lazily rewrites it into a model-optimized version via a refiner model on first agent use, pins the result (lockfile posture — recompiled ONLY when the source text, refiner model, criteria, or built-in recipe version change, never silently over time), and serves the pin thereafter. Explicit surfaces: await refined.refine() → the compiled template STRING (placeholders intact — for admin routes, previews, boot warmup, CI; throws PromptRefinementError on failure) and await refined.refinePrompt() → a composable SystemPromptContract with meta.refinedFrom / meta.refinerModel provenance (register it as a next version to unlock ai.prompts.diff review). Placeholder parity is machine-enforced (the exact {{placeholder}} set must survive or the rewrite is rejected after one repair re-ask); the lazy agent path NEVER throws — on refiner failure it warns once and serves the original. store is a structural { get, set } (any @warlock.js/cache CacheDriver); omitted ⇒ the pin lives on the instance for the process lifetime. Triggers: `refined`, `refine`, `refinePrompt`, `materialize`, `RefinedSystemPromptContract`, `RefinedSystemPromptOptions`, `RefinedPromptStoreLike`, `PromptRefineOptions`, `PromptRefinementError`, `refinedFrom`, `refinerModel`, `fresh`, `prompt-refiner`, ''refine a prompt'', ''compile a prompt'', ''optimize a system prompt'', ''rewrite my prompt to be AI-friendly'', ''admin-written prompts'', ''prompt refinement store''; typical import `import { ai } from "@warlock.js/ai"`. Skip: registry operations (register / resolve / tag / diff / validate) — `@warlock.js/ai/manage-prompts/SKILL.md`; composing prompts from persona + instruction blocks — `@warlock.js/ai/write-system-prompt/SKILL.md`; grading a prompt against rules without rewriting it — validate({ criteria }) in `@warlock.js/ai/manage-prompts/SKILL.md`.'
---

# `systemPrompt().refined()` — the prompt compiler

Humans write prompts as human text; models perform better on structured, model-tuned phrasing. `.refined({ model, criteria, store })` turns any `SystemPrompt` into a **lazily-compiled artifact**: the first agent use rewrites the raw source template through the refiner `model`, pins the result, and every later use serves the pin. The human text stays the editing surface forever — the refined text is a derived artifact, like a lockfile.

```ts
import { ai } from "@warlock.js/ai";

const support = ai
  .systemPrompt(
    [ai.persona("You are a friendly assistant."), ai.instruction("Help {{name}} with orders.")],
    { name: "support" },
  )
  .refined({ model: refinerModel, store: myCacheDriver });

// Lazy: compiles on the first run, serves the pin afterwards.
const agent = ai.agent({ model, systemPrompt: support });

// Explicit: compile now — admin routes, previews, boot warmup, CI.
const text = await support.refine();          // the compiled template STRING
const prompt = await support.refinePrompt();  // a composable SystemPromptContract
```

## The four trust rules

1. **Lockfile posture.** The pin key hashes the recipe version + refiner model + `criteria` + source template — any input change compiles fresh; an unchanged input NEVER recompiles (no TTL, no silent drift). `store` is a **store, not a cache**.
2. **Prose, never contract.** The exact `{{placeholder}}` set (name **and** `|default`) must survive the rewrite verbatim — checked mechanically; a parity break gets ONE repair re-ask, then the rewrite is rejected. The compiled text is still a **template**: placeholders resolve per call as usual.
3. **Advisory with fallback.** The lazy agent path never throws: a refiner failure warns once (`[warlock-ai] …`) and serves the ORIGINAL prompt — the human text is always a valid prompt. After **3** failed attempts the lazy path stops retrying for the instance lifetime (no per-run refiner latency from a broken key/provider); the explicit `refine()` / `refinePrompt()` stay live — they **throw** `PromptRefinementError` (`error.reason`: `"model"` / `"parity"` / `"empty"`) and a later success re-arms the pin for everyone.
4. **Reviewable.** `refine()` exposes the compiled text; `refinePrompt()` makes it a first-class prompt with provenance.

## `refine(options?)` — the explicit string surface

```ts
const text = await support.refine();                 // store-first; pins on first compile
const another = await support.refine({ fresh: true }); // skip the pin, new take, re-pins
```

Expose it via a route for an admin **preview / approve** flow — the admin sees original vs refined, and the call itself warms the pin so the next agent run pays nothing. Also the boot-warmup / CI-compile surface.

## `refinePrompt(options?)` — the composable surface

```ts
const compiled = await support.refinePrompt();

compiled.blocks;                 // one instruction block = the refined template
compiled.meta()?.refinedFrom;    // "support@1" (or "anonymous")
compiled.meta()?.refinerModel;   // "anthropic:claude-sonnet-4-5"
compiled.meta()?.required;       // carried from the source — contract preserved
```

It never auto-registers (no `name` — registry versions stay human-intentional). Register it deliberately to unlock the review flow:

```ts
compiled.meta({ name: "support" });          // registers as support@<next>
ai.prompts.diff("support", "1", "2");        // original vs refined, block by block
```

## Options

- **`model`** (required) — the refiner `ModelContract`. The call runs as a one-shot `"prompt-refiner"` agent, so usage/cost surface through the standard report/observer machinery.
- **`criteria`** — a string or list of rules the rewrite MUST satisfy, on top of the built-in recipe. Same word and shape as `validate({ criteria })`: *validate grades against criteria; refined rewrites against them*. Folded into the pin key — new rules compile fresh.
- **`store`** — structural `{ get, set }` (`RefinedPromptStoreLike`; any `@warlock.js/cache` `CacheDriver` satisfies it — the cache package stays an optional peer). Share a redis/pg-backed driver so ONE process pays each compilation and the fleet reads the pin. Omitted ⇒ the pin lives on the wrapper instance for the process lifetime. A pinned value that fails the parity check (corrupt / tampered store) is treated as a miss and recompiled.

## What compiles where — the lazy boundary

The lazy compile hook rides the **agent path** (`ai.agent` execute/stream, and everything built on it — supervisors' member agents, planner steps, eval, `spawnSubAgent`, `serve`). Prompts resolved **synchronously at factory time** — `ai.planner({ systemPrompt })` / `ai.router({ systemPrompt })` prefixes, a supervisor's own `systemPrompt` / `goal`, and `ai.prompts.resolve()` — use the ORIGINAL text unless you pre-warm:

```ts
await refined.refine();                       // warm the pin at boot…
const planner = ai.planner({ systemPrompt: refined, ... }); // …then factories see it? NO —
```

Factory-time resolution reads whatever is pinned **at that moment** — so warm BEFORE constructing the factory, or pass `await refined.refinePrompt()` instead (an already-compiled plain prompt).

## Chaining and identity

- `refined.meta()` reads the SOURCE meta — agent reports stamp the source `name@version`, so observability groups by the prompt you authored.
- `.persona()` / `.instruction()` / `.merge()` / `.meta({...})` derive a NEW source and re-wrap it with the same refinement options — editing a compiled prompt invalidates its pin naturally (new source ⇒ new key).
- `refined.source` is always the original builder; `refined.resolve(placeholders)` serves the compiled text once pinned, the original before.
- **Register the source or the `refinePrompt()` output — not the wrapper itself.** The wrapper's `blocks` flip from source to compiled text on materialization, so `ai.prompts.register(wrapper)` would fingerprint whatever is pinned at call time (and a re-register after the flip throws on the content mismatch).
- `validate()` on the wrapper validates what it currently serves — pair `refined` with `validate({ criteria, judge })` to lint the compiled text, and with `agent.eval` (original vs refined on a dataset) to PROVE the rewrite helps before trusting it.

## See also

- [`@warlock.js/ai/manage-prompts/SKILL.md`](@warlock.js/ai/manage-prompts/SKILL.md) — the registry (`name@version`, tags, `diff`, `validate({ criteria })`) the review flow rides on
- [`@warlock.js/ai/write-system-prompt/SKILL.md`](@warlock.js/ai/write-system-prompt/SKILL.md) — the `systemPrompt()` builder `.refined()` extends
- [`@warlock.js/ai/eval-datasets-and-ci/SKILL.md`](@warlock.js/ai/eval-datasets-and-ci/SKILL.md) — measure original vs refined behaviour on a dataset
