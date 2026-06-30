import type { SkillSource } from "../contracts/skills-config.type";
import type { SkillsStoreContract } from "../contracts/skills-store.contract";
import { directorySource } from "./directory-source";
import { storeSource } from "./store-source";
import { urlSource } from "./url-source";

export { directorySource } from "./directory-source";
export { urlSource } from "./url-source";
export { storeSource } from "./store-source";
export { parseFrontmatter, parseTags } from "./parse-frontmatter";
export type { ParsedFrontmatter } from "./parse-frontmatter";

/**
 * Resolve a declarative {@link SkillSource} into a concrete
 * {@link SkillsStoreContract} reader. Discriminated by `type` (never
 * `kind`): `directory` reads the filesystem, `url` fetches a manifest,
 * `store` passes a store through verbatim.
 */
export function resolveSource(source: SkillSource): SkillsStoreContract {
  switch (source.type) {
    case "directory":
      return directorySource(source.path);
    case "url":
      return urlSource(source.url, {
        headers: source.headers,
        policy: source.policy,
        cacheTtlMs: source.cacheTtlMs,
      });
    case "store":
      return storeSource(source.store);
  }
}
