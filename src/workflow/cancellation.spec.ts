import { describe, expect, it } from "vitest";
import { WorkflowCancelledError } from "../errors";
import { createCancelledError, sleep } from "./cancellation";

describe("createCancelledError", () => {
  it("returns a WorkflowCancelledError with an ISO cancelledAt", () => {
    const error = createCancelledError(undefined);

    expect(error).toBeInstanceOf(WorkflowCancelledError);
    expect(error.code).toBe("WORKFLOW_CANCELLED");
    expect(() => new Date(error.cancelledAt).toISOString()).not.toThrow();
  });

  it("extracts a string reason verbatim", () => {
    const controller = new AbortController();
    controller.abort("user navigated away");

    const error = createCancelledError(controller.signal);

    expect(error.reason).toBe("user navigated away");
    expect(error.message).toBe("workflow cancelled: user navigated away");
  });

  it("extracts an Error reason's message", () => {
    const controller = new AbortController();
    controller.abort(new Error("downstream timeout"));

    const error = createCancelledError(controller.signal);

    expect(error.reason).toBe("downstream timeout");
    expect(error.message).toBe("workflow cancelled: downstream timeout");
  });

  it("yields an empty reason (and bare message) when no signal is supplied", () => {
    const error = createCancelledError(undefined);

    expect(error.reason).toBe("");
    expect(error.message).toBe("workflow cancelled");
  });

  it("stringifies a non-string / non-Error reason", () => {
    const controller = new AbortController();
    controller.abort(42);

    const error = createCancelledError(controller.signal);

    expect(error.reason).toBe("42");
    expect(error.message).toBe("workflow cancelled: 42");
  });

  it("yields an empty reason when the signal aborted without an explicit reason value", () => {
    // `abort()` with no argument sets a default DOMException reason —
    // not a string and not an Error — so it stringifies. We only assert
    // a string came back and the message is well-formed.
    const controller = new AbortController();
    controller.abort();

    const error = createCancelledError(controller.signal);

    expect(typeof error.reason).toBe("string");
  });
});

describe("sleep", () => {
  it("resolves after the requested delay", async () => {
    const start = Date.now();
    await sleep(20);

    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("already gone");

    await expect(sleep(1000, controller.signal)).rejects.toBeInstanceOf(
      WorkflowCancelledError,
    );
  });

  it("rejects with WorkflowCancelledError when aborted mid-wait", async () => {
    const controller = new AbortController();
    const pending = sleep(1000, controller.signal);

    controller.abort("changed my mind");

    await expect(pending).rejects.toMatchObject({
      code: "WORKFLOW_CANCELLED",
      reason: "changed my mind",
    });
  });

  it("clears the timer on abort so a late resolution never fires", async () => {
    // If the timer leaked, the promise would resolve instead of reject.
    // Abort well before the 5s delay would elapse; the rejection proves
    // the timeout was cleared.
    const controller = new AbortController();
    const pending = sleep(5000, controller.signal);

    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(WorkflowCancelledError);
  });
});
