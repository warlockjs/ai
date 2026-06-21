---
name: write-system-prompt
description: 'Compose system prompts via ai.systemPrompt() / ai.persona() / ai.instruction() — immutable builders with {{placeholder}} substitution, plus ai.systemPrompt.fromFile(path) to seed from a file read once at construction. Triggers: `ai.systemPrompt`, `ai.systemPrompt.fromFile`, `ai.persona`, `ai.instruction`, `SystemPromptBlockContract`, `PersonaContract`, `InstructionContract`, `placeholders`, `{{placeholder|default}}`, `InvalidRequestError`; ''write a system prompt'', ''compose persona + instructions'', ''prompt from a file'', ''per-call prompt override'', ''mustache placeholder''; typical import `import { ai } from "@warlock.js/ai"`. Skip: agent factory wiring — `@warlock.js/ai/run-ai-agent/SKILL.md`; competing libs `langchain` `PromptTemplate`, raw f-strings.'
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

- [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md) — `systemPrompt` on factory + per-call override
- [`@warlock.js/ai/run-ai-workflow/SKILL.md`](@warlock.js/ai/run-ai-workflow/SKILL.md) — per-step agent references inherit their own system prompt
