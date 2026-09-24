---
name: write-system-prompt
description: 'Compose system prompts via ai.systemPrompt() / ai.persona() / ai.instruction() — immutable builders with {{placeholder}} substitution, plus ai.systemPrompt.fromFile(path) to seed from a file read once at construction. Carry identity with .meta({ name, version, description, required }) (a name auto-registers in ai.prompts) and compose with merge(...blocks) / merge(contract) / merge(name, { fromVersion }) (provenance in meta.composedFrom). Triggers: `ai.systemPrompt`, `ai.systemPrompt.fromFile`, `ai.persona`, `ai.instruction`, `SystemPromptBlockContract`, `SystemPromptContract`, `SystemPromptMeta`, `SystemPromptMergeOptions`, `PersonaContract`, `InstructionContract`, `meta`, `merge`, `composedFrom`, `fromVersion`, `placeholders`, `{{placeholder|default}}`, `InvalidRequestError`; ''write a system prompt'', ''compose persona + instructions'', ''prompt from a file'', ''name and version a prompt'', ''merge prompts together'', ''per-call prompt override'', ''mustache placeholder''; typical import `import { ai } from "@warlock.js/ai"`. Skip: the named/versioned prompt registry (register / resolve / tag / diff / export / validate) — `@warlock.js/ai/manage-prompts/SKILL.md`; agent factory wiring — `@warlock.js/ai/run-ai-agent/SKILL.md`; competing libs `langchain` `PromptTemplate`, raw f-strings.'
---

# System prompts — immutable builders

Three factories — `ai.systemPrompt()`, `ai.persona()`, `ai.instruction()` — compose into the `systemPrompt` option accepted by every agent / workflow step.

## The namespace

```ts
import { ai } from "@warlock.js/ai";

ai.systemPrompt();                  // empty — chain .persona(), .instruction() onto it
ai.systemPrompt("literal text");    // one-shot string form
ai.systemPrompt([block1, block2]);  // array form — blocks render in declaration order
ai.systemPrompt.fromFile(path);     // seed from a file read once at construction

ai.persona(text);                   // PersonaContract block
ai.instruction(text);               // InstructionContract block
```

## Two shapes, same result

### String form — one-shot

```ts
ai.agent({
  model,
  systemPrompt: "You are a concise senior TypeScript engineer.",
});
```

### Builder form — composable

```ts
const prompt = ai.systemPrompt()
  .persona("You are Alex, a senior TypeScript engineer.")
  .instruction("Explain things assuming the reader is a Go developer.")
  .instruction("Always cite the relevant TypeScript handbook section.");

const myAgent = ai.agent({ model, systemPrompt: prompt });
```

### Array form — explicit order

```ts
ai.systemPrompt([
  ai.persona("You are Alex, a TypeScript expert."),
  ai.instruction("Respond in {{language|English}}."),
]);
```

### From a file — `ai.systemPrompt.fromFile(path)`

Read a prompt template from disk ONCE, synchronously, at construction. The file's UTF-8 contents seed one instruction block — so `{{placeholders}}` inside the file resolve at `resolve()` time and the result forks with further `.persona()` / `.instruction()` calls:

```ts
const prompt = ai.systemPrompt.fromFile("./prompts/support-agent.md");
const localized = prompt.instruction("Respond in {{language|English}}.");
localized.resolve({ language: "Arabic" });
```

One-shot by design (never re-read on `resolve()`). Throws `InvalidRequestError` when the file can't be read — a path typo fails loudly at construction instead of silently producing an empty prompt. `ai.systemPrompt.fromFile(path)` === `SystemPrompt.fromFile(path)`.

## Block ordering

`SystemPrompt` stores `blocks: readonly SystemPromptBlockContract[]` — not separate persona + instructions fields. Rendering honors insertion order.

- **Chained `.persona(x)`** — replaces the existing persona in place, or prepends when none exists. Default persona-first layout.
- **Chained `.instruction(y)`** — appends.
- **Array form** — verbatim.

## Immutability — safe forking

Every mutation returns a **new** `SystemPrompt`. The original is never touched:

```ts
const base = ai.systemPrompt().persona(alex).instruction(cite);
const arabic = base.instruction("Prefer Arabic comments");

// base still has 2 blocks, arabic has 3. Neither affects the other.
```

