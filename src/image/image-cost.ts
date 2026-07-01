import type { ImageModelPricing } from "../contracts/image-model.contract";
import type { ModelPricing } from "../contracts/result/model-pricing.type";
import type { Usage } from "../contracts/result/usage.type";
import { computeCost } from "../utils/compute-cost";

/**
 * Price one image-generation `Usage` against an
 * {@link ImageModelPricing}, returning a `ModelPricing`-shaped USD
 * breakdown so image spend folds into the exact same `Usage.cost`
 * rollup the text path uses (`accumulateCost` / `mergeUsage`). There is
 * no separate image-cost field anywhere downstream — only this one
 * function, which knows the two metering models:
 *
 * - **Per-image** (DALL·E, Imagen): `perImageBySize[size]` (when the
 *   request `size` matches a tier) else flat `perImage`, times the
 *   number of images returned, attributed to `cost.output` (the image
 *   IS the output). Token channels stay 0.
 * - **Token** (gpt-image-1): delegates to the standard
 *   {@link computeCost} against the prompt/image token `Usage`.
 *
 * Per-image wins when both shapes are configured (a provider is one or
 * the other). Returns `undefined` when no usable pricing is present —
 * the framework treats that as "cost unknown", never a false zero.
 *
 * @example
 * computeImageCost({ input: 0, output: 0, total: 0 }, 2, "1024x1024", { perImage: 0.04 });
 * // → { input: 0, output: 0.08 }
 */
export function computeImageCost(
  usage: Usage,
  imageCount: number,
  size: string | undefined,
  pricing: ImageModelPricing | undefined,
): ModelPricing | undefined {
  if (!pricing) {
    return undefined;
  }

  const perImageMetered = pricing.perImage !== undefined || pricing.perImageBySize !== undefined;

  if (perImageMetered) {
    const perImage = resolvePerImageRate(size, pricing);

    if (perImage === undefined) {
      return undefined;
    }

    return { input: 0, output: perImage * imageCount };
  }

  if (pricing.input !== undefined && pricing.output !== undefined) {
    return computeCost(usage, { input: pricing.input, output: pricing.output });
  }

  return undefined;
}

/**
 * Resolve the USD-per-image rate: a `perImageBySize` tier matching the
 * requested `size` wins, otherwise the flat `perImage`. Returns
 * `undefined` only when neither is set (the caller already gated on
 * per-image metering being configured at all).
 */
function resolvePerImageRate(
  size: string | undefined,
  pricing: ImageModelPricing,
): number | undefined {
  if (size !== undefined && pricing.perImageBySize?.[size] !== undefined) {
    return pricing.perImageBySize[size];
  }

  return pricing.perImage;
}
