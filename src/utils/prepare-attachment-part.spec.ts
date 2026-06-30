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
import { InvalidRequestError, OutboundPolicyError } from "../errors";
import type { AttachmentPolicy } from "../contracts/attachment-policy.type";
import { prepareAttachmentPart } from "./prepare-attachment-part";

/** Policy that permits remote fetch via an injected fetch, no DNS guard. */
function allowRemote(fetchImpl: () => Promise<Response>): AttachmentPolicy {
  return {
    allowRemoteFetch: true,
    outbound: {
      denyPrivateIPsAfterDNS: false,
      fetch: fetchImpl as unknown as typeof fetch,
    },
  };
}

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

    it("fetches remote URL for tagged text attachments when the policy allows it", async () => {
      const fetchSpy = vi.fn(async () => new Response("remote body", { status: 200 }));

      const part = await prepareAttachmentPart(
        { type: "text", source: "https://cdn.example.com/readme" },
        allowRemote(fetchSpy),
      );

      expect(part).toEqual({ type: "text", text: "remote body" });
      expect(fetchSpy).toHaveBeenCalled();
    });

    it("throws InvalidRequestError when remote text fetch returns a non-OK status", async () => {
      const promise = prepareAttachmentPart(
        { type: "text", source: "https://cdn.example.com/missing" },
        allowRemote(async () => new Response("nope", { status: 404 })),
      );

      await expect(promise).rejects.toBeInstanceOf(InvalidRequestError);
      await expect(promise).rejects.toThrow(/Failed to fetch text attachment/);
    });
  });

  describe("pdf + audio modalities (A2)", () => {
    it("infers a pdf part from a .pdf path and base64-encodes it", async () => {
      const filePath = join(tempDir, "doc.pdf");
      await writeFile(filePath, "%PDF-1.4 fake", "utf8");

      const part = await prepareAttachmentPart(filePath, { allowedRoots: [tempDir] });

      expect(part.type).toBe("pdf");
      expect((part as { source: { mediaType: string } }).source.mediaType).toBe(
        "application/pdf",
      );
    });

    it("passes a tagged pdf URL through without fetching", async () => {
      const part = await prepareAttachmentPart({
        type: "pdf",
        source: "https://cdn.example.com/report.pdf",
      });

      expect(part).toEqual({
        type: "pdf",
        source: { url: "https://cdn.example.com/report.pdf" },
      });
    });

    it("infers an audio part and its media type from a .mp3 path", async () => {
      const filePath = join(tempDir, "clip.mp3");
      await writeFile(filePath, "ID3 fake", "utf8");

      const part = await prepareAttachmentPart(filePath, { allowedRoots: [tempDir] });

      expect(part.type).toBe("audio");
      expect((part as { source: { mediaType: string } }).source.mediaType).toBe("audio/mpeg");
    });

    it("decodes inline base64 for a tagged audio attachment", async () => {
      const base64 = Buffer.from("fake-wav", "utf8").toString("base64");
      const part = await prepareAttachmentPart({
        type: "audio",
        source: { base64, mediaType: "audio/wav" },
      });

      expect(part).toEqual({ type: "audio", source: { base64, mediaType: "audio/wav" } });
    });
  });

  describe("AttachmentPolicy enforcement (S1)", () => {
    it("default-denies a remote text fetch when no policy opts in", async () => {
      await expect(
        prepareAttachmentPart({ type: "text", source: "https://cdn.example.com/readme" }),
      ).rejects.toBeInstanceOf(OutboundPolicyError);
    });

    it("blocks a remote text fetch that resolves to a private/metadata address", async () => {
      // allowRemoteFetch is on, but the default outbound private-IP guard
      // refuses the link-local metadata address.
      await expect(
        prepareAttachmentPart(
          { type: "text", source: "https://169.254.169.254/latest/meta-data" },
          { allowRemoteFetch: true },
        ),
      ).rejects.toBeInstanceOf(OutboundPolicyError);
    });

    it("hard-denies a bare-string local path when allowBareLocalPaths is false", async () => {
      const filePath = join(tempDir, "secret.txt");
      await writeFile(filePath, "top secret", "utf8");

      await expect(
        prepareAttachmentPart(filePath, { allowBareLocalPaths: false }),
      ).rejects.toBeInstanceOf(OutboundPolicyError);
    });

    it("rejects a local path outside the allowedRoots sandbox", async () => {
      const filePath = join(tempDir, "notes.txt");
      await writeFile(filePath, "in temp", "utf8");

      await expect(
        prepareAttachmentPart(
          { type: "text", source: filePath },
          { allowedRoots: ["/some/other/root"] },
        ),
      ).rejects.toBeInstanceOf(OutboundPolicyError);
    });

    it("allows a local path inside the allowedRoots sandbox", async () => {
      const filePath = join(tempDir, "inside.txt");
      await writeFile(filePath, "allowed", "utf8");

      const part = await prepareAttachmentPart(
        { type: "text", source: filePath },
        { allowedRoots: [tempDir] },
      );

      expect(part).toEqual({ type: "text", text: "allowed" });
    });
  });
});
