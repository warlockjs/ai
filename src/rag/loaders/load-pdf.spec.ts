import { describe, expect, it, vi } from "vitest";
import { loadPdf } from "./load-pdf";

// Stub the OPTIONAL `pdf-parse` peer so loadPdf's lazy `import("pdf-parse")`
// resolves to a fake whose default export is the callable parser (the
// pdf-parse CJS shape). When `options.pagerender` is supplied (the perPage
// path) we drive it once per fake page so the loader builds per-page docs.
const FAKE_PAGES = ["Page one text.", "Page two text."];

const parse = vi.fn(
  async (
    _data: Buffer,
    options?: { pagerender?: (page: unknown) => unknown },
  ) => {
    if (options?.pagerender) {
      for (const pageText of FAKE_PAGES) {
        // Each fake page exposes a getTextContent the loader's renderer calls.
        await options.pagerender({
          getTextContent: async () => ({
            items: pageText.split(" ").map((str) => ({ str })),
          }),
        });
      }
    }

    return {
      text: FAKE_PAGES.join("\n\n"),
      numpages: FAKE_PAGES.length,
      info: { Title: "Fake PDF" },
    };
  },
);

vi.mock("pdf-parse", () => ({ default: parse }));

const BYTES = Buffer.from("%PDF-1.4 fake");

describe("loadPdf (lazy pdf-parse import)", () => {
  it("loads the whole PDF into one document with pageCount + title", async () => {
    const [doc, ...rest] = await loadPdf(BYTES, { id: "guide" });

    expect(rest).toHaveLength(0);
    expect(doc.id).toBe("guide");
    expect(doc.text).toContain("Page one text.");
    expect(doc.metadata).toMatchObject({
      source: "guide",
      loader: "pdf",
      pageCount: 2,
      title: "Fake PDF",
    });
  });

  it("emits one document per page with perPage: true", async () => {
    const docs = await loadPdf(BYTES, { id: "manual", perPage: true });

    expect(docs).toHaveLength(2);
    expect(docs.map((doc) => doc.id)).toEqual(["manual#p1", "manual#p2"]);
    expect(docs[0].metadata).toMatchObject({ page: 1, pageCount: 2, loader: "pdf" });
    expect(docs[1].text).toBe("Page two text.");
  });

  it("accepts a Uint8Array / ArrayBuffer input", async () => {
    const u8 = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const docs = await loadPdf(u8, { id: "u8" });

    expect(docs[0].id).toBe("u8");
    // The parser received a Buffer regardless of input shape.
    const lastCall = parse.mock.calls[parse.mock.calls.length - 1];
    expect(Buffer.isBuffer(lastCall?.[0])).toBe(true);
  });

  it("applies caller tags + metadata merge", async () => {
    const [doc] = await loadPdf(BYTES, {
      id: "x",
      tags: ["pdf"],
      metadata: { title: "Override" },
    });

    expect(doc.tags).toEqual(["pdf"]);
    expect(doc.metadata?.title).toBe("Override");
  });
});
