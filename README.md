# @warlock.js/ai

Provider-agnostic core for building AI agents, tools, workflows, and supervisors in TypeScript.

```bash
yarn add @warlock.js/ai @warlock.js/ai-openai @warlock.js/seal
```

> `@warlock.js/seal` is the recommended schema library — it provides Standard Schema V1 interop and JSON Schema export used by the OpenAI adapter for native structured output. Any other Standard Schema library (Zod, Valibot, …) works too.

## What it gives you

- **Agents** — bounded trip loop, automatic tool dispatch, capability-aware (vision, structured output)
- **Tools** — thin wrapper around an async function with schema-validated input
- **System prompts** — composable, immutable builder with mustache placeholders
- **Structured output** — Standard Schema V1 validation; native enforcement on capable providers, soft fallback elsewhere
- **Self-repair** — opt-in re-ask when the model produces invalid JSON
- **Image attachments** — typed `ContentPart[]` plumbing; capability-gated so unsupported models fail loudly
- **Streaming** — async iterable + `stream.result` promise + handler map
- **Pluggable adapters** — all five first-party adapters ship: `@warlock.js/ai-openai`, `-anthropic`, `-bedrock`, `-google`, `-ollama`

## 30-line example

```ts
import { ai } from "@warlock.js/ai";
import { OpenAISDK } from "@warlock.js/ai-openai";
import { v } from "@warlock.js/seal";

const openai = new OpenAISDK({ apiKey: process.env.OPENAI_API_KEY! });

const weatherInput = v.object({
  city: v.string().required(),
});

const weatherTool = ai.tool({
  name: "getWeather",
  description: "Get the current weather for a city",
  input: weatherInput,
  execute: async ({ city }) => fetchWeather(city),
});

const myAgent = ai.agent({
  model: openai.model({ name: "gpt-4o-mini" }),
  systemPrompt: ai.systemPrompt()
    .persona("You are a concise weather assistant.")
    .instruction("Always respond in {{language|English}}."),
  tools: [weatherTool],
});

const result = await myAgent.execute("What's the weather in Cairo?", {
  placeholders: { language: "Arabic" },
  on: { "agent.tool.called": ({ name, output }) => console.log(`${name} →`, output) },
});

console.log(result.text);
console.log("Tokens:", result.usage.total);
```

## Documentation

Full docs live on the Warlock site: **<https://warlock.js.org/v/latest/ai/>**

- [Your first agent](https://warlock.js.org/v/latest/ai/getting-started/04-your-first-agent/) — five-minute walkthrough
- [Run agent](https://warlock.js.org/v/latest/ai/the-basics/run-agent/) — execute, stream, attachments, structured output, repair
- [Define tools](https://warlock.js.org/v/latest/ai/the-basics/define-tools/) — typed validated functions the model can call
- [Run a workflow](https://warlock.js.org/v/latest/ai/digging-deeper/run-workflow/) — durable, resumable pipelines
- [Run a supervisor](https://warlock.js.org/v/latest/ai/digging-deeper/run-supervisor/) — multi-intent routing
- [Reference](https://warlock.js.org/v/latest/ai/reference/api/) — every public export

## License

MIT
