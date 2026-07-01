import { describe, expect, it } from "vitest";
import { loadText } from "./load-text";

describe("loadText", () => {
  it("loads a bare string into one RagDocument with the default id + source", () => {
    const [doc, ...rest] = loadText("hello world");

    expect(rest).toHaveLength(0);
    expect(doc.id).toBe("document");
    expect(doc.text).toBe("hello world");
    expect(doc.metadata).toMatchObject({ source: "document", loader: "text" });
  });

  it("honors the option id and merges caller metadata over derived keys", () => {
    const [doc] = loadText("body", {
      id: "notes",
      metadata: { title: "My Notes", source: "overridden" },
      tags: ["a"],
    });

    expect(doc.id).toBe("notes");
    // Caller metadata wins over the derived `source`.
    expect(doc.metadata).toMatchObject({
      source: "overridden",
      loader: "text",
      title: "My Notes",
    });
    expect(doc.tags).toEqual(["a"]);
  });

  it("loads a record input with its own id / metadata / tags", () => {
    const [doc] = loadText({
      id: "faq-1",
      text: "answer",
      metadata: { section: "billing" },
      tags: ["faq"],
    });

    expect(doc.id).toBe("faq-1");
    expect(doc.metadata).toMatchObject({ source: "faq-1", section: "billing" });
    expect(doc.tags).toEqual(["faq"]);
  });

  it("loads an array, suffixing ids for strings and keeping record ids", () => {
    const docs = loadText(
      ["one", { id: "named", text: "two" }, "three"],
      { id: "batch" },
    );

    expect(docs.map((doc) => doc.id)).toEqual([
      "batch#0",
      "named",
      "batch#2",
    ]);
  });

  it("drops empty / whitespace-only items so index() never gets a no-op doc", () => {
    const docs = loadText(["   ", "real", "\n\t"]);

    expect(docs).toHaveLength(1);
    expect(docs[0].text).toBe("real");
  });

  it("returns an empty array when every item is empty", () => {
    expect(loadText(["", "  "])).toEqual([]);
  });
});
