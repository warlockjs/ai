import type { Cassette } from "./vcr.type";

/**
 * Lazily-resolved `node:fs/promises` module. VCR cassette I/O only touches
 * disk on construct (load) and on `save()` — keeping the import lazy means
 * importing the `vcr` factory never eagerly pulls `node:fs`, which keeps the
 * surface usable in non-node bundles that never call a disk path.
 */
type FsPromises = typeof import("node:fs/promises");

let fsModule: FsPromises | undefined;

/**
 * Resolve `node:fs/promises` once and memoize it.
 */
async function loadFs(): Promise<FsPromises> {
  if (!fsModule) {
    fsModule = await import("node:fs/promises");
  }

  return fsModule;
}

/**
 * Build a fresh, empty cassette for a model identity. Used when the path
 * does not exist yet (first record run).
 */
export function emptyCassette(model: string, provider: string): Cassette {
  return {
    version: 1,
    model,
    provider,
    entries: [],
  };
}

/**
 * Load a cassette from disk. Returns a fresh empty cassette (not an error)
 * when the file does not exist — the common first-record case. Any other I/O
 * or parse failure rejects so corruption is never silently swallowed.
 */
export async function loadCassette(
  path: string,
  model: string,
  provider: string,
): Promise<Cassette> {
  const fs = await loadFs();

  let raw: string;

  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyCassette(model, provider);
    }

    throw error;
  }

  const parsed = JSON.parse(raw) as Cassette;

  return {
    version: 1,
    model: parsed.model ?? model,
    provider: parsed.provider ?? provider,
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
  };
}

/**
 * Write a cassette to disk as pretty-printed JSON, creating the parent
 * directory if needed so a brand-new `./cassettes/foo.json` path just works.
 */
export async function saveCassette(path: string, cassette: Cassette): Promise<void> {
  const fs = await loadFs();
  const nodePath = await import("node:path");
  const dir = nodePath.dirname(path);

  if (dir && dir !== "." && dir !== path) {
    await fs.mkdir(dir, { recursive: true });
  }

  await fs.writeFile(path, JSON.stringify(cassette, undefined, 2), "utf8");
}
