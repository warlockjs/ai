import { describe, expect, it, vi } from "vitest";
import { OutboundPolicyError } from "../../errors";
import type { OutboundPolicy } from "../../security/outbound-policy.type";
import { loadWeb } from "./load-web";

/**
 * Build an injected fetch that returns the given body + headers, plus a base
 * policy that wires it in and disables the post-DNS private-IP guard (no real
 * network / DNS in the spec). The fetch is recorded so we can assert on it.
 */
function fakeWeb(
  body: string,
  headers: Record<string, string> = { "content-type": "text/html" },
  status = 200,
): { policy: OutboundPolicy; fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = vi.fn(
    async () =>
      new Response(body, {
        status,
        statusText: status === 200 ? "OK" : "Error",
        headers,
      }),
  );

  return {
    fetchImpl,
    policy: {
      denyPrivateIPsAfterDNS: false,
      fetch: fetchImpl as unknown as typeof fetch,
    },
  };
}

describe("loadWeb", () => {
  it("fetches via the injected policy fetch and strips HTML to text", async () => {
    const { policy, fetchImpl } = fakeWeb(
      "<html><head><title>Hi</title></head><body><p>Hello</p></body></html>",
    );

    const [doc] = await loadWeb("https://example.com/page", { policy });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(doc.id).toBe("https://example.com/page");
    expect(doc.text).toBe("Hello");
    expect(doc.metadata).toMatchObject({
      source: "https://example.com/page",
      loader: "web",
      title: "Hi",
      contentType: "text/html",
    });
  });

  it("uses a non-HTML body verbatim (no tag strip)", async () => {
    const { policy } = fakeWeb("plain # markdown body", {
      "content-type": "text/plain",
    });

    const [doc] = await loadWeb("https://example.com/notes.md", { policy });

    expect(doc.text).toBe("plain # markdown body");
    // No HTML, so no derived title.
    expect(doc.metadata?.title).toBeUndefined();
  });

  it("NEVER bypasses the policy — a blocked scheme rejects before fetch", async () => {
    const { policy, fetchImpl } = fakeWeb("x");

    // http is not in the default scheme allowlist; the guard rejects it.
    await expect(
      loadWeb("http://example.com/", {
        policy: { ...policy, allowedSchemes: ["https"] },
      }),
    ).rejects.toBeInstanceOf(OutboundPolicyError);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws an OutboundPolicyError on a non-OK response", async () => {
    const { policy } = fakeWeb("nope", { "content-type": "text/html" }, 404);

    await expect(
      loadWeb("https://example.com/missing", { policy }),
    ).rejects.toBeInstanceOf(OutboundPolicyError);
  });

  it("honors a caller id / tags and merges metadata over derived keys", async () => {
    const { policy } = fakeWeb("<p>body</p>");

    const [doc] = await loadWeb("https://example.com/x", {
      policy,
      id: "doc-1",
      tags: ["web"],
      metadata: { source: "kept" },
    });

    expect(doc.id).toBe("doc-1");
    expect(doc.tags).toEqual(["web"]);
    // Caller's `source` overrides the derived URL.
    expect(doc.metadata?.source).toBe("kept");
  });
});
