import type {
  GeneratedImage,
  ImageGenerationOptions,
  ImageGenerationResponse,
  ImageModelContract,
  ImageModelPricing,
} from "../contracts/image-model.contract";
import type { Usage } from "../contracts/result/usage.type";

/** One scripted response for a {@link MockImageModel}. */
export type MockImageResponse = {
  /** Images to return; defaults to a single 1×1 transparent PNG. */
  images?: GeneratedImage[];
  /** Token usage to report; defaults to all-zero (per-image-metered). */
  usage?: Usage;
  /** Throw this instead of returning — drives the never-throws/error path. */
  error?: Error;
  /** Simulate latency before resolving/rejecting (ms). */
  delay?: number;
};

/** One recorded `generate()` invocation, for test assertions. */
export type MockImageCall = {
  prompt: string;
  options: ImageGenerationOptions | undefined;
};

/** A 1×1 transparent PNG — the default mock image payload. */
const TRANSPARENT_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/**
 * Deterministic {@link ImageModelContract} double for tests — no HTTP.
 * Scripts responses in sequence (the last repeats once exhausted),
 * records every call, and can be primed with pricing to exercise the
 * cost rollup. Mirrors {@link MockModel} for the image path.
 *
 * @example
 * const model = new MockImageModel("mock-image", [{ usage: { input: 0, output: 0, total: 0 } }], {
 *   perImage: 0.04,
 * });
 * const { data, usage } = await ai.image({ model, prompt: "a cat" });
 */
export class MockImageModel implements ImageModelContract {
  public readonly provider = "mock";
  public readonly calls: MockImageCall[] = [];

  private callIndex = 0;

  public constructor(
    public readonly name: string,
    private readonly responses: MockImageResponse[],
    public readonly pricing?: ImageModelPricing,
  ) {}

  public async generate(
    prompt: string,
    options?: ImageGenerationOptions,
  ): Promise<ImageGenerationResponse> {
    this.calls.push({ prompt, options });

    const response = this.responses[Math.min(this.callIndex, this.responses.length - 1)] ?? {};
    this.callIndex += 1;

    if (response.delay) {
      await new Promise((resolve) => setTimeout(resolve, response.delay));
    }

    if (response.error) {
      throw response.error;
    }

    const count = options?.count ?? 1;
    const images: GeneratedImage[] =
      response.images ??
      Array.from({ length: count }, () => ({
        type: "base64" as const,
        base64: TRANSPARENT_PNG_BASE64,
        mediaType: "image/png",
      }));

    return {
      images,
      usage: response.usage ?? { input: 0, output: 0, total: 0 },
    };
  }
}
