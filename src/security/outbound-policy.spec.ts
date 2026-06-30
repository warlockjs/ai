import { describe, expect, it, vi } from "vitest";
import { OutboundPolicyError } from "../errors";
import {
  fetchTextWithPolicy,
  guardedFetch,
  readTextCapped,
  resolveOutboundPolicy,
} from "./outbound-policy";

describe("resolveOutboundPolicy", () => {
  it("fills strict defaults", () => {
    const policy = resolveOutboundPolicy();
    expect(policy.allowedSchemes).toEqual(["https"]);
    expect(policy.denyPrivateIPsAfterDNS).toBe(true);
    expect(policy.maxBytes).toBe(5 * 1024 * 1024);
    expect(policy.timeoutMs).toBe(10_000);
  });

  it("is idempotent and respects overrides", () => {
    const once = resolveOutboundPolicy({ allowedSchemes: ["http", "https"], maxBytes: 10 });
    const twice = resolveOutboundPolicy(once);
    expect(twice.allowedSchemes).toEqual(["http", "https"]);
    expect(twice.maxBytes).toBe(10);
  });
});

describe("guardedFetch — SSRF guards (S1/S3 foundation)", () => {
  it("rejects a disallowed scheme (http blocked by default)", async () => {
    await expect(guardedFetch("http://8.8.8.8/x", {})).rejects.toBeInstanceOf(
      OutboundPolicyError,
    );
  });

  it("rejects private / loopback / metadata IP literals", async () => {
    for (const url of [
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/x",
      "https://[::1]/x",
    ]) {
      await expect(guardedFetch(url, {}), url).rejects.toBeInstanceOf(
        OutboundPolicyError,
      );
    }
  });

  it("rejects a host outside the allowlist", async () => {
    await expect(
      guardedFetch("https://8.8.8.8/x", {
        hostAllowlist: ["example.com"],
        denyPrivateIPsAfterDNS: false,
      }),
    ).rejects.toBeInstanceOf(OutboundPolicyError);
  });

  it("allows a subdomain of an allowlisted host and uses the injected fetch", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));

    const response = await guardedFetch("https://a.cdn.example.com/x", {
      hostAllowlist: ["cdn.example.com"],
      denyPrivateIPsAfterDNS: false,
      fetch: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("ok");
  });

  it("times out and aborts the request", async () => {
    const hangingFetch = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason ?? new Error("aborted")),
          );
        }),
    );

    await expect(
      guardedFetch("https://8.8.8.8/slow", {
        denyPrivateIPsAfterDNS: false,
        timeoutMs: 10,
        fetch: hangingFetch as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(OutboundPolicyError);
  });
});

describe("readTextCapped — body size cap", () => {
  it("returns a small body unchanged", async () => {
    const text = await readTextCapped(new Response("hello"), 1024);
    expect(text).toBe("hello");
  });

  it("throws when the streamed body exceeds the cap", async () => {
    const big = "x".repeat(5000);
    await expect(readTextCapped(new Response(big), 100)).rejects.toBeInstanceOf(
      OutboundPolicyError,
    );
  });

  it("fails fast on an over-cap content-length header", async () => {
    const response = new Response("hi", {
      headers: { "content-length": "99999" },
    });
    await expect(readTextCapped(response, 100)).rejects.toBeInstanceOf(
      OutboundPolicyError,
    );
  });
});

describe("fetchTextWithPolicy", () => {
  it("guards, fetches via the injected impl, and returns capped text", async () => {
    const fetchImpl = vi.fn(async () => new Response("manifest-body"));

    const result = await fetchTextWithPolicy("https://8.8.8.8/m.json", {
      denyPrivateIPsAfterDNS: false,
      fetch: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.text).toBe("manifest-body");
  });
});