`Persona` and `Instruction` follow the same rule — their `text` is `readonly`.

## Mustache placeholders

`{{key}}` and `{{key|defaultValue}}` substitute at render time:

```ts
const prompt = ai.systemPrompt()
  .persona("You are Alex, a TypeScript expert.")
  .instruction("Respond in {{language|English}}.");

await myAgent.execute("Why use generics?", {
  placeholders: { language: "Arabic" },
});
```

Or set defaults on the agent — per-call values override them:

```ts
ai.agent({ model, systemPrompt: prompt, placeholders: { language: "Arabic" } });
```

Substitution works on the **rendered** concatenation of every block, so `{{key}}` inside a persona and inside an instruction both resolve against the same placeholder bag.

## Identity + composition — `.meta()` and `merge()`

A prompt carries optional `SystemPromptMeta` — `{ name?, version?, description?, required?, composedFrom? }`. Read it with the no-argument accessor; update it immutably with the one-argument form. **Giving a prompt a `name` auto-registers it in the `ai.prompts` registry** (keyed by `name@version`):

```ts
const base = ai.systemPrompt("You are support.", { name: "support", version: "1" });
base.meta();                       // → { name: "support", version: "1" }
const v2 = base.meta({ version: "2" }); // new builder; original untouched; re-registers under support@2
```

`merge(...)` folds blocks from another source into a **new** builder — a persona **replaces**, instructions **append**:

```ts
// (a) N pre-built blocks in one call
const p = ai.systemPrompt().merge(ai.persona("You are Alex."), ai.instruction("Be concise."));

// (b) another prompt contract — its blocks fold in; meta.composedFrom records provenance
const merged = ai.systemPrompt("Be terse.").merge(otherPrompt);
merged.meta()?.composedFrom;       // deterministic source labels, e.g. ["base@2"]

// (c) a registered prompt resolved from ai.prompts by name (latest, or a pinned fromVersion)
const composed = ai.systemPrompt("You are support.").merge("global", { fromVersion: "1" });
```

The name / contract / registry-name forms are the registry's composition surface — full coverage (register / resolve / version / tag / diff / validate) in [`@warlock.js/ai/manage-prompts/SKILL.md`](@warlock.js/ai/manage-prompts/SKILL.md).

`.validate(options?)` is per-builder sugar over `ai.prompts.validate(this, options)` — the deterministic missing-placeholder check plus an optional Nova-safe LLM-judge.

## Per-call overrides

Replace the agent's system prompt for a single run:

```ts
await myAgent.execute(input, { systemPrompt: alternativePrompt });
```

Useful for A/B testing, request-scoped personalization, or turn-by-turn prompt variation.

## Tagged discriminator (not `instanceof`)

All blocks implement `SystemPromptBlockContract { readonly type: string; readonly text; resolve() }`. Runtime discrimination uses the string `type` tag (`"persona"`, `"instruction"`, future kinds) — **not** `instanceof`.

Why: `instanceof` breaks across duplicate package copies (different `node_modules` trees), realms, bundler scopes.

## Pattern — forking a base prompt

```ts
const base = ai.systemPrompt()
  .persona("You are a support agent for Acme Corp.")
  .instruction("Cite policy §{{policy}} when denying a refund.");

const enterprise = base.instruction("Escalate immediately for Enterprise customers.");
const trial = base.instruction("Offer a 14-day extension before closing the ticket.");
```

Three distinct prompts, one common foundation. Base is immutable — safe to share.

## See also

- [`@warlock.js/ai/manage-prompts/SKILL.md`](@warlock.js/ai/manage-prompts/SKILL.md) — the `ai.prompts` registry these named prompts auto-register into (resolve / version / tag / diff / export / validate)
- [`@warlock.js/ai/refine-prompts/SKILL.md`](@warlock.js/ai/refine-prompts/SKILL.md) — `.refined({ model, criteria, store })`, the prompt compiler: lazily rewrite this builder into a model-optimized version, pinned like a lockfile
- [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md) — `systemPrompt` on factory + per-call override
- [`@warlock.js/ai/run-ai-workflow/SKILL.md`](@warlock.js/ai/run-ai-workflow/SKILL.md) — per-step agent references inherit their own system prompt
