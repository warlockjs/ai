import type { CacheDriver } from "@warlock.js/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAIConfig, resolveDefaultStore, setAIConfig } from "./config";

/**
 * Minimal stand-in for a `CacheDriver`. The config module only stores
 * the reference and hands it back — it never calls any method — so an
 * opaque marker object cast to the driver type is enough to assert
 * identity without standing up a real driver.
 */
function makeStore(marker: string): CacheDriver<any, any> {
  return { marker } as unknown as CacheDriver<any, any>;
}

describe("AI config", () => {
  beforeEach(() => {
    // The config singleton carries process-wide state and exposes no
    // reset. Re-import a fresh module instance per test so assertions
    // about the unset/initial state stay honest across runs.
    vi.resetModules();
  });

  it("returns an empty snapshot before anything is set", async () => {
    const fresh = await import("./config");

    expect(fresh.getAIConfig()).toEqual({});
    expect(fresh.resolveDefaultStore()).toBeUndefined();
  });

  it("stores defaultStore and resolves it back by identity", async () => {
    const fresh = await import("./config");
    const store = makeStore("redis");

    fresh.setAIConfig({ defaultStore: store });

    expect(fresh.resolveDefaultStore()).toBe(store);
    expect(fresh.getAIConfig().defaultStore).toBe(store);
  });

  it("merges over existing values instead of replacing the whole config", async () => {
    const fresh = await import("./config");
    const store = makeStore("pg");

    fresh.setAIConfig({ defaultStore: store });
    fresh.setAIConfig({});

    expect(fresh.resolveDefaultStore()).toBe(store);
  });

  it("returns the merged config so callers can verify what landed", () => {
    const store = makeStore("memory");
    const merged = setAIConfig({ defaultStore: store });

    expect(merged.defaultStore).toBe(store);
  });

  it("returns a shallow copy so callers cannot mutate the source of truth", () => {
    const store = makeStore("source-of-truth");
    setAIConfig({ defaultStore: store });

    const snapshot = getAIConfig();
    snapshot.defaultStore = makeStore("tampered");

    expect(resolveDefaultStore()).toBe(store);
  });
});
