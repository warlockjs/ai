export * from "./agent";
export { ai } from "./ai";
export * from "./batch";
export * from "./checkpoint";
export * from "./config";
export * from "./contracts";
export * from "./errors";
export * from "./eval";
export * from "./memory";
export * from "./middleware";
export * from "./mock";
export * from "./model";
export * from "./orchestrator";
export * from "./planner";
export * from "./snapshot";
export * from "./supervisor";
export * from "./system-prompt";
export * from "./tool";
export * from "./utils";
export * from "./workflow";

// Testing matchers. The pure, library-agnostic verdict functions and the
// `AiMatchers` type carry no `vitest` coupling and ship eagerly. The
// matcher *registration* (`registerAiMatchers`) is surfaced through the
// lazy bridge in `./testing/register-lazy`, which defers the `vitest`
// import (a devDependency) to call time — so importing `@warlock.js/ai`
// in production never pulls in `vitest`, while test code can still call
// it straight off the package root.
export {
  matchConverge,
  matchOutputShape,
  matchPassStep,
  matchRouteTo,
} from "./testing/matcher-logic";
export type { MatcherVerdict } from "./testing/matcher-logic";
export type { AiMatchers } from "./testing/matchers";
export { registerAiMatchers } from "./testing/register-lazy";
