import { agent } from "../agent/agent";
import type { AgentConfig } from "../agent/agent-config.type";
import type { AgentContract } from "../contracts/agent/agent.contract";
import type { ToolContract } from "../tool/tool";
import type { MockModelResponse } from "./mock-config.type";
import { MockSDK } from "./mock-sdk";

/**
 * Test helper that wires `MockSDK` → mock model → `agent()` in one call.
 *
 * Replaces the 4-line ritual specs typically write:
 * ```ts
 * const mock = MockSDK({ responses: [...] });
 * const myAgent = agent({ name: "x", model: mock.model({ name: "m" }) });
 * ```
 *
 * Defaults to a single empty `"stop"` response — enough to exercise an
 * agent that doesn't need a scripted reply (composition wiring,
 * anonymous-name tests, etc.). Pass `responses` to script outputs.
 *
 * `name` is optional — when omitted the resulting agent runs through
 * the normal anonymous-name fingerprint
 * (`anon_<provider>_<model>[_<tool1>+<tool2>...]`), which is the
 * default for `agent({ model })`.
 *
 * @example
 * const a = mockAgent({ name: "writer", responses: [{ content: "hi", finishReason: "stop" }] });
 * const result = await a.execute("anything");
 */
export function mockAgent<TOutput = unknown>(
  options: {
    name?: string;
    responses?: MockModelResponse[];
    tools?: ToolContract<unknown, unknown>[];
    /**
     * Override the model name reported by the mock model. Defaults to
     * `"mock-model"` (the MockSDK default). Useful when a test needs
     * deterministic provider/model fingerprinting.
     */
    modelName?: string;
  } = {},
): AgentContract<TOutput> {
  const responses = options.responses ?? [{ content: "", finishReason: "stop" as const }];
  const sdk = MockSDK({ responses });
  const model = sdk.model({ name: options.modelName ?? "mock-model" });

  const config: AgentConfig<TOutput> = { model };

  if (options.name !== undefined) {
    config.name = options.name;
  }

  if (options.tools !== undefined) {
    config.tools = options.tools;
  }

  return agent<TOutput>(config);
}
