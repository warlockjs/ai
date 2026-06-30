import type { PromptEntry, PromptLangfuseSyncOptions } from "./prompt.type";
import type {
  LangfuseClientLike,
  LangfusePromptLike,
} from "./prompt-langfuse-sync.type";

// ============================================================
// Lazily-loaded langfuse SDK (OPTIONAL peer)
// ============================================================

let LangfuseSdk: typeof import("langfuse");
let isModuleExists: boolean | null = null;
let loadingPromise: Promise<void> | undefined;

const PROMPT_LANGFUSE_INSTALL_INSTRUCTIONS = `
The prompt registry's Langfuse sync requires the langfuse package.
Install it with:

  npm install langfuse

Or with your preferred package manager:

  pnpm add langfuse
  yarn add langfuse
`.trim();

/**
 * Settle the lazy import of `langfuse` once, concurrency-safe. Only needed
 * when the caller did not pass a ready `client`. A bare `catch` flips the
 * flag to `false`; the curated install string surfaces at use time, never a
 * raw module-resolution stack trace.
 */
function loadLangfuse(): Promise<void> {
  if (isModuleExists !== null) {
    return Promise.resolve();
  }

  if (loadingPromise) {
    return loadingPromise;
  }

  loadingPromise = (async () => {
    try {
      LangfuseSdk = await import("langfuse");
      isModuleExists = true;
    } catch {
      isModuleExists = false;
    }
  })();

  return loadingPromise;
}

/**
 * Resolve the Langfuse client — the caller-supplied one when present,
 * otherwise a lazily-constructed client from credentials. Throws the curated
 * install error when the SDK is missing and no client was supplied.
 */
async function resolveClient(
  options: PromptLangfuseSyncOptions,
): Promise<LangfuseClientLike> {
  if (options.client) {
    return options.client;
  }

  await loadLangfuse();

  if (!isModuleExists) {
    throw new Error(PROMPT_LANGFUSE_INSTALL_INSTRUCTIONS);
  }

  return new LangfuseSdk.Langfuse({
    publicKey: options.publicKey,
    secretKey: options.secretKey,
    baseUrl: options.baseUrl,
  }) as unknown as LangfuseClientLike;
}

/**
 * Map one Langfuse prompt handle onto a {@link PromptEntry} version snapshot.
 * Langfuse versions are numeric; they become the string `version` label.
 */
function toEntry(remote: LangfusePromptLike): PromptEntry {
  return {
    name: remote.name,
    versions: [{ version: String(remote.version), template: remote.prompt }],
  };
}

/**
 * Warm the lazy `langfuse` import without blocking — call when a registry is
 * constructed with a `langfuse` option but no pre-built client, so the first
 * `.sync()` does not pay the resolution cost. A bare miss is tolerated.
 */
export function warmLangfuse(options: PromptLangfuseSyncOptions): void {
  if (!options.client) {
    void loadLangfuse();
  }
}

/**
 * Run one Langfuse-prompts sync pass.
 *
 * **Pull** (`direction: "pull"` | `"both"`) fetches each named prompt from
 * Langfuse and hands the mapped {@link PromptEntry} to `upsert`. **Push**
 * (`direction: "push"` | `"both"`) writes the latest version of each local
 * entry back as a new Langfuse text prompt. Default direction is `"pull"`.
 *
 * Lazily imports `langfuse` (unless a `client` was supplied) and throws a
 * curated install error when the peer is missing.
 *
 * @param options - The configured sync options (client / credentials / direction).
 * @param names - The prompt names to pull (ignored for push-only).
 * @param localEntries - Snapshot of the local catalog, for push.
 * @param upsert - Callback receiving each pulled entry to merge into the catalog.
 */
export async function syncLangfusePrompts(
  options: PromptLangfuseSyncOptions,
  names: string[],
  localEntries: PromptEntry[],
  upsert: (entry: PromptEntry) => void,
): Promise<void> {
  const direction = options.direction ?? "pull";
  const client = await resolveClient(options);

  if (direction === "pull" || direction === "both") {
    for (const name of names) {
      const remote = await client.getPrompt(name);
      upsert(toEntry(remote));
    }
  }

  if (direction === "push" || direction === "both") {
    for (const entry of localEntries) {
      const latest = entry.versions[entry.versions.length - 1];

      if (!latest) {
        continue;
      }

      await client.createPrompt({
        name: entry.name,
        prompt: latest.template,
        type: "text",
      });
    }
  }
}
