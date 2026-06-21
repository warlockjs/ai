import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Attachment } from "../contracts/attachment.type";
import type { ContentPart } from "../contracts/content-part.type";
import { InvalidRequestError } from "../errors";
import { resolveAttachment } from "./resolve-attachment";

const IMAGE_EXTENSIONS_TO_MEDIA_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const TEXT_EXTENSIONS = new Set([".txt"]);

type AttachmentKind = "image" | "text";

/**
 * Convert a user-supplied `Attachment` into a provider-ready
 * `ContentPart` the model adapter can consume without doing any I/O of
 * its own.
 *
 * Kind resolution:
 * - Tagged `{ type: "image", source }` / `{ type: "text", source }`
 *   trusts the caller's intent.
 * - Shorthand (raw string / `StorageFileShape`) infers from the file
 *   extension. Image extensions (`.png`/`.jpg`/`.jpeg`/`.webp`/`.gif`)
 *   map to `"image"`. `.txt` maps to `"text"`. Anything else throws
 *   `InvalidRequestError` — silent inference on ambiguous inputs
 *   causes silent bugs.
 *
 * Local paths are read from disk; images are base64-encoded inline,
 * text files are read as UTF-8 strings and returned as a `text`
 * `ContentPart`. Remote URLs for image attachments are passed through
 * unchanged; remote URLs for text attachments are fetched so the
 * adapter never needs network access.
 *
 * @example
 * await prepareAttachmentPart("./photo.png");
 * // → { type: "image", source: { base64: "...", mediaType: "image/png" } }
 *
 * @example
 * await prepareAttachmentPart({ type: "text", source: "./notes.txt" });
 * // → { type: "text", text: "<file contents>" }
 */
export async function prepareAttachmentPart(
  attachment: Attachment,
): Promise<ContentPart> {
  const kind = resolveKind(attachment);

  if (kind === "text") {
    return prepareTextPart(attachment);
  }

  return prepareImagePart(attachment);
}

/**
 * Decide whether the attachment is text or image. Tagged forms win
 * immediately; for shorthand we inspect the extension. Throws if the
 * shorthand doesn't look like anything we recognize.
 */
function resolveKind(attachment: Attachment): AttachmentKind {
  if (isTaggedAttachment(attachment)) {
    return attachment.type;
  }

  const path = extractPath(attachment);
  const extension = path ? extname(stripQuery(path)).toLowerCase() : "";

  if (IMAGE_EXTENSIONS_TO_MEDIA_TYPE[extension]) {
    return "image";
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    return "text";
  }

  throw new InvalidRequestError(
    "Cannot infer attachment type from input — pass an explicit `{ type: 'image' | 'text', source: ... }` or use a recognized extension (.png, .jpg, .jpeg, .webp, .gif, .txt)",
  );
}

/**
 * Produce an `image` ContentPart. URLs pass through; paths are
 * read from disk and base64-encoded with an inferred media type.
 * Inline base64 attachments pass through unchanged.
 */
async function prepareImagePart(attachment: Attachment): Promise<ContentPart> {
  const inferredMediaType = isTaggedAttachment(attachment)
    ? undefined
    : inferImageMediaType(attachment);

  const resolved = resolveAttachment(attachment);

  if (resolved.type === "url") {
    return { type: "image", source: { url: resolved.value } };
  }

  if (resolved.type === "base64") {
    return {
      type: "image",
      source: { base64: resolved.value, mediaType: resolved.mediaType },
    };
  }

  const mediaType = inferredMediaType ?? inferImageMediaType(resolved.value);

  if (!mediaType) {
    throw new InvalidRequestError(
      `Cannot infer media type for path "${resolved.value}" — use a recognized image extension or pass ` +
        "`{ type: 'image', source: { base64, mediaType } }`",
      { context: { path: resolved.value } },
    );
  }

  const bytes = await readFile(resolved.value);

  return {
    type: "image",
    source: { base64: bytes.toString("base64"), mediaType },
  };
}

/**
 * Produce a `text` ContentPart. URLs are fetched as UTF-8, paths are
 * read from disk as UTF-8, inline base64 is decoded to UTF-8. The
 * result joins the conversation as an additional text part the model
 * sees before responding.
 */
async function prepareTextPart(attachment: Attachment): Promise<ContentPart> {
  const resolved = resolveAttachment(attachment);

  if (resolved.type === "url") {
    const response = await fetch(resolved.value);

    if (!response.ok) {
      throw new InvalidRequestError(
        `Failed to fetch text attachment "${resolved.value}" — status ${response.status}`,
        { context: { url: resolved.value, status: response.status } },
      );
    }

    return { type: "text", text: await response.text() };
  }

  if (resolved.type === "base64") {
    const decoded = Buffer.from(resolved.value, "base64").toString("utf8");

    return { type: "text", text: decoded };
  }

  const bytes = await readFile(resolved.value, "utf8");

  return { type: "text", text: bytes };
}

function isTaggedAttachment(
  attachment: Attachment,
): attachment is Extract<Attachment, { type: string }> {
  return (
    typeof attachment === "object" &&
    attachment !== null &&
    "type" in attachment
  );
}

function inferImageMediaType(input: unknown): string | undefined {
  const path = extractPath(input);

  if (!path) {
    return undefined;
  }

  const extension = extname(stripQuery(path)).toLowerCase();

  return IMAGE_EXTENSIONS_TO_MEDIA_TYPE[extension];
}

function extractPath(input: unknown): string | undefined {
  if (typeof input === "string") {
    return input;
  }

  if (typeof input === "object" && input !== null) {
    const storage = input as { url?: string; absolutePath?: string };
    return storage.url ?? storage.absolutePath;
  }

  return undefined;
}

function stripQuery(path: string): string {
  const queryIndex = path.indexOf("?");

  return queryIndex === -1 ? path : path.slice(0, queryIndex);
}
