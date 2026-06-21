// Vitest matcher registration + the type augmentation that makes
// `toRouteTo` / `toConverge` / `toPassStep` / `toOutputShape` typecheck.
//
// NOTE for the WIRE stage: `./matchers` imports `vitest` at module top
// (for `expect.extend`). `vitest` is a devDependency, so this barrel
// must NOT be pulled into an eager production import path — surface it
// only to test code (a dedicated `@warlock.js/ai/testing` entry, or a
// lazy re-export). The pure `matcher-logic` functions below carry no
// `vitest` import and are safe to export from anywhere.
export { registerAiMatchers } from "./matchers";
export type { AiMatchers } from "./matchers";

// Pure, library-agnostic matcher logic — no vitest coupling. Safe for
// non-test consumers that want the verdicts without the global
// `expect` augmentation.
export {
  matchConverge,
  matchOutputShape,
  matchPassStep,
  matchRouteTo,
} from "./matcher-logic";
export type { MatcherVerdict } from "./matcher-logic";
