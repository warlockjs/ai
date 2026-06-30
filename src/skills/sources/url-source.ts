import { fetchTextWithPolicy } from "../../security/outbound-policy";
import type { OutboundPolicy } from "../../security/outbound-policy.type";
import type {
  SkillCatalogEntry,
  SkillRecord,
} from "../contracts/skill-record.type";
import type { SkillsStoreContract } from "../contracts/skills-store.contract";

/**
 * The JSON manifest shape a `url` source fetches — a flat array of skill
 * records. Bodies travel inline; the catalog projection drops them so the
 * always-injected metadata block stays cheap.
 */
type SkillManifest = SkillRecord[];

/** Options for {@link urlSource} (S3). */
export type UrlSourceOptions = {
  headers?: Record<string, string>;
  /** Fetch hardening for the manifest request. */
  policy?: OutboundPolicy;
  /** Cache the manifest for this many ms; omit to cache for the source's lifetime. */
  cacheTtlMs?: number;
};

/**
 * Read skills from a remote JSON manifest at `url`. The manifest is a flat
 * array of {@link SkillRecord}s (bodies inline).
 *
 * **Trust boundary (S3).** A remote skill source is a prompt supply chain —
 * its bodies flow straight into model context — so the manifest fetch runs
 * through the shared `OutboundPolicy` (scheme + host allowlist, post-DNS
 * private-IP deny, max bytes, timeout) and **every record is runtime-
 * validated** before it can be served. A malformed record fails loudly
 * rather than being cast blindly into a `SkillRecord`.
 *
 * The request is made lazily on the first `list()` / `load()`. The result
 * is cached for the source's lifetime, or for `cacheTtlMs` when set
 * (a stale cache refetches on next access).
 */
export function urlSource(
  url: string,
  options: UrlSourceOptions = {},
): SkillsStoreContract {
  const { headers, policy, cacheTtlMs } = options;

  let cache: Promise<Map<string, SkillRecord>> | undefined;
  let cachedAtMs: number | undefined;

  const records = (): Promise<Map<string, SkillRecord>> => {
    const expired =
      cacheTtlMs !== undefined &&
      cachedAtMs !== undefined &&
      Date.now() - cachedAtMs > cacheTtlMs;

    if (!cache || expired) {
      cachedAtMs = Date.now();
      cache = fetchManifest(url, headers, policy);
    }

    return cache;
  };

  return {
    async list(scope?: { tags?: string[] }): Promise<SkillCatalogEntry[]> {
      const all = await records();
      const wanted = scope?.tags;

      return [...all.values()]
        .filter(record => record.type !== "candidate")
        .filter(record => intersects(record.tags, wanted))
        .map(toCatalogEntry);
    },
    async load(name: string, version?: number): Promise<SkillRecord | undefined> {
      const all = await records();
      const record = all.get(name);

      if (!record || record.type === "candidate") {
        return undefined;
      }

      if (version !== undefined && record.version !== version) {
        return undefined;
      }

      return record;
    },
    async saveCandidate(): Promise<SkillRecord> {
      throw new Error(
        "url source is read-only — saveCandidate requires a writable store (set `review.store`)",
      );
    },
    async promote(): Promise<SkillRecord> {
      throw new Error(
        "url source is read-only — promote requires a writable store (set `review.store`)",
      );
    },
  };
}

/** Fetch + validate + parse the manifest once into a name → record map. */
async function fetchManifest(
  url: string,
  headers: Record<string, string> | undefined,
  policy: OutboundPolicy | undefined,
): Promise<Map<string, SkillRecord>> {
  const result = await fetchTextWithPolicy(
    url,
    policy ?? {},
    headers ? { headers } : undefined,
  );

  if (!result.ok) {
    throw new Error(
      `url skill source failed: ${result.status} ${result.statusText} for ${url}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch (cause) {
    throw new Error(`url skill source returned invalid JSON from ${url}`, {
      cause,
    });
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `url skill source at ${url} must return a JSON array of skill records`,
    );
  }

  const records = new Map<string, SkillRecord>();

  (parsed as SkillManifest).forEach((raw, index) => {
    const record = validateManifestRecord(raw, url, index);
    records.set(record.name, record);
  });

  return records;
}

/**
 * Runtime-validate one manifest record before it is trusted as a
 * {@link SkillRecord}. Untyped remote JSON cast blindly into the context
 * is both an injection surface and a correctness bug; this rejects a
 * record missing the required `name` / `description` / `body` strings, and
 * fills `version` / `type` defaults for a thin record.
 */
function validateManifestRecord(
  raw: unknown,
  url: string,
  index: number,
): SkillRecord {
  if (!raw || typeof raw !== "object") {
    throw new Error(`url skill source at ${url}: record #${index} is not an object`);
  }

  const r = raw as Record<string, unknown>;
  const requireString = (field: string): string => {
    const value = r[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `url skill source at ${url}: record #${index} is missing a string "${field}"`,
      );
    }
    return value;
  };

  const name = requireString("name");
  const description = requireString("description");
  const body = requireString("body");

  const type =
    r.type === "authored" || r.type === "promoted" || r.type === "candidate"
      ? r.type
      : "authored";
  const version = typeof r.version === "number" ? r.version : 1;
  const tags = Array.isArray(r.tags)
    ? r.tags.filter((t): t is string => typeof t === "string")
    : undefined;
  const metadata =
    r.metadata && typeof r.metadata === "object"
      ? (r.metadata as Record<string, unknown>)
      : undefined;

  return { name, description, body, version, type, tags, metadata };
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

  return recordTags.some(tag => wanted.includes(tag));
}
