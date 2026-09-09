import type { AIErrorOptions } from "./ai-error";
import { ProviderError } from "./provider-error";

/** Details of an embedding provider response that did not preserve its input order. */
export type EmbeddingVectorCountMismatchErrorOptions = AIErrorOptions & {
  provider: string;
  expectedCount: number;
  receivedCount: number;
  record: string;
};

/**
 * An embedding provider returned a vector count other than the number of
 * inputs it accepted. Indexing or scoring that response would silently leave
 * a record without a vector, so callers must stop and surface the provider
 * contract violation.
 */
export class EmbeddingVectorCountMismatchError extends ProviderError {
  public readonly provider: string;
  public readonly expectedCount: number;
  public readonly receivedCount: number;
  public readonly record: string;

  public constructor(options: EmbeddingVectorCountMismatchErrorOptions) {
    super(
      `Embedding provider "${options.provider}" returned ${options.receivedCount} vectors for ${options.expectedCount} records; record "${options.record}" was left without a vector.`,
      options,
      "PROVIDER_EMBEDDING_VECTOR_COUNT_MISMATCH",
    );
    this.name = "EmbeddingVectorCountMismatchError";
    this.provider = options.provider;
    this.expectedCount = options.expectedCount;
    this.receivedCount = options.receivedCount;
    this.record = options.record;
  }
}
