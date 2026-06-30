import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { directorySource } from "./sources/directory-source";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skills-dir-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write `root/<folder>/SKILL.md` with the given contents. */
function writeSkill(folder: string, contents: string): void {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), contents, "utf8");
}

describe("directory source", () => {
  it("parses SKILL.md front-matter (same shape as generate-llms)", async () => {
    writeSkill(
      "scaffold-form",
      ["---", "description: Scaffold a React form", "tags: frontend, react", "---", "# Body", "Step one."].join(
        "\n",
      ),
    );

    const source = directorySource(root);

    const catalog = await source.list();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      name: "scaffold-form",
      description: "Scaffold a React form",
      version: 1,
      type: "authored",
      tags: ["frontend", "react"],
    });

    const record = await source.load("scaffold-form");
    expect(record?.body).toContain("# Body");
    expect(record?.body).toContain("Step one.");
  });

  it("ignores sub-directories without a SKILL.md and root files", async () => {
    writeSkill("real", ["---", "description: Real", "---", "body"].join("\n"));
    mkdirSync(join(root, "empty-dir"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# index", "utf8");

    const source = directorySource(root);
    const catalog = await source.list();

    expect(catalog.map((entry) => entry.name)).toEqual(["real"]);
  });

  it("yields an empty library for a missing directory", async () => {
    const source = directorySource(join(root, "does-not-exist"));

    expect(await source.list()).toEqual([]);
    expect(await source.load("anything")).toBeUndefined();
  });
});
