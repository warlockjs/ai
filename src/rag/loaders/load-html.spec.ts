import { describe, expect, it } from "vitest";
import { loadHtml } from "./load-html";

const PAGE = `
<!DOCTYPE html>
<html>
  <head>
    <title>Caching &amp; You</title>
    <style>.x { color: red; }</style>
    <script>console.log("should not leak")</script>
  </head>
  <body>
    <h1>Caching Guide</h1>
    <p>First paragraph with an &mdash; entity and &#169; sign.</p>
    <!-- <script>also commented out</script> -->
    <ul><li>One</li><li>Two</li></ul>
    <noscript>Enable JS</noscript>
  </body>
</html>
`;

describe("loadHtml", () => {
  it("strips scripts / styles and decodes entities into one RagDocument", () => {
    const [doc, ...rest] = loadHtml(PAGE, { id: "guide" });

    expect(rest).toHaveLength(0);
    expect(doc.id).toBe("guide");
    expect(doc.text).toContain("Caching Guide");
    expect(doc.text).toContain("—"); // &mdash; decoded
    expect(doc.text).toContain("©"); // &#169; decoded
    // Script / style / noscript bodies must NOT survive.
    expect(doc.text).not.toContain("should not leak");
    expect(doc.text).not.toContain("color: red");
    expect(doc.text).not.toContain("also commented out");
    expect(doc.text).not.toContain("Enable JS");
  });

  it("lifts the <title> into metadata and stamps loader: html", () => {
    const [doc] = loadHtml(PAGE);

    expect(doc.metadata).toMatchObject({
      title: "Caching & You",
      loader: "html",
      source: "document",
    });
  });

  it("preserves paragraph structure as blank-line separators", () => {
    const [doc] = loadHtml(
      "<p>alpha</p><p>beta</p>",
    );

    // Each <p> open + close becomes a newline, so adjacent paragraphs end up
    // separated by a blank line the recursive splitter honors.
    expect(doc.text).toBe("alpha\n\nbeta");
  });

  it("lets caller metadata override the derived title", () => {
    const [doc] = loadHtml(PAGE, { metadata: { title: "Custom" } });

    expect(doc.metadata?.title).toBe("Custom");
  });

  it("returns no document when the markup strips to nothing", () => {
    expect(loadHtml("<style>.a{}</style><script>x()</script>")).toEqual([]);
  });
});
