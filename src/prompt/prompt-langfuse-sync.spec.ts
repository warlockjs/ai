import { describe, expect, it, vi } from "vitest";
import { prompt } from "./prompt";
import { syncLangfusePrompts } from "./prompt-langfuse-sync";
import type {
  LangfuseClientLike,
  LangfusePromptLike,
} from "./prompt-langfuse-sync.type";

/** A fake Langfuse-prompts client recording its calls for assertions. */
function makeFakeClient(
  remote: Record<string, LangfusePromptLike> = {},
): LangfuseClientLike & { created: LangfusePromptLike[] } {
  const created: LangfusePromptLike[] = [];

  return {
    created,
    async getPrompt(name: string): Promise<LangfusePromptLike> {
      const found = remote[name];

      if (!found) {
        throw new Error(`no remote prompt "${name}"`);
      }

      return found;
    },
    async createPrompt(body): Promise<LangfusePromptLike> {
      const entry: LangfusePromptLike = {
        name: body.name,
        version: created.length + 1,
        prompt: body.prompt,
      };
      created.push(entry);

      return entry;
    },
  };
}

describe("syncLangfusePrompts — pull", () => {
  it("pulls a remote prompt and upserts it as a PromptEntry", async () => {
    const client = makeFakeClient({
      "support-agent": { name: "support-agent", version: 3, prompt: "You are support." },
    });

    const upserted: string[] = [];

    await syncLangfusePrompts(
      { client, direction: "pull" },
      ["support-agent"],
      [],
      entry => {
        upserted.push(`${entry.name}@${entry.versions[0].version}`);
        expect(entry.versions[0].template).toBe("You are support.");
      },
    );

    expect(upserted).toEqual(["support-agent@3"]);
  });

  it("defaults to pull when no direction is set", async () => {
    const client = makeFakeClient({
      a: { name: "a", version: 1, prompt: "You are A." },
    });

    const upserted: string[] = [];
    await syncLangfusePrompts({ client }, ["a"], [], entry => upserted.push(entry.name));

    expect(upserted).toEqual(["a"]);
  });
});

describe("syncLangfusePrompts — push", () => {
  it("pushes the latest local version of each entry", async () => {
    const client = makeFakeClient();

    await syncLangfusePrompts(
      { client, direction: "push" },
      [],
      [
        {
          name: "a",
          versions: [
            { version: "1", template: "old" },
            { version: "2", template: "newest" },
          ],
        },
      ],
      () => {
        throw new Error("upsert should not run on push");
      },
    );

    expect(client.created).toHaveLength(1);
    expect(client.created[0].prompt).toBe("newest");
  });

  it("does both directions when direction is 'both'", async () => {
    const client = makeFakeClient({
      remote: { name: "remote", version: 1, prompt: "remote body" },
    });

    const upserted: string[] = [];

    await syncLangfusePrompts(
      { client, direction: "both" },
      ["remote"],
      [{ name: "local", versions: [{ version: "1", template: "local body" }] }],
      entry => upserted.push(entry.name),
    );

    expect(upserted).toEqual(["remote"]);
    expect(client.created).toHaveLength(1);
    expect(client.created[0].name).toBe("local");
  });
});

describe("syncLangfusePrompts — missing langfuse peer", () => {
  it("throws the curated install string when the SDK is absent and no client supplied", async () => {
    vi.doMock("langfuse", () => {
      throw new Error("Cannot find module 'langfuse'");
    });

    // Re-import after mocking so the module-level loader sees the rejecting import.
    const fresh = await import("./prompt-langfuse-sync");

    await expect(
      fresh.syncLangfusePrompts({ publicKey: "pk", secretKey: "sk" }, ["a"], [], () => {}),
    ).rejects.toThrow(/requires the langfuse package/);

    vi.doUnmock("langfuse");
    vi.resetModules();
  });
});

describe("prompt().sync — no langfuse option", () => {
  it("resolves as a no-op when no langfuse sync is configured", async () => {
    const registry = prompt({
      prompts: [{ name: "a", versions: [{ version: "1", template: "You are A." }] }],
    });

    await expect(registry.sync()).resolves.toBeUndefined();
  });

  it("pulls into the catalog through a supplied client", async () => {
    const client = makeFakeClient({
      "remote-prompt": { name: "remote-prompt", version: 5, prompt: "You are remote." },
    });

    const registry = prompt({
      prompts: [{ name: "remote-prompt", versions: [] }],
      langfuse: { client, direction: "pull" },
    });

    await registry.sync();

    expect(registry.has("remote-prompt")).toBe(true);
    expect(registry.versions("remote-prompt").some(v => v.version === "5")).toBe(true);
  });
});
