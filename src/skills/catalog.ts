import type { EmbedderContract } from "../contracts/embedder.contract";
import type {
  SkillCatalogEntry,
  SkillRecord,
} from "./contracts/skill-record.type";
import type { SkillsStoreContract } from "./contracts/skills-store.contract";

// ============================================================
// Optional embedder (OPTIONAL peer)
// ============================================================
//
// The embedder is needed ONLY for `inject.select === "semantic"`. It is
// passed explicitly via `inject.embedder` in the common case (consumers
// reuse the one they built for `ai.memory()`). When a consumer relies on
// an auto-resolved embedder instead, the canonical lazy-peer probe below
// surfaces a curated install string at USE TIME (first semantic preload)
// rather than a raw module-resolution stack trace. Catalog-only /
// loadSkill-only usage never touches this path.

let isEmbedderPeerInstalled: boolean | null = null;
let loadingPromise: Promise<void> | undefined;

const EMBEDDER_INSTALL_INSTRUCTIONS = `
Semantic skill pre-injection ({ inject: { select: "semantic" } }) needs an
embedder. Pass one explicitly (reuse the one you built for ai.memory()):

  skills({ inject: { select: "semantic", topK: 2, embedder } })

or install an embedder provider:

  npm install @warlock.js/ai-openai

Or with your preferred package manager:

  pnpm add @warlock.js/ai-openai
  yarn add @warlock.js/ai-openai

Then build one with \`new OpenAIEmbedder(client, { name: "text-embedding-3-small" })\`
and pass it via \`inject.embedder\`.
`.trim();

/**
 * Probe for an installed embedder provider once, concurrency-safe. A bare
 * `catch` flips the flag to `false`; the curated install string surfaces
 * at use time. The provider's embedder needs a constructed SDK client, so
 * we cannot auto-build one — the probe only decides whether the curated
 * message should mention installing the package vs. just passing one in.
 */
function probeEmbedderPeer(): Promise<void> {
  if (isEmbedderPeerInstalled !== null) {
    return Promise.resolve();
  }

  if (loadingPromise) {
    return loadingPromise;
  }

  loadingPromise = (async () => {
    try {
      await import("@warlock.js/ai-openai");
      isEmbedderPeerInstalled = true;
    } catch {
      isEmbedderPeerInstalled = false;
    }
  })();

  return loadingPromise;
}

/**
 * Resolve the embedder for semantic selection. The explicit
 * `inject.embedder` always wins. With none supplied, the lazy probe runs
 * and the curated install string is thrown at use time — a provider's
 * embedder requires a constructed client, so there is no safe auto-build.
 */
async function resolveEmbedder(explicit?: EmbedderContract): Promise<EmbedderContract> {
  if (explicit) {
    return explicit;
  }

  // Warm the peer probe non-blockingly (so a future explicit call can hint
  // whether to install vs. just pass one in) but do NOT await it — a
  // provider's embedder needs a constructed client, so there is no safe
  // auto-build either way and the throw is immediate.
  void probeEmbedderPeer();

  throw new Error(EMBEDDER_INSTALL_INSTRUCTIONS);
}

/**
 * Merge every source's `list()` into one de-duplicated catalog. Sources
 * are merged in order; a LATER source wins on a name collision (explicit,
 * documented precedence). Candidates are already filtered by each store's
 * `list()`, so the merged catalog never carries an inert candidate.
 */
export async function buildCatalog(
  stores: SkillsStoreContract[],
  scope?: { tags?: string[] },
): Promise<SkillCatalogEntry[]> {
  const merged = new Map<string, SkillCatalogEntry>();

  for (const store of stores) {
    const entries = await store.list(scope);

    for (const entry of entries) {
      merged.set(entry.name, entry);
    }
  }

  return [...merged.values()];
}

/**
 * Render the catalog as one line per skill — `name`, `version`,
 * `description` — matching the projection `scripts/generate-llms.mjs`
 * emits for `llms.txt` so the runtime catalog and the docs index read
 * identically. Returns an empty string when no skills are in scope so the
 * agent prepends nothing.
 */
export function renderCatalogPrompt(name: string, entries: SkillCatalogEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  const lines = entries.map(
    (entry) => `- ${entry.name} (v${entry.version}): ${entry.description}`,
  );

  return [
    `# Available skills — "${name}"`,
    "",
    "You can load any of the following skills on demand with the `loadSkill` tool to pull its full instructions into context:",
    "",
    ...lines,
  ].join("\n");
}

/**
 * Load the full record for `name` across the merged sources, honoring the
 * later-source-wins precedence: the FIRST store (iterating in reverse) to
 * return a hit owns the name. A pinned `version` narrows the lookup.
 * Returns `undefined` when no source has the skill.
 */
export async function loadRecord(
  stores: SkillsStoreContract[],
  name: string,
  version?: number,
): Promise<SkillRecord | undefined> {
  for (let index = stores.length - 1; index >= 0; index--) {
    const record = await stores[index].load(name, version);

    if (record) {
      return record;
    }
  }

  return undefined;
}

/**
 * Rank the in-scope catalog by cosine similarity to `input` and return the
 * full `SkillRecord`s for the top `topK` clearing `threshold`.
 *
 * Embeds `input` and every catalog `description` via the resolved
 * embedder (explicit `inject.embedder`, else the lazy provider), scores by
 * cosine similarity, sorts descending, applies the optional floor, slices
 * to `topK`, then loads those bodies. The embedder is the only optional
 * dependency this whole feature carries.
 */
export async function semanticPreselect(
  stores: SkillsStoreContract[],
  input: string,
  topK: number,
  options: { embedder?: EmbedderContract; threshold?: number; scope?: { tags?: string[] } } = {},
): Promise<SkillRecord[]> {
  const catalog = await buildCatalog(stores, options.scope);

  if (catalog.length === 0 || topK <= 0) {
    return [];
  }

  const embedder = await resolveEmbedder(options.embedder);

  const { vectors } = await embedder.embedMany([
    input,
    ...catalog.map((entry) => entry.description),
  ]);

  const inputVector = vectors[0];
  const threshold = options.threshold ?? 0;

  const scored = catalog
    .map((entry, index) => ({
      entry,
      score: cosineSimilarity(inputVector, vectors[index + 1]),
    }))
    .filter((candidate) => candidate.score >= threshold)
    .sort((first, second) => second.score - first.score)
    .slice(0, topK);

  const records: SkillRecord[] = [];

  for (const candidate of scored) {
    const record = await loadRecord(stores, candidate.entry.name, candidate.entry.version);

    if (record) {
      records.push(record);
    }
  }

  return records;
}

/** Cosine similarity of two equal-length vectors; `0` when either is degenerate. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
