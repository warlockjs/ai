import { describe, expect, it, vi } from "vitest";
import type { ExecutionReport } from "../contracts/result/execution-report.type";
import type { Observer } from "./observer.contract";
import { notifyObservers } from "./resolve-observers";

const fakeReport = {} as ExecutionReport;

describe("notifyObservers — isolate-but-surface (C5)", () => {
  it("isolates a throwing observer so the flow never sees the error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const observer: Observer = {
      collect() {
        throw new Error("exporter down");
      },
    };

    await expect(notifyObservers(observer, fakeReport)).resolves.toBeUndefined();

    warn.mockRestore();
  });

  it("surfaces a throwing observer via console.warn once per observer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const observer: Observer = {
      collect() {
        throw new Error("exporter down");
      },
    };

    await notifyObservers(observer, fakeReport);
    await notifyObservers(observer, fakeReport);

    // Warned exactly once for THIS observer despite two failures — the
    // warn-once guard keeps a hot path from spamming the log.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("exporter down");

    warn.mockRestore();
  });

  it("prefers a supplied onError over the console warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onError = vi.fn();
    const observer: Observer = {
      collect() {
        throw new Error("boom");
      },
    };

    await notifyObservers(observer, fakeReport, onError);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0]?.[1]).toBe(observer);
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it("never lets a throwing onError escape into the flow", async () => {
    const observer: Observer = {
      collect() {
        throw new Error("boom");
      },
    };
    const onError = () => {
      throw new Error("handler also broke");
    };

    await expect(
      notifyObservers(observer, fakeReport, onError),
    ).resolves.toBeUndefined();
  });

  it("routes the report to a healthy observer and resolves cleanly", async () => {
    const collect = vi.fn();
    const observer: Observer = { collect };

    await notifyObservers(observer, fakeReport);

    expect(collect).toHaveBeenCalledTimes(1);
    expect(collect).toHaveBeenCalledWith(fakeReport);
  });
});
