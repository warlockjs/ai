import type { Usage } from "../contracts/result/usage.type";
import type {
  AudioInput,
  TranscribeOptions,
  TranscriptionModelContract,
  TranscriptionModelPricing,
  TranscriptionResponse,
  TranscriptionSegment,
} from "../contracts/transcription-model.contract";

/** One scripted response for a {@link MockTranscriptionModel}. */
export type MockTranscriptionResponse = {
  text?: string;
  segments?: TranscriptionSegment[];
  durationSeconds?: number;
  usage?: Usage;
  error?: Error;
  delay?: number;
};

/** One recorded `transcribe()` invocation, for test assertions. */
export type MockTranscriptionCall = { audio: AudioInput; options: TranscribeOptions | undefined };

/** Deterministic {@link TranscriptionModelContract} double for tests — no HTTP. */
export class MockTranscriptionModel implements TranscriptionModelContract {
  public readonly provider = "mock";
  public readonly calls: MockTranscriptionCall[] = [];

  private callIndex = 0;

  public constructor(
    public readonly name: string,
    private readonly responses: MockTranscriptionResponse[],
    public readonly pricing?: TranscriptionModelPricing,
  ) {}

  public async transcribe(
    audio: AudioInput,
    options?: TranscribeOptions,
  ): Promise<TranscriptionResponse> {
    this.calls.push({ audio, options });

    const response = this.responses[Math.min(this.callIndex, this.responses.length - 1)] ?? {};
    this.callIndex += 1;

    if (response.delay) {
      await new Promise((resolve) => setTimeout(resolve, response.delay));
    }
    if (response.error) {
      throw response.error;
    }

    return {
      text: response.text ?? "mock transcript",
      ...(response.segments ? { segments: response.segments } : {}),
      ...(response.durationSeconds !== undefined
        ? { durationSeconds: response.durationSeconds }
        : {}),
      usage: response.usage ?? { input: 0, output: 0, total: 0 },
    };
  }
}
