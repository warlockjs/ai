---
description: "Provider-agnostic LLM toolkit: agents, tools, teams, workflows, RAG, memory, guardrails. Exports `ai`, `agent`, `tool`, `team`, `workflow`, `planner`, `supervisor`, `orchestrator`, `rag`, `memory`, `systemPrompt`, `humanApproval`, `guard`. Use for: call an LLM, build an AI agent, give it tools, run a multi-agent team, chain steps, RAG over documents, embed text, generate images or speech, transcribe audio, approve tool calls, redact PII, replay model calls, run evals. Not this package: web/HTTP/MCP tools → @warlock.js/ai-tools; file+shell agents → @warlock.js/ai-workspace; tracing → @warlock.js/ai-panoptic; model adapters → ai-openai, ai-anthropic, other ai-<provider> packages."
---
# @warlock.js/ai

The core AI package. Everything hangs off the `ai` facade (`ai.agent`, `ai.tool`, `ai.team`, `ai.rag`, ...) and the same factories are exported standalone. An agent is one model plus a system prompt plus tools; the other runners compose agents. Model access comes from a provider package (`ai-openai`, `ai-anthropic`, ...), never from this one. Sibling packages (`ai-tools`, `ai-workspace`, `ai-panoptic`) attach themselves onto `ai` on import.

## The 80% path
1. Read `ai-basics.md`, configure a provider (`pick-ai-provider.md`), and write a prompt (`write-system-prompt.md`).
2. Build an agent (`run-ai-agent.md`); give it typed tools (`define-ai-tool.md`).
3. Compose when one agent is not enough: `run-ai-workflow.md` (fixed steps), `run-supervisor.md` (routing), `run-ai-team.md`, `run-planner.md`.
4. Add safety: `guard-input-output.md`, `approve-tool-calls.md`, `secure-outbound-requests.md`, `handle-ai-errors.md`.
5. Make it durable and observable: `run-orchestrator.md`, `durable-agent-runs.md`, `observe-ai-flows.md`.
6. Test it: `record-replay-llm.md`, `eval-datasets-and-ci.md`.

## Topics by area
- **Foundations and agents:** ai-basics, pick-ai-provider, run-ai-agent, write-system-prompt, refine-prompts, manage-prompts, attach-ai-middleware, ai-dx-helpers
- **Tools:** define-ai-tool
- **Composition:** run-ai-workflow, run-supervisor, run-ai-team, run-planner, run-orchestrator
- **Knowledge and memory:** run-ai-rag, rag-loaders-and-stores, embed-text, use-ai-memory, use-runtime-skills
- **Safety and human control:** guard-input-output, detect-and-redact-pii, escalate-block-to-human, approve-tool-calls, durable-resume, secure-outbound-requests, handle-ai-errors
- **Durability and storage:** durable-agent-runs, manage-ai-stores, persist-ai-data
- **Modalities:** generate-images, generate-speech, transcribe-audio
- **Observability and testing:** observe-ai-flows, log-ai-calls, record-replay-llm, eval-datasets-and-ci

## Conventions and pitfalls
- `ai-tools`, `ai-workspace`, `ai-panoptic` extend `ai` by side-effect import; import the package once before using `ai.tools.*`, `ai.mcp`, `ai.workspace`.
- Errors all extend `AIError`; branch on the typed subclass, not the message.
- Persistence goes through `@warlock.js/cache`; checkpoints and snapshots are different stores.
- Human approval and durable resume need a persistent interrupt store when approval happens in another process.
- `registerAiMatchers` lazy-loads `vitest`; only call it from tests.
