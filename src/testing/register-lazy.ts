// Lazy bridge for the vitest-coupled matcher registration.
//
// WHY: `@warlock.js/ai`'s root barrel (`src/index.ts`) is the package's
// only public entry, and it is loaded by every production consumer.
// `./matchers` statically imports `vitest` (a devDependency) at module
// top to call `expect.extend`, so pulling it into the eager barrel would
// force `vitest` to resolve in production — where it is not installed —
// and crash the import. This wrapper defers that import to call time via
// a dynamic `import()`, mirroring the package's optional-peer discipline,
// so `registerAiMatchers` can ship on the root barrel while staying inert
// (and `vitest`-free) until a test actually invokes it.

/**
 * Register the `@warlock.js/ai` custom Vitest matchers
 * (`toRouteTo` / `toConverge` / `toPassStep` / `toOutputShape`) on the
 * global `expect`. Call once from test code before using them. The
 * underlying `vitest`-coupled implementation is imported lazily on the
 * first call, so importing `@warlock.js/ai` in production never pulls in
 * `vitest`. Idempotent — the underlying registration is itself a no-op on
 * repeat calls.
 *
 * @example
 * import { registerAiMatchers } from "@warlock.js/ai";
 * await registerAiMatchers();
 *
 * expect(await supervisor.execute(input)).toRouteTo("critic");
 */
export async function registerAiMatchers(): Promise<void> {
  const { registerAiMatchers: register } = await import("./matchers");

  register();
}
