import { describe, expect, it, vi } from "vitest";
import type { OutboundPolicy } from "../../security/outbound-policy.type";
import { urlSource } from "./url-source";

function withFetch(fetchImpl: () => Promise<Response>): OutboundPolicy {
  return {
    denyPrivateIPsAfterDNS: false,
    fetch: fetchImpl as unknown as typeof fetch,
  };
}

const goodManifest = JSON.stringify([
  {
    name: "greet",
    description: "greeting skill",
    body: "Say hello warmly.",
    version: 2,
    type: "authored",
    tags: ["support"],
  },
]);

describe("urlSource — fetch hardening + manifest validation (S3)", () => {
  it("fetches, validates, and serves a well-formed manifest", async () => {
    const fetchImpl = vi.fn(async () => new Response(goodManifest, { status: 200 }));
    const source = urlSource("https://skills.example.com/m.json", {
      policy: withFetch(fetchImpl),
    });

    const list = await source.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("greet");

    const record = await source.load("greet");
    expect(record?.body).toBe("Say hello warmly.");
    expect(fetchImpl).toHaveBeenCalledTimes(1); // cached after first read
  });

  it("blocks a manifest host that is a private/metadata address (no fetch)", async () => {
    const fetchImpl = vi.fn();
    const source = urlSource("https://169.254.169.254/skills.json", {
      policy: { fetch: fetchImpl as unknown as typeof fetch },
    });

    await expect(source.list()).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a malformed manifest record (missing body)", async () => {
    const bad = JSON.stringify([{ name: "x", description: "d" }]);
    const source = urlSource("https://skills.example.com/m.json", {
      policy: withFetch(async () => new Response(bad, { status: 200 })),
    });

    await expect(source.list()).rejects.toThrow(/missing a string "body"/);
  });

  it("rejects a manifest that is not a JSON array", async () => {
    const source = urlSource("https://skills.example.com/m.json", {
      policy: withFetch(
        async () => new Response(JSON.stringify({ not: "an array" }), { status: 200 }),
      ),
    });

    await expect(source.list()).rejects.toThrow(/must return a JSON array/);
  });

  it("honors a host allowlist and never fetches a disallowed host", async () => {
    const fetchImpl = vi.fn(async () => new Response(goodManifest));
    const source = urlSource("https://evil.example.com/m.json", {
      policy: {
        hostAllowlist: ["skills.example.com"],
        denyPrivateIPsAfterDNS: false,
        fetch: fetchImpl as unknown as typeof fetch,
      },
    });

    await expect(source.list()).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
