import type { EmbedderContract } from "../../contracts/embedder.contract";
import type { OutboundPolicy } from "../../security/outbound-policy.type";
import type { SkillRecord } from "./skill-record.type";
import type { SkillsStoreContract } from "./skills-store.contract";

/**
 * Where skills come from. Discriminated by `type` (never `kind`):
 *
 * - `directory` — reads `path/<folder>/SKILL.md` off the local
 *   filesystem (via `node:fs/promises`, lazily imported).
 * - `url` — `fetch()`es a JSON manifest of skills. A remote URL skill
 *   source is a **prompt supply chain** — its bodies flow straight into
 *   model context — so the fetch is hardened by an {@link OutboundPolicy}
 *   and every manifest record is runtime-validated before use (S3).
 * - `store` — a pass-through to any {@link SkillsStoreContract}
 *   (e.g. `MockSkillsStore`).
 */
export type SkillSource =
  | { type: "directory"; path: string }
  | {
      type: "url";
      url: string;
      headers?: Record<string, string>;
      /**
       * Fetch controls for the manifest (S3): scheme + host allowlist,
       * post-DNS private-IP deny, max bytes, timeout, injectable fetch.
       * Defaults to the strict `OutboundPolicy` (https-only, private-IP
       * deny on, 5 MiB cap, 10s). Set a `hostAllowlist` to pin trusted
       * manifest hosts.
       */
      policy?: OutboundPolicy;
      /**
       * Cache the fetched manifest for this many ms before refetching.
       * Omitted ⇒ cached for the source's lifetime (the prior behavior).
       */
      cacheTtlMs?: number;
    }
  | { type: "store"; store: SkillsStoreContract };

/**
 * Body-injection policy.
 *
 * - `"all"` — inject every body up front (small libraries only).
 * - `{ select: "semantic", topK }` — embed the run input, rank the
 *   catalog by cosine similarity, inject the top-`topK` bodies. Needs an
 *   embedder (passed via `embedder`, or lazily auto-resolved).
 */
export type SkillInjectMode =
  | "all"
  | {
      select: "semantic";
      topK: number;
      embedder?: EmbedderContract;
      threshold?: number;
    };

/**
 * Default-DENY promotion gate for self-authored skills (Phase 2).
 *
 * `approve(candidate)` resolves `{ approve: true }` to promote the
 * candidate to a new audited VERSION; anything else (including a throw,
 * treated as deny) keeps it INERT. The three interchangeable shapes a
 * team might use — a policy fn, a validator agent, a human callback — all
 * reduce to this one Promise.
 */
export type SkillReviewGate = {
  /** Resolve `{ approve: true }` to promote; anything else keeps the candidate inert. */
  approve: (candidate: SkillRecord) => Promise<{ approve: boolean; reason?: string }>;
  /** Where promoted skills are written. Required when `review` is set. */
  store: SkillsStoreContract;
};

/**
 * Efficacy-analytics event fired across a skill's lifecycle. Errors from
 * the sink are swallowed (mirroring the agent's `onUsage`/`onComplete`).
 */
export type SkillAnalyticsEvent = {
  type: "catalogued" | "loaded" | "used" | "saved" | "promoted" | "denied";
  skill: string;
  version: number;
  runId?: string;
  outcome?: "completed" | "failed";
};

/**
 * Configuration for the `skills(config)` factory.
 *
 * The metadata **catalog is always injected** (it's cheap); `inject`
 * controls whether any BODIES are auto-injected up front. Default is
 * catalog-only — the model pulls bodies on demand via `loadSkill`.
 */
export type SkillsConfig = {
  /** Stable identifier — surfaced in analytics + the catalog system block. */
  name: string;
  /** One or more sources, merged in order; later sources win on name collision. */
  sources: SkillSource[];
  /**
   * Body-injection policy. Omitted (default) ⇒ inject NO bodies; the model
   * pulls them via `loadSkill`. See {@link SkillInjectMode}.
   */
  inject?: SkillInjectMode;
  /** Hard cap on `loadSkill` calls per run. Default 5. Prevents body-load loops. */
  maxLoadsPerRun?: number;
  /** Role / context scoping — only skills whose tags intersect are catalogued. */
  scope?: { tags?: string[] };
  /** Phase 2 — self-authoring gate. Absent ⇒ the `saveSkill` tool is NOT exposed. */
  review?: SkillReviewGate;
  /** Optional sink for efficacy analytics (load/use/outcome). */
  analytics?: (event: SkillAnalyticsEvent) => void | Promise<void>;
};
