import type {
  GuardrailDetector,
  GuardrailMatch,
  GuardrailVerdict,
  OpenAiClientLike,
  OpenAiModerationOptions,
  OpenAiModerationResult,
} from "../contracts";
import { OPENAI_INSTALL_INSTRUCTIONS } from "../errors";

const DETECTOR_NAME = "moderation.openai";

const DEFAULT_MODEL = "omni-moderation-latest";

// ============================================================
// Lazily-loaded openai SDK (OPTIONAL peer)
// ============================================================

let OpenAiSdk: typeof import("openai");
let isModuleExists: boolean | undefined;
let loadingPromise: Promise<void> | undefined;

/**
 * Settle the lazy import of `openai` once, concurrency-safe. Only needed
 * when the caller did not pass a ready `client`. A bare `catch` flips the
 * flag to `false`; the curated {@link OPENAI_INSTALL_INSTRUCTIONS} surfaces
 * at first `check()`, never a raw module-resolution stack trace. Mirrors
 * ai-panoptic's `loadLangfuse`.
 */
function loadOpenAi(): Promise<void> {
  if (isModuleExists !== undefined) {
    return Promise.resolve();
  }

  if (loadingPromise) {
    return loadingPromise;
  }

  loadingPromise = (async () => {
    try {
      OpenAiSdk = await import("openai");
      isModuleExists = true;
    } catch {
      isModuleExists = false;
    }
  })();

  return loadingPromise;
}

/**
 * The optional OpenAI-backed moderation detector — the internal class behind
 * the {@link moderation} factory. Sends the inspected text to OpenAI's
 * moderation endpoint and maps the flagged categories to a verdict: any
 * category in `blockOn` → `block`; any other flagged category → `flag`;
 * nothing flagged → `allow`.
 *
 * The `openai` SDK is resolved lazily on the FIRST `check()` (not at
 * construction) so importing `@warlock.js/ai` never forces the peer to
 * be installed. When a `client` is supplied it is used verbatim and the SDK
 * is never imported.
 */
class OpenAiModerationDetector implements GuardrailDetector {
  public readonly name = DETECTOR_NAME;

  /** A pre-built client, or `undefined` until the lazy SDK constructs one. */
  private client: OpenAiClientLike | undefined;

  private readonly apiKey: string | undefined;

  private readonly model: string;

  /** Categories that escalate to `block`; empty means "flag on any". */
  private readonly blockOn: ReadonlySet<string>;

  public constructor(options: OpenAiModerationOptions = {}) {
    this.client = options.client;
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.blockOn = new Set(options.blockOn ?? []);

    // Kick off the lazy import eagerly when no client was supplied, so the
    // first `check()` does not pay the resolution latency. Errors are
    // swallowed by `loadOpenAi`; the curated install string surfaces at use.
    if (!this.client) {
      loadOpenAi();
    }
  }

  /**
   * Moderate `text` and fold the response into a verdict. `allow` when the
   * model flags nothing; `block` when any flagged category is in `blockOn`;
   * otherwise `flag` listing every flagged category. Resolving the client
   * throws the curated install string when the `openai` peer is absent.
   */
  public async check(text: string): Promise<GuardrailVerdict> {
    const client = await this.resolveClient();

    const response = await client.moderations.create({
      model: this.model,
      input: text,
    });

    const result = response.results[0];

    if (result === undefined || !result.flagged) {
      return { type: "allow" };
    }

    return this.toVerdict(result);
  }

  /**
   * Return the supplied client, or construct one lazily from the resolved
   * SDK. Throws {@link OPENAI_INSTALL_INSTRUCTIONS} (a plain `Error` — a
   * missing optional peer is an infrastructure fault, not a content
   * violation) when `openai` could not be imported.
   */
  private async resolveClient(): Promise<OpenAiClientLike> {
    if (this.client) {
      return this.client;
    }

    await loadOpenAi();

    if (!isModuleExists) {
      throw new Error(OPENAI_INSTALL_INSTRUCTIONS);
    }

    this.client = new OpenAiSdk.default({
      apiKey: this.apiKey,
    }) as unknown as OpenAiClientLike;

    return this.client;
  }

  /**
   * Fold a flagged moderation result into a `block` or `flag` verdict. Every
   * `true` category becomes a {@link GuardrailMatch} (`moderation.<category>`);
   * the verdict is `block` when any flagged category is in `blockOn`,
   * otherwise `flag`.
   */
  private toVerdict(result: OpenAiModerationResult): GuardrailVerdict {
    const flagged = Object.entries(result.categories)
      .filter(([, tripped]) => tripped)
      .map(([category]) => category);

    const matches: GuardrailMatch[] = flagged.map((category) => ({
      rule: `moderation.${category}`,
      label: category,
    }));

    const shouldBlock = flagged.some((category) => this.blockOn.has(category));
    const list = flagged.join(", ");

    if (shouldBlock) {
      return {
        type: "block",
        reason: `OpenAI moderation flagged blocked category(ies): ${list}.`,
        matches,
      };
    }

    return {
      type: "flag",
      reason: `OpenAI moderation flagged category(ies): ${list}.`,
      matches,
    };
  }
}

/**
 * Build the optional `moderation` detector (surfaced as
 * `ai.guardrail.moderation(options?)`), backed by OpenAI's moderation
 * endpoint. The `openai` SDK is an **optional lazy peer**: importing
 * `@warlock.js/ai` never forces it to resolve, and the detector throws
 * a curated install string ({@link OPENAI_INSTALL_INSTRUCTIONS}) on first
 * `check()` when the peer is absent — mirroring ai-panoptic's lazy Langfuse
 * exporter.
 *
 * On a moderation hit, every flagged category becomes a
 * {@link GuardrailMatch}; the verdict is `block` when any flagged category is
 * listed in `blockOn`, otherwise `flag`. A clean result is `allow`.
 *
 * @param options - `apiKey` (defaults to `OPENAI_API_KEY`), `model`
 *   (defaults to `"omni-moderation-latest"`), `blockOn` (categories that
 *   escalate to `block`), or a pre-built `client` to bypass the lazy import.
 * @returns A {@link GuardrailDetector} for the guard's `input` / `output` / `tool` arrays.
 *
 * @example
 * const guard = ai.guardrail({
 *   output: [
 *     ai.guardrail.moderation({ blockOn: ["violence", "sexual/minors"] }),
 *   ],
 * });
 */
export function moderation(
  options?: OpenAiModerationOptions,
): GuardrailDetector {
  return new OpenAiModerationDetector(options);
}
