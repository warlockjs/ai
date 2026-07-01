import { describe, expect, it, vi } from "vitest";
import { loadPdf } from "./load-pdf";

// Simulate `pdf-parse` NOT being installed: the dynamic import rejects, so the
// loader's flag flips to false and loadPdf must throw the curated install
// string on first call — never a raw module-resolution error. `vi.mock` is
// hoisted above the imports, so the stub applies to loadPdf's lazy
// `import("pdf-parse")`.
vi.mock("pdf-parse", () => {
  throw new Error("Cannot find module 'pdf-parse'");
});

describe("loadPdf (missing pdf-parse peer)", () => {
  it("throws curated install instructions when pdf-parse is absent", async () => {
    await expect(loadPdf(Buffer.from("%PDF-1.4"))).rejects.toThrow(
      /requires the optional "pdf-parse" peer/,
    );
  });
});
