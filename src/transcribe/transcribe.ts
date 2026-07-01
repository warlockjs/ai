import type { BaseReport } from "../contracts/result/base-report.type";
import { REPORT_SCHEMA_VERSION } from "../contracts/result/base-report.type";
import type { ExecuteResult } from "../contracts/result/execute-result.type";
import type { ModelPricing } from "../contracts/result/model-pricing.type";
import type { Usage } from "../contracts/result/usage.type";
import type {
  AudioInput,
  TranscriptionModelContract,
  TranscriptionModelPricing,
  TranscriptionSegment,
} from "../contracts/transcription-model.contract";
import { AIError } from "../errors/ai-error";
import { ProviderError } from "../errors/provider-error";
import type { FlowObserveOption } from "../observe/resolve-observers";
import { notifyObservers } from "../observe/resolve-observers";
import { computeCost } from "../utils/compute-cost";
import { generateRunId } from "../utils/generate-run-id";
import { stampReportLineage } from "../utils/stamp-report-lineage";

/** Parameters for {@link transcribe}. `model` comes from `sdk.transcribe({ name })`. */
export type TranscribeParams = {
  /** The STT model to transcribe with. */
  model: TranscriptionModelContract;
  /** The audio to transcribe (inlined base64 bytes + media type). */
  audio: AudioInput;
  /** BCP-47 language hint. */
  language?: string;
  /** Optional priming prompt (spelling/style hints). */
  prompt?: string;
  /** Provider response-format override (e.g. `"verbose_json"`). */
  format?: string;
  /** Cancellation handle. */
  signal?: AbortSignal;
  /** Observability routing — same `observe` seam as agents. */
  observe?: FlowObserveOption;
  /** Groups this call into a session for flat cost/trace queries. */
  sessionId?: string;
  /** Report node name (defaults to `"transcription"`). */
  name?: string;
  /** Provider-specific options forwarded verbatim to the adapter. */
  options?: Record<string, unknown>;
};

/** Success payload of a {@link transcribe} run. */
export type TranscriptionData = {
  /** The full transcript text. */
  text: string;
  /** Timestamped segments when the provider returned them. */
  segments?: TranscriptionSegment[];
};

/** The report node a {@link transcribe} run produces (`type: "transcription"`). */
export type TranscriptionReport = BaseReport & {
  type: "transcription";
  /** Identity of the STT model this run used. */
  model: { name: string; provider: string };
  /** Input audio duration in seconds, when the provider reported it. */
  durationSeconds?: number;
};

/** Result envelope of {@link transcribe} — the uniform `{ data, error, usage, report }`. */
export type TranscriptionResult = ExecuteResult<TranscriptionData> & {
  type: "transcription";
  report: TranscriptionReport;
};

/**
 * Transcribe audio to text — the speech-to-text verb of the
 * output-modality track (Theme I), inverse of `ai.speech()`. Wraps a
 * {@link TranscriptionModelContract} (from `openai.transcribe(...)`) in
 * the uniform result contract:
 *
 * - **Never throws.** Provider failures surface as a typed `AIError` on
 *   `result.error`.
 * - **Cost-truth.** `result.usage.cost` is filled per-minute
 *   (`whisper-1`) or per-token (`gpt-4o-transcribe`).
 * - **Observable.** The completed {@link TranscriptionReport} routes to
 *   any registered `Observer` via the `observe` seam.
 *
 * @example
 * const openai = new OpenAISDK({ apiKey });
 * const { data, error } = await ai.transcribe({
 *   model: openai.transcribe({ name: "whisper-1" }),
 *   audio: { base64, mediaType: "audio/mpeg", filename: "voicemail.mp3" },
 *   language: "en",
 * });
 * if (!error) console.log(data.text);
 */
export async function transcribe(params: TranscribeParams): Promise<TranscriptionResult> {
  const { model, audio } = params;

  const runId = generateRunId("transcription");
  const startedAt = new Date().toISOString();
  const startPerf = performance.now();

  const usage: Usage = { input: 0, output: 0, total: 0 };
  let data: TranscriptionData | undefined;
  let error: AIError | undefined;
  let status: TranscriptionReport["status"] = "completed";
  let durationSeconds: number | undefined;

  try {
    const response = await model.transcribe(audio, {
      language: params.language,
      prompt: params.prompt,
      format: params.format,
      signal: params.signal,
      ...params.options,
    });

    Object.assign(usage, response.usage);
    durationSeconds = response.durationSeconds;

    if (usage.cost === undefined) {
      const cost = computeTranscriptionCost(usage, durationSeconds, model.pricing);
      if (cost !== undefined) {
        usage.cost = cost;
      }
    }

    data = { text: response.text, ...(response.segments ? { segments: response.segments } : {}) };
  } catch (thrown) {
    error =
      thrown instanceof AIError ? thrown : new ProviderError(toMessage(thrown), { cause: thrown });
    status = params.signal?.aborted ? "cancelled" : "failed";
  }

  const report: TranscriptionReport = {
    runId,
    rootRunId: runId,
    name: params.name ?? "transcription",
    type: "transcription",
    status,
    error,
    startedAt,
    endedAt: new Date().toISOString(),
    duration: performance.now() - startPerf,
    usage,
    children: [],
    model: { name: model.name, provider: model.provider },
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
  };

  stampReportLineage(report, { rootRunId: runId, sessionId: params.sessionId });

  await notifyObservers(params.observe, report);

  return { type: "transcription", data, error, usage, report };
}

/**
 * Price an STT run: `perMinute × (durationSeconds / 60)` (per-minute
 * metering, attributed to `cost.input`) wins when configured, otherwise
 * the standard token math. Returns `undefined` when no usable pricing
 * is present (e.g. per-minute pricing but the provider didn't report a
 * duration).
 */
function computeTranscriptionCost(
  usage: Usage,
  durationSeconds: number | undefined,
  pricing: TranscriptionModelPricing | undefined,
): ModelPricing | undefined {
  if (!pricing) {
    return undefined;
  }

  if (pricing.perMinute !== undefined) {
    if (durationSeconds === undefined) {
      return undefined;
    }
    return { input: (durationSeconds / 60) * pricing.perMinute, output: 0 };
  }

  if (pricing.input !== undefined && pricing.output !== undefined) {
    return computeCost(usage, { input: pricing.input, output: pricing.output });
  }

  return undefined;
}

/** Best-effort message for a non-`AIError` thrown value. */
function toMessage(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
