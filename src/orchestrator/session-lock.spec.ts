import { describe, expect, it } from "vitest";
import { inProcessSessionLock, noopSessionLock } from "./session-lock";

/** A manually-resolvable promise for orchestrating the test timeline. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush pending microtasks + one macrotask turn. */
function tick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe("inProcessSessionLock — serialization (C4)", () => {
  it("serializes concurrent calls for the same key in arrival order", async () => {
    const lock = inProcessSessionLock();
    const events: string[] = [];
    const gate = deferred();

    const a = lock.withLock("s", async () => {
      events.push("a:start");
      await gate.promise;
      events.push("a:end");
    });
    const b = lock.withLock("s", async () => {
      events.push("b:start");
      events.push("b:end");
    });

    // While A holds the lock, B must NOT have started — its critical
    // section is queued behind A's release.
    await tick();
    expect(events).toEqual(["a:start"]);

    gate.resolve();
    await Promise.all([a, b]);

    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("runs different keys concurrently (no cross-session contention)", async () => {
    const lock = inProcessSessionLock();
    const gateA = deferred();
    let bRan = false;

    const a = lock.withLock("A", async () => {
      await gateA.promise;
    });
    const b = lock.withLock("B", async () => {
      bRan = true;
    });

    // B completes without waiting for A's still-held lock.
    await b;
    expect(bRan).toBe(true);

    gateA.resolve();
    await a;
  });

  it("releases the lock for the next waiter even when fn rejects", async () => {
    const lock = inProcessSessionLock();

    await expect(
      lock.withLock("s", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // A failed turn must not wedge the session — the next turn proceeds.
    await expect(lock.withLock("s", async () => "ok")).resolves.toBe("ok");
  });

  it("aborts a queued waiter without deadlocking the holder", async () => {
    const lock = inProcessSessionLock();
    const gate = deferred();

    const holder = lock.withLock("s", async () => {
      await gate.promise;
      return "held";
    });

    const controller = new AbortController();
    const waiter = lock.withLock("s", async () => "waited", {
      signal: controller.signal,
    });

    controller.abort(new Error("cancelled"));

    // The queued waiter rejects with the abort reason...
    await expect(waiter).rejects.toThrow("cancelled");

    // ...and the holder still completes — no deadlock-on-cancel.
    gate.resolve();
    await expect(holder).resolves.toBe("held");
  });

  it("a free lock acquires even with an already-aborted signal", async () => {
    const lock = inProcessSessionLock();
    const controller = new AbortController();
    controller.abort(new Error("aborted"));

    // No contention → fn runs. The signal gates only a genuine wait, so
    // the wrapped work (e.g. the orchestrator turn) keeps ownership of
    // graceful cancellation instead of being pre-empted by the lock.
    await expect(
      lock.withLock("s", async () => "ran", { signal: controller.signal }),
    ).resolves.toBe("ran");
  });

  it("rejects a pre-aborted waiter that is queued behind a holder", async () => {
    const lock = inProcessSessionLock();
    const gate = deferred();

    const holder = lock.withLock("s", async () => {
      await gate.promise;
      return "held";
    });

    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    const waiter = lock.withLock("s", async () => "never", {
      signal: controller.signal,
    });

    await expect(waiter).rejects.toThrow("pre-aborted");
    gate.resolve();
    await expect(holder).resolves.toBe("held");
  });
});

describe("noopSessionLock", () => {
  it("runs fn with no serialization", async () => {
    const lock = noopSessionLock();
    const order: string[] = [];
    const gate = deferred();

    const a = lock.withLock("s", async () => {
      order.push("a:start");
      await gate.promise;
      order.push("a:end");
    });
    const b = lock.withLock("s", async () => {
      order.push("b");
    });

    // With no lock, B runs while A is still holding.
    await b;
    expect(order).toEqual(["a:start", "b"]);

    gate.resolve();
    await a;
  });
});
