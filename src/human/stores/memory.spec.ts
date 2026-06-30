import { describe, expect, it } from "vitest";
import type { PendingInterrupt } from "../contracts/interrupt-store.contract";
import { memory } from "./memory";

/**
 * Build a {@link PendingInterrupt} fixture, overridable per field. The
 * embedded {@link import("../contracts/approval.type").ApprovalRequest} is
 * the durable payload a reviewer rules on.
 */
function makeInterrupt(
  overrides: Partial<PendingInterrupt> = {},
): PendingInterrupt {
  return {
    interruptId: "support.sess-1.0.abc",
    request: {
      interruptId: "support.sess-1.0.abc",
      toolName: "refundCustomer",
      toolDescription: "Refund a customer order",
      args: { orderId: "4821", amount: 50 },
      context: {
        agentName: "support",
        tripIndex: 0,
        sessionId: "sess-1",
        tags: ["money"],
      },
      requestedAt: new Date().toISOString(),
    },
    status: "pending",
    savedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("memory interrupt store", () => {
  it("should return undefined for an unknown interrupt id", async () => {
    const store = memory();

    expect(await store.load("never-seen")).toBeUndefined();
  });

  it("should round-trip a saved interrupt", async () => {
    const store = memory();
    const record = makeInterrupt();

    await store.save(record);

    expect(await store.load(record.interruptId)).toEqual(record);
  });

  it("should overwrite the record for the same id (last-writer wins)", async () => {
    const store = memory();

    await store.save(makeInterrupt({ status: "pending" }));
    await store.save(makeInterrupt({ status: "resolved" }));

    const loaded = await store.load("support.sess-1.0.abc");

    expect(loaded?.status).toBe("resolved");
    expect(await store.list!()).toEqual(["support.sess-1.0.abc"]);
  });

  it("should isolate records by interrupt id", async () => {
    const store = memory();

    await store.save(makeInterrupt({ interruptId: "a" }));
    await store.save(makeInterrupt({ interruptId: "b" }));

    expect((await store.load("a"))?.interruptId).toBe("a");
    expect((await store.load("b"))?.interruptId).toBe("b");
  });

  it("should delete a record, leaving load undefined", async () => {
    const store = memory();

    await store.save(makeInterrupt({ interruptId: "a" }));
    await store.delete("a");

    expect(await store.load("a")).toBeUndefined();
  });

  it("should treat deleting an absent id as a no-op", async () => {
    const store = memory();

    await expect(store.delete("ghost")).resolves.toBeUndefined();
  });

  it("should list every known interrupt id", async () => {
    const store = memory();

    await store.save(makeInterrupt({ interruptId: "a" }));
    await store.save(makeInterrupt({ interruptId: "b" }));

    expect((await store.list!())?.sort()).toEqual(["a", "b"]);
  });

  it("should filter listed ids by prefix", async () => {
    const store = memory();

    await store.save(makeInterrupt({ interruptId: "support.sess-1.0.x" }));
    await store.save(makeInterrupt({ interruptId: "support.sess-2.0.y" }));
    await store.save(makeInterrupt({ interruptId: "billing.sess-9.0.z" }));

    const supportIds = await store.list?.("support.");

    expect(supportIds?.sort()).toEqual([
      "support.sess-1.0.x",
      "support.sess-2.0.y",
    ]);
  });

  it("should return a fresh array from list (no leak of backing keys)", async () => {
    const store = memory();

    await store.save(makeInterrupt({ interruptId: "a" }));

    const first = await store.list!();
    first.push("mutated");

    expect(await store.list!()).toEqual(["a"]);
  });

  it("should expose an empty schema for the memory store", () => {
    const store = memory();

    expect(store.schema()).toBe("");
  });
});
