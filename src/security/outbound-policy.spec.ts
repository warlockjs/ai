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

describe("guardedFetch — redirect re-validation (SSRF hardening)", () => {
  /** A 3xx `Response` pointing at `location`. */
  function redirectResponse(location: string, status = 302): Response {
    return new Response(null, { status, headers: { location } });
  }

  it("blocks a redirect from an allowed public host into the metadata endpoint", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("https://169.254.169.254/latest/meta-data/"))
      .mockResolvedValue(new Response("secrets"));

    await expect(
      guardedFetch("https://8.8.8.8/page", {
        fetch: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(OutboundPolicyError);

    // The metadata endpoint is never fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("blocks a redirect to a loopback / private target", async () => {
    for (const location of ["https://127.0.0.1:6379/", "https://10.0.0.5/admin"]) {
      const fetchImpl = vi.fn().mockResolvedValue(redirectResponse(location));

      await expect(
        guardedFetch("https://8.8.8.8/page", {
          fetch: fetchImpl as unknown as typeof fetch,
        }),
        location,
      ).rejects.toBeInstanceOf(OutboundPolicyError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("blocks a redirect to a host outside the allowlist", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(redirectResponse("https://1.1.1.1/steal"));

    await expect(
      guardedFetch("https://8.8.8.8/page", {
        hostAllowlist: ["8.8.8.8"],
        denyPrivateIPsAfterDNS: false,
        fetch: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(OutboundPolicyError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows a policy-clean redirect and returns the final response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("https://8.8.8.8/moved"))
      .mockResolvedValueOnce(new Response("final"));

    const response = await guardedFetch("https://8.8.8.8/page", {
      fetch: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1][0])).toBe("https://8.8.8.8/moved");
    expect(await response.text()).toBe("final");
  });

  it("caps the number of redirect hops", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(redirectResponse("https://8.8.8.8/loop"));

    await expect(
      guardedFetch("https://8.8.8.8/page", {
        maxRedirects: 3,
        fetch: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(OutboundPolicyError);
    // Initial request + 3 followed hops, then the cap trips.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("returns the raw 3xx when the caller asked for redirect: \"manual\"", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(redirectResponse("https://169.254.169.254/"));

    const response = await guardedFetch(
      "https://8.8.8.8/page",
      { fetch: fetchImpl as unknown as typeof fetch },
      { redirect: "manual" },
    );

    expect(response.status).toBe(302);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("strips credential headers when a redirect crosses an origin boundary", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("https://1.1.1.1/next"))
      .mockResolvedValueOnce(new Response("ok"));

    await guardedFetch(
      "https://8.8.8.8/page",
      { fetch: fetchImpl as unknown as typeof fetch },
      { headers: { authorization: "Bearer secret", "x-app": "warlock" } },
    );

    const firstHeaders = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    const secondHeaders = fetchImpl.mock.calls[1][1].headers as Record<string, string>;
    expect(firstHeaders.authorization).toBe("Bearer secret");
    expect(secondHeaders.authorization).toBeUndefined();
    expect(secondHeaders["x-app"]).toBe("warlock");
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
