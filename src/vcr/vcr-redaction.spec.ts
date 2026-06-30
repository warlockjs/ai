import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../contracts/conversation-message.type";
import type { ModelResponse } from "../contracts/model.contract";
import { FakeModel } from "./test-support/make-model";
import { vcr } from "./vcr";
import type { Cassette } from "./vcr.type";

const messages: Message[] = [{ role: "user", content: "my password is hunter2" }];
const response: ModelResponse = {
  content: "noted",
  finishReason: "stop",
  usage: { input: 5, output: 3, total: 8 },
};

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vcr-redact-"));
  path = join(dir, "cassette.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readCassette(): Cassette {
  return JSON.parse(readFileSync(path, "utf8")) as Cassette;
}

describe("vcr — request/response redaction (S2)", () => {
  it("hash-only drops the request body but still replays by recomputed hash", async () => {
    const rec = vcr(new FakeModel("m", "p", [{ response }]), {
      path,
      mode: "record",
      recordRequest: "hash-only",
    });
    await rec.complete(messages);
    await rec.save();

    const stored = readCassette();
    expect(stored.entries[0].request.messages).toEqual([]);
    // The hash is kept verbatim, so a fresh replay still matches.
    expect(stored.entries[0].requestHash).toBeTruthy();

    const replay = vcr(new FakeModel("m", "p", []), { path, mode: "replay" });
    const result = await replay.complete(messages);
    expect(result.content).toBe("noted");
  });

  it("redacted mode applies the redactRequest hook to the stored body", async () => {
    const rec = vcr(new FakeModel("m", "p", [{ response }]), {
      path,
      mode: "record",
      recordRequest: "redacted",
      redactRequest: () => ({ messages: [{ role: "user", content: "[scrubbed]" }] }),
    });
    await rec.complete(messages);
    await rec.save();

    expect(readCassette().entries[0].request.messages[0].content).toBe("[scrubbed]");
  });

  it("applies redactResponse to the stored response", async () => {
    const rec = vcr(new FakeModel("m", "p", [{ response }]), {
      path,
      mode: "record",
      redactResponse: r => ({ ...r, content: "[redacted]" }),
    });
    await rec.complete(messages);
    await rec.save();

    expect(readCassette().entries[0].response?.content).toBe("[redacted]");
  });

  it("applies redactError to a recorded error", async () => {
    const rec = vcr(new FakeModel("m", "p", [{ error: new Error("secret-host unreachable") }]), {
      path,
      mode: "record",
      redactError: () => ({ name: "Error", message: "[redacted]" }),
    });

    await expect(rec.complete(messages)).rejects.toThrow();
    await rec.save();

    expect(readCassette().entries[0].error?.message).toBe("[redacted]");
  });

  it("defaults to verbatim (back-compat) when no redaction is configured", async () => {
    const rec = vcr(new FakeModel("m", "p", [{ response }]), { path, mode: "record" });
    await rec.complete(messages);
    await rec.save();

    expect(readCassette().entries[0].request.messages[0].content).toBe(
      "my password is hunter2",
    );
  });
});
