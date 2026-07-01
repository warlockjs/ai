import type {
  GeneratedImage,
  ImageModelContract,
} from "../contracts/image-model.contract";
import type { BaseReport } from "../contracts/result/base-report.type";
import { REPORT_SCHEMA_VERSION } from "../contracts/result/base-report.type";
import type { ExecuteResult } from "../contracts/result/execute-result.type";
import type { Usage } from "../contracts/result/usage.type";
import { AIError } from "../errors/ai-error";
import { ProviderError } from "../errors/provider-error";
import type { FlowObserveOption } from "../observe/resolve-observers";
import { notifyObservers } from "../observe/resolve-observers";
import { generateRunId } from "../utils/generate-run-id";
import { stampReportLineage } from "../utils/stamp-report-lineage";
import { computeImageCost } from "./image-cost";

/**
 * Parameters for {@link image}. `model` comes from an adapter's
 * `image()` factory (`openai.image({ name })` / `google.image({ name })`);
 * the rest are provider-neutral generation knobs plus the standard
 * observability seam every verb shares.
 */
export type ImageParams = {
  /** The image model to generate from (`sdk.image({ name })`). */
  model: ImageModelContract;
  /** Text description of the image(s) to generate. */
  prompt: string;
  /** How many images to generate. Adapters clamp to the provider max. */
  count?: number;
  /** Requested pixel size as `"WxH"` (e.g. `"1024x1024"`). */
  size?: string;
  /** Quality tier (e.g. `"standard"` / `"hd"`). */
  quality?: string;
  /** Aspect ratio (e.g. `"1:1"`, `"16:9"`) — ratio-based providers (Imagen). */
  aspectRatio?: string;
  /** Concepts to steer away from (Imagen `negativePrompt`). */
  negativePrompt?: string;
  /** Output container hint (`"png"` / `"jpeg"` / `"webp"`). */
  format?: string;
  /** Cancellation handle, wired into the provider request where supported. */
  signal?: AbortSignal;
  /**
   * Observability routing for this call — same `observe` seam as
   * agents / workflows. `true` routes to the globally registered
   * observers; an `Observer` object routes flow-locally; `false` opts
   * out; omitted follows the global observe-all flag.
   */
  observe?: FlowObserveOption;
  /** Groups this call into a session for flat cost/trace queries. */
  sessionId?: string;
  /** Report node name (defaults to `"image"`). */
  name?: string;
  /** Provider-specific options forwarded verbatim to the adapter. */
  options?: Record<string, unknown>;
};

/** Success payload of an {@link image} run. */
export type ImageData = {
  /** The generated images, normalized to the discriminated shape. */
  images: GeneratedImage[];
};

/**
 * The report node an {@link image} run produces — a {@link BaseReport}
 * (`type: "image"`) plus which model ran and how many images came back,
 * so panoptic and any flat-row consumer attribute the cost/latency
 * without special-casing.
 */
export type ImageReport = BaseReport & {
  type: "image";
  /** Identity of the image model this run used. */
  model: { name: string; provider: string };
  /** Number of images returned (0 on failure). */
  imageCount: number;
};

/**
 * Result envelope of {@link image} — the same uniform
 * `{ data, error, usage, report }` every executable returns, narrowed
 * with the `"image"` discriminant.
 */
export type ImageResult = ExecuteResult<ImageData> & {
  type: "image";
  report: ImageReport;
};

/**
 * Generate one or more images from a text prompt — the image-output
 * counterpart to `ai.agent`, and the first verb of the output-modality
 * track (Theme I). Wraps an {@link ImageModelContract} (from
 * `openai.image(...)` / `google.image(...)`) in the framework's uniform
 * result contract:
 *
 * - **Never throws.** Provider failures (auth, rate-limit,
 *   content-filter, invalid request) surface as a typed `AIError` on
 *   `result.error`; `result.data` is then `undefined`.
 * - **Cost-truth.** When the model carries pricing, `result.usage.cost`
 *   is filled in — per-token for gpt-image-1, per-image for
 *   DALL·E / Imagen — folding into the same `Usage.cost` rollup as text.
 * - **Observable.** The completed {@link ImageReport} routes to any
 *   registered `Observer` (panoptic, OTel, …) via the shared `observe`
 *   seam, exactly like an agent run.
 *
 * @example
 * const openai = new OpenAISDK({ apiKey });
 * const { data, error, usage } = await ai.image({
 *   model: openai.image({ name: "gpt-image-1" }),
 *   prompt: "an isometric office desk, soft studio lighting",
 *   size: "1024x1024",
 * });
 *
 * if (error) console.warn(error.code);
 * else for (const img of data.images) save(img); // { type: "base64" | "url", ... }
 */
export async function image(params: ImageParams): Promise<ImageResult> {
  const { model, prompt } = params;

  const runId = generateRunId("image");
  const startedAt = new Date().toISOString();
  const startPerf = performance.now();

  const usage: Usage = { input: 0, output: 0, total: 0 };
  let data: ImageData | undefined;
  let error: AIError | undefined;
  let status: ImageReport["status"] = "completed";
  let imageCount = 0;

  try {
    const response = await model.generate(prompt, {
      count: params.count,
      size: params.size,
      quality: params.quality,
      aspectRatio: params.aspectRatio,
      negativePrompt: params.negativePrompt,
      format: params.format,
      signal: params.signal,
      ...params.options,
    });

    // Preserve every usage channel the adapter reported (cached /
    // reasoning / cache-write, and any adapter-supplied `cost`), mirroring
    // how the agent path routes provider usage. Then honor a pre-priced
    // response or compute image cost — `usage.cost ??= …` precedence, same
    // as the agent path.
    Object.assign(usage, response.usage);

    if (usage.cost === undefined) {
      const cost = computeImageCost(usage, response.images.length, params.size, model.pricing);
      if (cost !== undefined) {
        usage.cost = cost;
      }
    }

    data = { images: response.images };
    imageCount = response.images.length;
  } catch (thrown) {
    error = thrown instanceof AIError ? thrown : new ProviderError(toMessage(thrown), { cause: thrown });
    // A caller-aborted run is "cancelled", not "failed" — keep the typed
    // cause but distinguish the terminal status for dashboards/retry policy.
    status = params.signal?.aborted ? "cancelled" : "failed";
  }

  const report: ImageReport = {
    runId,
    rootRunId: runId,
    name: params.name ?? "image",
    type: "image",
    status,
    error,
    startedAt,
    endedAt: new Date().toISOString(),
    duration: performance.now() - startPerf,
    usage,
    children: [],
    model: { name: model.name, provider: model.provider },
    imageCount,
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
  };

  stampReportLineage(report, { rootRunId: runId, sessionId: params.sessionId });

  await notifyObservers(params.observe, report);

  return { type: "image", data, error, usage, report };
}

/** Best-effort message for a non-`AIError` thrown value. */
function toMessage(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
