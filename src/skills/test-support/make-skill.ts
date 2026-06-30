import type {
  EmbedderContract,
  EmbeddingBatchResult,
  EmbeddingResult,
} from "../../contracts/embedder.contract";
import type { SkillAnalyticsEvent } from "../contracts/skills-config.type";
import type { SkillRecord } from "../contracts/skill-record.type";

/**
 * Build a {@link SkillRecord} fixture, overriding only the fields a case
 * cares about. Defaults to a v1 authored skill so the common case is one
 * line. Mirrors `rag`'s `makeDocs` helper.
 *
 * NOTE: test-only helper. Not part of the package's public surface.
 */
export function makeSkill(overrides: Partial<SkillRecord> & { name: string }): SkillRecord {
  return {
    description: `Skill ${overrides.name}`,
    version: 1,
    body: `Body of ${overrides.name}`,
    type: "authored",
    ...overrides,
  };
}

/**
 * Deterministic, dependency-free embedder for skills specs — letter-
 * frequency vectors (26 dims, L2-normalized) so cosine similarity is
 * predictable: texts sharing letters score high, disjoint texts low.
 * Identical in spirit to RAG's `FakeEmbedder`, duplicated here so the
 * skills suite has no cross-feature test-support coupling.
 */
export class FakeEmbedder implements EmbedderContract {
  public readonly name = "fake-skill-embedder";
  public readonly provider = "fake";
  public dimensions = 0;
  public embedCalls = 0;
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
 * Array-backed analytics sink for assertions. Pass `sink.record` as
 * `config.analytics`; inspect `sink.events` after the run.
 */
export function recordingAnalytics(): {
  events: SkillAnalyticsEvent[];
  record: (event: SkillAnalyticsEvent) => void;
} {
  const events: SkillAnalyticsEvent[] = [];

  return {
    events,
    record: (event) => {
      events.push(event);
    },
  };
}
