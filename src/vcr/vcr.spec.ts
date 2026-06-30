import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../contracts/conversation-message.type";
import type { ModelResponse, ModelStreamChunk } from "../contracts/model.contract";
import { VcrCassetteMissError } from "./errors";
import { FakeModel } from "./test-support/make-model";
import { vcr } from "./vcr";
import type { Cassette } from "./vcr.type";

const messages: Message[] = [{ role: "user", content: "hi" }];

const response: ModelResponse = {
  content: "Hello!",
  finishReason: "stop",
  usage: { input: 5, output: 3, total: 8 },
};

const streamChunks: ModelStreamChunk[] = [
  { type: "delta", content: "Hel" },
  { type: "delta", content: "lo" },
  { type: "tool-call", id: "call_1", name: "noop", input: { a: 1 } },
  { type: "done", finishReason: "stop", usage: { input: 5, output: 3, total: 8 } },
];

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vcr-"));
  path = join(dir, "cassette.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readCassette(): Cassette {
  return JSON.parse(readFileSync(path, "utf8")) as Cassette;
}

describe("vcr — delegation", () => {
  it("delegates name/provider/capabilities/pricing to the inner model", () => {
    const inner = new FakeModel("gpt-4o", "openai");
    const model = vcr(inner, { path });

    expect(model.name).toBe("gpt-4o");
    expect(model.provider).toBe("openai");
    expect(model.capabilities).toBe(inner.capabilities);
    expect(model.pricing).toBe(inner.pricing);
  });
});

describe("vcr — record mode", () => {
  it("calls the inner model and appends one entry per complete()", async () => {
    const inner = new FakeModel("m", "p", [{ response }]);
    const model = vcr(inner, { path, mode: "record" });

    const result = await model.complete(messages);

    expect(result).toEqual(response);
    expect(inner.completeCalls).toBe(1);
    expect(model.cassette.entries).toHaveLength(1);
    expect(model.cassette.entries[0].response).toEqual(response);
  });

  it("records even on a hash hit (no replay in record mode)", async () => {
    const inner = new FakeModel("m", "p", [{ response }, { response }]);
    const model = vcr(inner, { path, mode: "record" });

    await model.complete(messages);
    await model.complete(messages);

    expect(inner.completeCalls).toBe(2);
    expect(model.cassette.entries).toHaveLength(2);
  });
});

describe("vcr — replay mode", () => {
  it("returns the recorded response without calling the inner model", async () => {
    const recorder = vcr(new FakeModel("m", "p", [{ response }]), { path, mode: "record" });
    await recorder.complete(messages);
    await recorder.save();

    const inner = new FakeModel("m", "p", []);
    const player = vcr(inner, { path, mode: "replay" });

    const result = await player.complete(messages);

    expect(result).toEqual(response);
    expect(inner.completeCalls).toBe(0);
  });

  it("throws VcrCassetteMissError on a miss (never a live call)", async () => {
    const inner = new FakeModel("m", "p", [{ response }]);
    const player = vcr(inner, { path, mode: "replay" });

    await expect(player.complete(messages)).rejects.toBeInstanceOf(VcrCassetteMissError);
    expect(inner.completeCalls).toBe(0);
  });

  it("attaches requestHash and path to the miss error", async () => {
    const player = vcr(new FakeModel(), { path, mode: "replay" });

    try {
      await player.complete(messages);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(VcrCassetteMissError);
      expect((error as VcrCassetteMissError).path).toBe(path);
      expect((error as VcrCassetteMissError).requestHash).toBeTruthy();
      expect((error as VcrCassetteMissError).code).toBe("VCR_CASSETTE_MISS");
    }
  });
});

