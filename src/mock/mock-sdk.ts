import type {
  ModelConfig,
  SDKAdapterContract,
} from "../contracts/sdk-adapter.contract";
import { approximateTokenCount } from "../utils/token-count";
import type { MockSDKConfig } from "./mock-config.type";
import { MockModel } from "./mock-model";

/**
 * Creates a mock SDK adapter for testing — no HTTP calls, fully configurable.
 *
 * @example
 * const mock = MockSDK({
 *   responses: [
 *     { content: "Hello from mock!" },
 *     { content: "Second response" },
 *   ],
 * });
 * const model = mock.model({ name: "gpt-4o" });
 * const result = await model.complete([{ role: "user", content: "Hi" }]);
 * console.log(result.content); // "Hello from mock!"
 */
export function MockSDK(config: MockSDKConfig = {}): SDKAdapterContract & {
  /** All model instances created by this SDK — for inspecting calls in tests */
  models: MockModel[];
} {
  const models: MockModel[] = [];
  const responses = config.responses ?? [{ content: "Mock response" }];

  return {
    models,
    model(modelConfig: ModelConfig) {
      const model = new MockModel(
        modelConfig.name ?? config.defaultModelName ?? "mock-model",
        responses,
        config.capabilities,
      );
      models.push(model);
      return model;
    },
    async count(text: string, _model?: string): Promise<number> {
      return approximateTokenCount(text);
    },
  };
}
