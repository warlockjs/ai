import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { InvalidRequestError } from "../errors";
import { prepareAttachmentPart } from "./prepare-attachment-part";

describe("prepareAttachmentPart", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "warlock-ai-attach-"));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("infers an image url from a string with a known extension", async () => {
    const part = await prepareAttachmentPart("https://cdn.example.com/cat.png");

    expect(part).toEqual({
      type: "image",
      source: { url: "https://cdn.example.com/cat.png" },
    });
  });

  it("strips query strings before inferring extension", async () => {
    const part = await prepareAttachmentPart(
      "https://cdn.example.com/cat.jpg?v=2",
    );

    expect(part).toEqual({
      type: "image",
      source: { url: "https://cdn.example.com/cat.jpg?v=2" },
    });
  });

  it("rejects strings without a recognized extension with InvalidRequestError", async () => {
    await expect(
      prepareAttachmentPart("https://example.com/data.bin"),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(
      prepareAttachmentPart("https://example.com/data.bin"),
    ).rejects.toThrow(/Cannot infer attachment type/);
  });

  it("reads local image files and base64-encodes them", async () => {
    const filePath = join(tempDir, "pixel.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    await writeFile(filePath, bytes);

    const part = await prepareAttachmentPart(filePath);

    expect(part).toEqual({
      type: "image",
      source: { base64: bytes.toString("base64"), mediaType: "image/png" },
    });
  });

  it("respects explicit tagged image with a remote url", async () => {
    const part = await prepareAttachmentPart({
      type: "image",
      source: "https://cdn.example.com/file-without-extension",
    });

    expect(part).toEqual({
      type: "image",
      source: { url: "https://cdn.example.com/file-without-extension" },
    });
  });

  it("respects explicit tagged image with inline base64", async () => {
    const part = await prepareAttachmentPart({
      type: "image",
      source: { base64: "iVBORw0KGgo=", mediaType: "image/png" },
    });

    expect(part).toEqual({
      type: "image",
      source: { base64: "iVBORw0KGgo=", mediaType: "image/png" },
    });
  });

  it("infers from StorageFileShape and reads from absolutePath when both are present", async () => {
    const filePath = join(tempDir, "dog.webp");
    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46]);
    await writeFile(filePath, bytes);

    const part = await prepareAttachmentPart({
      url: "https://cdn.example.com/dog.webp",
      absolutePath: filePath,
    });

    expect(part).toEqual({
      type: "image",
      source: { base64: bytes.toString("base64"), mediaType: "image/webp" },
    });
  });

  it("treats .jpeg and .jpg as image/jpeg", async () => {
    const a = await prepareAttachmentPart("https://example.com/x.jpeg");
    const b = await prepareAttachmentPart("https://example.com/x.jpg");

    expect(a).toEqual({
      type: "image",
      source: { url: "https://example.com/x.jpeg" },
    });
    expect(b).toEqual({
      type: "image",
      source: { url: "https://example.com/x.jpg" },
    });
  });

  it("throws InvalidRequestError when a tagged-image local path lacks a recognizable extension", async () => {
    const filePath = join(tempDir, "data.bin");

    await writeFile(filePath, Buffer.from([0]));

    await expect(
      prepareAttachmentPart({ type: "image", source: filePath }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(
      prepareAttachmentPart({ type: "image", source: filePath }),
    ).rejects.toThrow(/Cannot infer media type/);
  });

  describe("text attachments", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("infers .txt as a text attachment and reads file contents", async () => {
      const filePath = join(tempDir, "notes.txt");
      await writeFile(filePath, "hello from disk", "utf8");

      const part = await prepareAttachmentPart(filePath);

      expect(part).toEqual({ type: "text", text: "hello from disk" });
    });

    it("supports tagged text attachment with a local path", async () => {
      const filePath = join(tempDir, "doc");
      await writeFile(filePath, "tagged content", "utf8");

      const part = await prepareAttachmentPart({
        type: "text",
        source: filePath,
      });

      expect(part).toEqual({ type: "text", text: "tagged content" });
    });

    it("decodes inline base64 for tagged text attachments", async () => {
      const base64 = Buffer.from("inline text", "utf8").toString("base64");

      const part = await prepareAttachmentPart({
        type: "text",
        source: { base64, mediaType: "text/plain" },
      });

      expect(part).toEqual({ type: "text", text: "inline text" });
    });

    it("fetches remote URL for tagged text attachments", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("remote body", { status: 200 }));

      const part = await prepareAttachmentPart({
        type: "text",
        source: "https://cdn.example.com/readme",
      });

      expect(part).toEqual({ type: "text", text: "remote body" });
      expect(fetchSpy).toHaveBeenCalledWith("https://cdn.example.com/readme");
    });

    it("throws InvalidRequestError when remote text fetch fails", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("nope", { status: 404 }),
      );

      const promise = prepareAttachmentPart({
        type: "text",
        source: "https://cdn.example.com/missing",
      });

      await expect(promise).rejects.toBeInstanceOf(InvalidRequestError);
      await expect(promise).rejects.toThrow(/Failed to fetch text attachment/);
    });
  });
});