describe("vcr — auto mode", () => {
  it("records on a miss then replays on a hit", async () => {
    const inner = new FakeModel("m", "p", [{ response }]);
    const model = vcr(inner, { path, mode: "auto" });

    const first = await model.complete(messages);
    const second = await model.complete(messages);

    expect(first).toEqual(response);
    expect(second).toEqual(response);
    expect(inner.completeCalls).toBe(1); // second served from cassette
  });

  it("defaults to auto when no mode given", async () => {
    const inner = new FakeModel("m", "p", [{ response }]);
    const model = vcr(inner, { path });

    await model.complete(messages);
    await model.complete(messages);

    expect(inner.completeCalls).toBe(1);
  });
});

describe("vcr — stream()", () => {
  it("round-trips the delta/tool-call/done chunk order", async () => {
    const recorder = vcr(new FakeModel("m", "p", [{ chunks: streamChunks }]), {
      path,
      mode: "record",
    });

    const recorded: ModelStreamChunk[] = [];
    for await (const chunk of recorder.stream(messages)) {
      recorded.push(chunk);
    }
    await recorder.save();

    expect(recorded).toEqual(streamChunks);

    const inner = new FakeModel("m", "p", []);
    const player = vcr(inner, { path, mode: "replay" });

    const replayed: ModelStreamChunk[] = [];
    for await (const chunk of player.stream(messages)) {
      replayed.push(chunk);
    }

    expect(replayed).toEqual(streamChunks);
    expect(inner.streamCalls).toBe(0);
  });

  it("throws VcrCassetteMissError when streaming a missing entry in replay", async () => {
    const player = vcr(new FakeModel(), { path, mode: "replay" });

    await expect(async () => {
      for await (const _chunk of player.stream(messages)) {
        // drain
      }
    }).rejects.toBeInstanceOf(VcrCassetteMissError);
  });
});

describe("vcr — error capture", () => {
  it("records a thrown error and re-throws it on replay", async () => {
    const boom = new Error("provider exploded");
    boom.name = "ProviderError";

    const recorder = vcr(new FakeModel("m", "p", [{ error: boom }]), { path, mode: "record" });
    await expect(recorder.complete(messages)).rejects.toThrow("provider exploded");
    await recorder.save();

    const inner = new FakeModel("m", "p", []);
    const player = vcr(inner, { path, mode: "replay" });

    await expect(player.complete(messages)).rejects.toThrow("provider exploded");
    expect(inner.completeCalls).toBe(0);
  });
});

describe("vcr — save()", () => {
  it("flushes recorded entries to disk", async () => {
    const model = vcr(new FakeModel("m", "p", [{ response }]), { path, mode: "record" });
    await model.complete(messages);
    await model.save();

    const onDisk = readCassette();
    expect(onDisk.version).toBe(1);
    expect(onDisk.model).toBe("m");
    expect(onDisk.provider).toBe("p");
    expect(onDisk.entries).toHaveLength(1);
  });

  it("is a no-op in pure replay (writes nothing new)", async () => {
    const recorder = vcr(new FakeModel("m", "p", [{ response }]), { path, mode: "record" });
    await recorder.complete(messages);
    await recorder.save();

    const before = readFileSync(path, "utf8");

    const player = vcr(new FakeModel("m", "p", []), { path, mode: "replay" });
    await player.complete(messages);
    await player.save();

    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("exposes the cassette for assertions", async () => {
    const model = vcr(new FakeModel("m", "p", [{ response }]), { path, mode: "record" });

    expect(model.cassette.entries).toHaveLength(0);
    await model.complete(messages);
    expect(model.cassette.entries).toHaveLength(1);
  });
});

describe("vcr — hashOptions", () => {
  it("treats calls differing only by an excluded option as the same entry", async () => {
    const inner = new FakeModel("m", "p", [{ response }]);
    const model = vcr(inner, { path, mode: "auto", hashOptions: ["temperature"] });

    await model.complete(messages, { temperature: 0.2, maxTokens: 100 });
    await model.complete(messages, { temperature: 0.2, maxTokens: 999 });

    expect(inner.completeCalls).toBe(1); // maxTokens not hashed → cache hit
  });
});
