import type {
  EmbedderContract,
  EmbeddingBatchResult,
  EmbeddingResult,
} from "../../contracts/embedder.contract";
import type { RagDocument } from "../contracts/rag-document.type";

/**
 * Deterministic, dependency-free embedder for RAG specs.
 *
 * Maps text to a fixed-dimension vector by lowercase-letter frequency
 * (26 dims, L2-normalized) so cosine similarity is fully predictable: two
 * texts sharing the same letters score high, disjoint texts score low.
 * Counts `embed` / `embedMany` calls so specs can assert batching.
 *
 * NOTE: test-only helper. Not part of the package's public surface.
 */
export class FakeEmbedder implements EmbedderContract {
  public readonly name = "fake-embedder";
  public readonly provider = "fake";
  public dimensions = 0;

  /** Number of single `embed()` calls made. */
  public embedCalls = 0;
  /** Number of batch `embedMany()` calls made. */
  public embedManyCalls = 0;

  public constructor(private readonly dims: number = 26) {}

  public async embed(input: string): Promise<EmbeddingResult> {
    this.embedCalls += 1;

    const vector = this.vectorize(input);
    this.dimensions = vector.length;

    return {
      vector,
      dimensions: vector.length,
      usage: { promptTokens: input.length, totalTokens: input.length },
    };
  }

  public async embedMany(inputs: string[]): Promise<EmbeddingBatchResult> {
    this.embedManyCalls += 1;

    const vectors = inputs.map((input) => this.vectorize(input));
    const dimensions = vectors[0]?.length ?? this.dims;
    this.dimensions = dimensions;

    const totalChars = inputs.reduce((sum, input) => sum + input.length, 0);

    return {
      vectors,
      dimensions,
      usage: { promptTokens: totalChars, totalTokens: totalChars },
    };
  }

  /** Letter-frequency vector, L2-normalized so cosine == dot product. */
  private vectorize(text: string): number[] {
    const counts = new Array<number>(this.dims).fill(0);
    const lower = text.toLowerCase();

    for (const char of lower) {
      const code = char.charCodeAt(0) - 97;

      if (code >= 0 && code < 26 && code < this.dims) {
        counts[code] += 1;
      }
    }

    const norm = Math.sqrt(counts.reduce((sum, value) => sum + value * value, 0));

    if (norm === 0) {
      return counts;
    }

    return counts.map((value) => value / norm);
  }
}

/**
 * Build a list of {@link RagDocument} fixtures, overriding only the fields a
 * given case cares about. Mirrors `ai-panoptic`'s `make-trace` helpers.
 */
export function makeDocs(
  overrides: Array<Partial<RagDocument> & { id: string; text: string }>,
): RagDocument[] {
  return overrides.map((override) => ({
    metadata: undefined,
    tags: undefined,
    ...override,
  }));
}
