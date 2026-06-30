import type {
  SkillCatalogEntry,
  SkillRecord,
} from "../contracts/skill-record.type";
import type { SkillsStoreContract } from "../contracts/skills-store.contract";
import { parseFrontmatter, parseTags } from "./parse-frontmatter";

/**
 * Lazily-loaded `node:fs/promises`. Core takes no new filesystem
 * dependency — a `store`-only or `url`-only consumer never touches the
 * filesystem because the module is imported on first read, not at module
 * load. Settled once and cached.
 */
let fsMod: typeof import("node:fs/promises") | undefined;
let pathMod: typeof import("node:path") | undefined;

async function loadFs(): Promise<{
  fs: typeof import("node:fs/promises");
  path: typeof import("node:path");
}> {
  if (!fsMod) {
    fsMod = await import("node:fs/promises");
  }

  if (!pathMod) {
    pathMod = await import("node:path");
  }

  return { fs: fsMod, path: pathMod };
}

/**
 * Read `path/<folder>/SKILL.md` into {@link SkillRecord}s, parsing the
 * same `key: value` front-matter as `scripts/generate-llms.mjs`. Each
 * direct sub-directory holding a `SKILL.md` becomes one skill named after
 * the folder; the `description` comes from front-matter, `tags` from a
 * comma-separated `tags:` line, and the body is everything after the
 * closing `---`. Files at the root (e.g. `README.md`) are ignored.
 *
 * Reads are a snapshot at first call and cached for the source's lifetime
 * (a single agent run reads the catalog and bodies from one consistent
 * view). A missing directory yields an empty library, not a throw.
 */
export function directorySource(dirPath: string): SkillsStoreContract {
  let cache: Promise<Map<string, SkillRecord>> | undefined;

  const records = (): Promise<Map<string, SkillRecord>> => {
    if (!cache) {
      cache = readDirectory(dirPath);
    }

    return cache;
  };

  return {
    async list(scope?: { tags?: string[] }): Promise<SkillCatalogEntry[]> {
      const all = await records();
      const wanted = scope?.tags;

      return [...all.values()]
        .filter((record) => intersects(record.tags, wanted))
        .map(toCatalogEntry);
    },
    async load(name: string, version?: number): Promise<SkillRecord | undefined> {
      const all = await records();
      const record = all.get(name);

      if (!record) {
        return undefined;
      }

      if (version !== undefined && record.version !== version) {
        return undefined;
      }

      return record;
    },
    async saveCandidate(): Promise<SkillRecord> {
      throw new Error(
        "directory source is read-only — saveCandidate requires a writable store (set `review.store`)",
      );
    },
    async promote(): Promise<SkillRecord> {
      throw new Error(
        "directory source is read-only — promote requires a writable store (set `review.store`)",
      );
    },
  };
}

/** Walk the directory once, parsing every `<folder>/SKILL.md` into a record. */
async function readDirectory(dirPath: string): Promise<Map<string, SkillRecord>> {
  const { fs, path } = await loadFs();
  const records = new Map<string, SkillRecord>();

  let entries: Array<{ name: string; isDirectory(): boolean }>;

  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    // Missing directory ⇒ empty library; the catalog simply omits it.
    return records;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillFile = path.join(dirPath, entry.name, "SKILL.md");

    let text: string;

    try {
      text = await fs.readFile(skillFile, "utf8");
    } catch {
      // A sub-directory without a SKILL.md is not a skill — skip it.
      continue;
    }

    const { meta, body } = parseFrontmatter(text);

    records.set(entry.name, {
      name: entry.name,
      description: meta.description ?? "(no description)",
      version: 1,
      body: body.trim(),
      tags: parseTags(meta.tags),
      type: "authored",
    });
  }

  return records;
}

/** Project a full record down to its catalog entry (body omitted). */
function toCatalogEntry(record: SkillRecord): SkillCatalogEntry {
  return {
    name: record.name,
    description: record.description,
    version: record.version,
    tags: record.tags,
    type: record.type,
  };
}

/** True when no filter is requested or the record shares a requested tag. */
function intersects(recordTags: string[] | undefined, wanted: string[] | undefined): boolean {
  if (!wanted || wanted.length === 0) {
    return true;
  }

  if (!recordTags || recordTags.length === 0) {
    return false;
  }

  return recordTags.some((tag) => wanted.includes(tag));
}
