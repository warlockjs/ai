import type {
  GeneratedAudio,
  SpeechModelContract,
  SpeechModelPricing,
} from "../contracts/speech-model.contract";
import type { BaseReport } from "../contracts/result/base-report.type";
import { REPORT_SCHEMA_VERSION } from "../contracts/result/base-report.type";
import type { ExecuteResult } from "../contracts/result/execute-result.type";
import type { ModelPricing } from "../contracts/result/model-pricing.type";
import type { Usage } from "../contracts/result/usage.type";
import { AIError } from "../errors/ai-error";
import { ProviderError } from "../errors/provider-error";
import type { FlowObserveOption } from "../observe/resolve-observers";
import { notifyObservers } from "../observe/resolve-observers";
import { computeCost } from "../utils/compute-cost";
import { generateRunId } from "../utils/generate-run-id";
import { stampReportLineage } from "../utils/stamp-report-lineage";

/** Parameters for {@link speech}. `model` comes from `sdk.speech({ name })`. */
export type SpeechParams = {
  /** The TTS model to synthesize with. */
  model: SpeechModelContract;
  /** The text to speak. */
  text: string;
  /** Voice id/name; overrides the model's default voice. */
  voice?: string;
  /** Output container (`"mp3"` / `"opus"` / `"aac"` / `"flac"` / `"wav"` / `"pcm"`). */
  format?: string;
  /** Playback speed multiplier. */
  speed?: number;
  /** Extra tone/delivery steering (model-dependent). */
  instructions?: string;
  /** Cancellation handle. */
  signal?: AbortSignal;
  /** Observability routing — same `observe` seam as agents. */
  observe?: FlowObserveOption;
  /** Groups this call into a session for flat cost/trace queries. */
  sessionId?: string;
  /** Report node name (defaults to `"speech"`). */
  name?: string;
  /** Provider-specific options forwarded verbatim to the adapter. */
  options?: Record<string, unknown>;
};

/** Success payload of a {@link speech} run. */
export type SpeechData = {
  /** The synthesized audio, normalized to the discriminated shape. */
  audio: GeneratedAudio;
};

/** The report node a {@link speech} run produces (`type: "speech"`). */
export type SpeechReport = BaseReport & {
  type: "speech";
  /** Identity of the TTS model this run used. */
  model: { name: string; provider: string };
  /** Number of input characters synthesized (0 on failure). */
  characters: number;
};

/** Result envelope of {@link speech} — the uniform `{ data, error, usage, report }`. */
export type SpeechResult = ExecuteResult<SpeechData> & {
  type: "speech";
  report: SpeechReport;
};

/**
 * Synthesize speech from text — the text-to-speech verb of the
 * output-modality track (Theme I), sibling to `ai.image()`. Wraps a
 * {@link SpeechModelContract} (from `openai.speech(...)`) in the
 * framework's uniform result contract:
 *
 * - **Never throws.** Provider failures surface as a typed `AIError` on
 *   `result.error`; `result.data` is then `undefined`.
 * - **Cost-truth.** `result.usage.cost` is filled per-character
 *   (`tts-1`) or per-token (`gpt-4o-mini-tts`), folding into the same
 *   `Usage.cost` rollup as text.
 * - **Observable.** The completed {@link SpeechReport} routes to any
 *   registered `Observer` (panoptic, OTel, …) via the `observe` seam.
 *
 * @example
 * const openai = new OpenAISDK({ apiKey });
 * const { data, error } = await ai.speech({
 *   model: openai.speech({ name: "tts-1", voice: "alloy" }),
 *   text: "Your order has shipped.",
 *   format: "mp3",
 * });
 * if (!error) await fs.writeFile("ship.mp3", Buffer.from(data.audio.base64, "base64"));
 */
export async function speech(params: SpeechParams): Promise<SpeechResult> {
  const { model, text } = params;

  const runId = generateRunId("speech");
  const startedAt = new Date().toISOString();
  const startPerf = performance.now();

  const usage: Usage = { input: 0, output: 0, total: 0 };
  let data: SpeechData | undefined;
  let error: AIError | undefined;
  let status: SpeechReport["status"] = "completed";
  let characters = 0;

  try {
    const response = await model.generate(text, {
      voice: params.voice,
      format: params.format,
      speed: params.speed,
      instructions: params.instructions,
      signal: params.signal,
      ...params.options,
    });

    Object.assign(usage, response.usage);
    characters = response.characters;

    if (usage.cost === undefined) {
      const cost = computeSpeechCost(usage, characters, model.pricing);
      if (cost !== undefined) {
        usage.cost = cost;
      }
    }

    data = { audio: response.audio };
  } catch (thrown) {
    error =
      thrown instanceof AIError ? thrown : new ProviderError(toMessage(thrown), { cause: thrown });
    status = params.signal?.aborted ? "cancelled" : "failed";
  }

  const report: SpeechReport = {
    runId,
    rootRunId: runId,
    name: params.name ?? "speech",
    type: "speech",
    status,
    error,
    startedAt,
    endedAt: new Date().toISOString(),
    duration: performance.now() - startPerf,
    usage,
    children: [],
    model: { name: model.name, provider: model.provider },
    characters,
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
  };

  stampReportLineage(report, { rootRunId: runId, sessionId: params.sessionId });

  await notifyObservers(params.observe, report);

  return { type: "speech", data, error, usage, report };
}

/**
 * Price a TTS run: `perMillionCharacters × characters` (per-character
 * metering, attributed to `cost.input`) wins when configured, otherwise
 * the standard token math. Returns `undefined` when no usable pricing
 * is present.
 */
function computeSpeechCost(
  usage: Usage,
  characters: number,
  pricing: SpeechModelPricing | undefined,
): ModelPricing | undefined {
  if (!pricing) {
    return undefined;
  }

  if (pricing.perMillionCharacters !== undefined) {
    return { input: (characters * pricing.perMillionCharacters) / 1_000_000, output: 0 };
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
