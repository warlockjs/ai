import { describe, expect, it } from "vitest";
import { InvalidRequestError } from "../errors";
import { resolveAttachment } from "./resolve-attachment";

describe("resolveAttachment", () => {
  it("classifies https urls", () => {
    expect(resolveAttachment("https://cdn.example.com/doc.pdf")).toEqual({
      type: "url",
      value: "https://cdn.example.com/doc.pdf",
    });
  });

  it("classifies http urls", () => {
    expect(resolveAttachment("http://example.com/x.png")).toEqual({
      type: "url",
      value: "http://example.com/x.png",
    });
  });

  it("classifies case-insensitive urls", () => {
    expect(resolveAttachment("HTTPS://Example.COM/x.png").type).toBe("url");
  });

  it("classifies plain strings as paths", () => {
    expect(resolveAttachment("/tmp/report.pdf")).toEqual({
      type: "path",
      value: "/tmp/report.pdf",
    });
  });

  it("classifies relative paths", () => {
    expect(resolveAttachment("./uploads/file.pdf")).toEqual({
      type: "path",
      value: "./uploads/file.pdf",
    });
  });

  it("prefers absolutePath over url for storage files", () => {
    const resolved = resolveAttachment({
      url: "https://cdn/x.png",
      absolutePath: "/var/x.png",
    });

    expect(resolved).toEqual({ type: "path", value: "/var/x.png" });
  });

  it("falls back to absolutePath when storage file has no url", () => {
    const resolved = resolveAttachment({ absolutePath: "/var/x.png" });

    expect(resolved).toEqual({ type: "path", value: "/var/x.png" });
  });

  it("resolves tagged image with string source", () => {
    expect(
      resolveAttachment({ type: "image", source: "/tmp/cat.png" }),
    ).toEqual({
      type: "path",
      value: "/tmp/cat.png",
    });
  });

  it("resolves tagged image with url source", () => {
    expect(
      resolveAttachment({ type: "image", source: "https://cdn/x.jpg" }),
    ).toEqual({
      type: "url",
      value: "https://cdn/x.jpg",
    });
  });

  it("resolves tagged image with inline base64 source", () => {
    expect(
      resolveAttachment({
        type: "image",
        source: { base64: "iVBORw0KGgo=", mediaType: "image/png" },
      }),
    ).toEqual({
      type: "base64",
      value: "iVBORw0KGgo=",
      mediaType: "image/png",
    });
  });

  it("resolves tagged image with storage file source (absolutePath wins)", () => {
    expect(
      resolveAttachment({
        type: "image",
        source: { url: "https://cdn/y.jpg", absolutePath: "/var/y.jpg" },
      }),
    ).toEqual({ type: "path", value: "/var/y.jpg" });
  });

  it("throws InvalidRequestError on empty string", () => {
    expect(() => resolveAttachment("")).toThrow(InvalidRequestError);
    expect(() => resolveAttachment("")).toThrow(/empty/);
  });

  it("throws InvalidRequestError when input has no url, absolutePath, or base64", () => {
    expect(() => resolveAttachment({})).toThrow(InvalidRequestError);
    expect(() => resolveAttachment({})).toThrow(
      /Unrecognized attachment source/,
    );
  });

  it("throws InvalidRequestError when storage file has url/absolutePath keys but both are empty", () => {
    expect(() =>
      resolveAttachment({ url: undefined, absolutePath: undefined }),
    ).toThrow(/neither url nor absolutePath/);
  });

  it("throws InvalidRequestError on inline source missing mediaType", () => {
    expect(() =>
      resolveAttachment({
        type: "image",
        source: { base64: "x", mediaType: "" },
      }),
    ).toThrow(InvalidRequestError);
    expect(() =>
      resolveAttachment({
        type: "image",
        source: { base64: "x", mediaType: "" },
      }),
    ).toThrow(/base64.*mediaType/);
  });
});
