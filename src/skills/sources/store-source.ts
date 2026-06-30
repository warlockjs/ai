import type { SkillsStoreContract } from "../contracts/skills-store.contract";

/**
 * Adapt a `{ type: "store", store }` source — a pass-through to any
 * {@link SkillsStoreContract} (e.g. `MockSkillsStore`, or the Phase-2
 * `ProceduralSkillStore`). The store already implements every reader
 * method, so this is identity; it exists for symmetry with the directory
 * and url sources and to keep `resolveSource` a single dispatch table.
 */
export function storeSource(store: SkillsStoreContract): SkillsStoreContract {
  return store;
}
