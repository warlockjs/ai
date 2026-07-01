import type { RagDocument } from "../contracts/rag-document.type";
import type { LoadTextOptions, RagLoaderResult } from "./loader.type";

/** Default `id` when the caller supplies neither `id` nor an item id. */
const DEFAULT_ID = "document";

/**
 * One raw text item — a bare string, or a `{ id, text, … }` record giving the
 * item its own id / metadata / tags. Passing records lets a single
 * {@link loadText} call turn many strings into many distinctly-identified
 * {@link RagDocument}s.
 */
export type TextInput =
  | string
  | {
      /** Stable id for this item. Falls back to the option `id` + index. */
      id?: string;
      /** The text body. */
      text: string;
      /** Per-item metadata, merged under the shared option `metadata`. */
      metadata?: Record<string, unknown>;
      /** Per-item tags (override the shared option `tags` when present). */
      tags?: string[];
    };

/**
 * Load plain text into {@link RagDocument}(s) — the zero-dependency base
 * loader every other loader ultimately funnels into. Accepts a single
 * string, a single `{ id, text }` record, or an array mixing both; each
 * input becomes one document carrying `metadata.loader = "text"` plus a
 * `metadata.source` (the resolved id).
 *
 * Caller `metadata` always wins over the loader-derived keys, and per-item
 * `metadata` / `tags` (when an item is a record) layer on top of the shared
 * option values. Empty / whitespace-only items are dropped — they would
 * chunk to nothing anyway, so the result never carries a no-op document.
 *
 * The output is the exact shape `index()` consumes:
 *
 * @example
 * const kb = ai.rag({ embedder, store });
 * await kb.index(loadText("a long string of notes…"));
 *
 * @example
 * await kb.index(loadText([
 *   { id: "faq-1", text: "…", metadata: { section: "billing" } },
 *   { id: "faq-2", text: "…" },
 * ]));
 *
 * @param input - A string, a `{ id, text }` record, or an array of either.
 * @param options - Shared `id` / `metadata` / `tags` ({@link LoadTextOptions}).
 * @returns A {@link RagLoaderResult} ready to hand to `rag.index()`.
 */
export function loadText(
  input: TextInput | TextInput[],
  options: LoadTextOptions = {},
): RagLoaderResult {
  const items = Array.isArray(input) ? input : [input];
  const baseId = options.id ?? DEFAULT_ID;
  const multiple = items.length > 1;

  const docs: RagDocument[] = [];

  items.forEach((item, index) => {
    const text = typeof item === "string" ? item : item.text;

    // Drop empties up front — they chunk to nothing, so emitting them would
    // only add a no-op document for index() to skip.
    if (text.trim().length === 0) {
      return;
    }

    const itemId =
      typeof item === "string" ? undefined : item.id;
    // A single input keeps the bare base id; multiple inputs are suffixed so
    // every emitted document has a distinct, stable id.
    const id = itemId ?? (multiple ? `${baseId}#${index}` : baseId);

    const itemMetadata =
      typeof item === "string" ? undefined : item.metadata;
    const itemTags = typeof item === "string" ? undefined : item.tags;

    docs.push({
      id,
      text,
      // Loader-derived keys first, then the shared option metadata, then the
      // per-item metadata — caller intent always overrides the derived keys.
      metadata: {
        source: id,
        loader: "text",
        ...options.metadata,
        ...itemMetadata,
      },
      tags: itemTags ?? options.tags,
    });
  });

  return docs;
}
