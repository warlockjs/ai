/** The parsed front-matter (cheap metadata) plus the stripped body. */
export type ParsedFrontmatter = {
  /** Every `key: value` line from the front-matter block, values quote-stripped. */
  meta: Record<string, string>;
  /** Everything after the closing `---`, verbatim (the skill body). */
  body: string;
};

/**
 * Parse simple `key: value` YAML front-matter — the only form `SKILL.md`
 * uses (no nested objects, no block arrays). Ported verbatim from the
 * package's `scripts/generate-llms.mjs` `parseFrontmatter()` so the
 * runtime catalog and the docs `llms.txt` index agree byte-for-byte on
 * what a skill's `description` is.
 *
 * When the text has no `---`-delimited front-matter block, returns an
 * empty `meta` and the full text as `body`.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!match) {
    return { meta: {}, body: text };
  }

  const meta: Record<string, string> = {};

  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");

    if (colon === -1) {
      continue;
    }

    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();

    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1).replace(/''/g, "'").replace(/\\"/g, '"');
    }

    meta[key] = value;
  }

  return { meta, body: match[2] };
}

/**
 * Split a front-matter `tags:` value into a string array. Accepts a
 * comma-separated inline list (`tags: frontend, react`) — the simple
 * inline form that fits the `key: value` parser. Returns `undefined` when
 * the value is absent or blank so a tagless skill stays `tags: undefined`.
 */
export function parseTags(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const tags = value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

  return tags.length > 0 ? tags : undefined;
}
