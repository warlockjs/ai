import type {
  GeneratedAudio,
  SpeechGenerationResponse,
  SpeechModelContract,
  SpeechModelPricing,
  SpeechOptions,
} from "../contracts/speech-model.contract";
import type { Usage } from "../contracts/result/usage.type";

/** One scripted response for a {@link MockSpeechModel}. */
export type MockSpeechResponse = {
  audio?: GeneratedAudio;
  usage?: Usage;
  /** Characters synthesized; defaults to the input text length. */
  characters?: number;
  error?: Error;
  delay?: number;
};

/** One recorded `generate()` invocation, for test assertions. */
export type MockSpeechCall = { text: string; options: SpeechOptions | undefined };

/** Deterministic {@link SpeechModelContract} double for tests — no HTTP. */
export class MockSpeechModel implements SpeechModelContract {
  public readonly provider = "mock";
  public readonly calls: MockSpeechCall[] = [];

  private callIndex = 0;

  public constructor(
    public readonly name: string,
    private readonly responses: MockSpeechResponse[],
    public readonly pricing?: SpeechModelPricing,
  ) {}

  public async generate(text: string, options?: SpeechOptions): Promise<SpeechGenerationResponse> {
    this.calls.push({ text, options });

    const response = this.responses[Math.min(this.callIndex, this.responses.length - 1)] ?? {};
    this.callIndex += 1;

    if (response.delay) {
      await new Promise((resolve) => setTimeout(resolve, response.delay));
    }
    if (response.error) {
      throw response.error;
    }

    return {
      audio: response.audio ?? { type: "base64", base64: "AAAA", mediaType: "audio/mpeg" },
      usage: response.usage ?? { input: 0, output: 0, total: 0 },
      characters: response.characters ?? text.length,
    };
  }
}
