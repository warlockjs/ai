import type { ImageModelConfig } from "../contracts/image-model.contract";
import type {
  ModelConfig,
  SDKAdapterContract,
} from "../contracts/sdk-adapter.contract";
import type { SpeechModelConfig } from "../contracts/speech-model.contract";
import type { TranscriptionModelConfig } from "../contracts/transcription-model.contract";
import { approximateTokenCount } from "../utils/token-count";
import type { MockSDKConfig } from "./mock-config.type";
import { MockImageModel } from "./mock-image-model";
import { MockModel } from "./mock-model";
import { MockSpeechModel } from "./mock-speech-model";
import { MockTranscriptionModel } from "./mock-transcription-model";

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
  /** All image-model instances created by this SDK — for inspecting calls in tests */
  imageModels: MockImageModel[];
  /** All speech-model instances created by this SDK — for inspecting calls in tests */
  speechModels: MockSpeechModel[];
  /** All transcription-model instances created by this SDK — for inspecting calls in tests */
  transcriptionModels: MockTranscriptionModel[];
} {
  const models: MockModel[] = [];
  const imageModels: MockImageModel[] = [];
  const speechModels: MockSpeechModel[] = [];
  const transcriptionModels: MockTranscriptionModel[] = [];
  const responses = config.responses ?? [{ content: "Mock response" }];
  const imageResponses = config.imageResponses ?? [{}];
  const speechResponses = config.speechResponses ?? [{}];
  const transcriptionResponses = config.transcriptionResponses ?? [{}];

  return {
    models,
    imageModels,
    speechModels,
    transcriptionModels,
    model(modelConfig: ModelConfig) {
      const model = new MockModel(
        modelConfig.name ?? config.defaultModelName ?? "mock-model",
        responses,
        config.capabilities,
      );
      models.push(model);
      return model;
    },
    image(imageConfig: ImageModelConfig) {
      const model = new MockImageModel(
        imageConfig.name ?? config.defaultModelName ?? "mock-image-model",
        imageResponses,
        imageConfig.pricing ?? config.imagePricing,
      );
      imageModels.push(model);
      return model;
    },
    speech(speechConfig: SpeechModelConfig) {
      const model = new MockSpeechModel(
        speechConfig.name ?? config.defaultModelName ?? "mock-speech-model",
        speechResponses,
        speechConfig.pricing ?? config.speechPricing,
      );
      speechModels.push(model);
      return model;
    },
    transcribe(transcribeConfig: TranscriptionModelConfig) {
      const model = new MockTranscriptionModel(
        transcribeConfig.name ?? config.defaultModelName ?? "mock-transcription-model",
        transcriptionResponses,
        transcribeConfig.pricing ?? config.transcriptionPricing,
      );
      transcriptionModels.push(model);
      return model;
    },
    async count(text: string, _model?: string): Promise<number> {
      return approximateTokenCount(text);
    },
  };
}
