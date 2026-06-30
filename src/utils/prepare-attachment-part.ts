import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import type { AttachmentPolicy } from "../contracts/attachment-policy.type";
import type { Attachment } from "../contracts/attachment.type";
import type { ContentPart } from "../contracts/content-part.type";
import { InvalidRequestError, OutboundPolicyError } from "../errors";
import { fetchTextWithPolicy } from "../security/outbound-policy";
import { resolveAttachment } from "./resolve-attachment";

const IMAGE_EXTENSIONS_TO_MEDIA_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const TEXT_EXTENSIONS = new Set([".txt"]);

const AUDIO_EXTENSIONS_TO_MEDIA_TYPE: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".weba": "audio/webm",
};

const PDF_EXTENSIONS = new Set([".pdf"]);

type AttachmentKind = "image" | "text" | "pdf" | "audio";

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
 *
 * **Trust boundary (S1).** Attachment references are often user-controlled,
 * so server-side I/O is policy-gated by `policy` ({@link AttachmentPolicy}):
 * remote text fetches are default-deny and, when enabled, run through the
 * shared `OutboundPolicy` (scheme/host/private-IP/max-bytes/timeout); local
 * reads honor an `allowedRoots` sandbox; bare-string local paths warn
 * (staged deprecation). URL *image* attachments are passed to the provider
 * untouched (never fetched here).
 */
export async function prepareAttachmentPart(
  attachment: Attachment,
  policy?: AttachmentPolicy,
): Promise<ContentPart> {
  const kind = resolveKind(attachment);
  const bareString = typeof attachment === "string";

  if (kind === "text") {
    return prepareTextPart(attachment, policy, bareString);
  }

  if (kind === "image") {
    return prepareImagePart(attachment, policy, bareString);
  }

  return prepareBinaryPart(attachment, kind, policy, bareString);
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

  if (PDF_EXTENSIONS.has(extension)) {
    return "pdf";
  }

  if (AUDIO_EXTENSIONS_TO_MEDIA_TYPE[extension]) {
    return "audio";
  }

  throw new InvalidRequestError(
    "Cannot infer attachment type from input — pass an explicit `{ type: 'image' | 'text' | 'pdf' | 'audio', source: ... }` or use a recognized extension (.png, .jpg, .jpeg, .webp, .gif, .txt, .pdf, .mp3, .wav, .m4a, .ogg, .weba)",
  );
}

/**
 * Produce a `pdf` / `audio` ContentPart (A2). URLs pass through; local
 * paths are read and base64-encoded with a media type inferred from the
 * kind (`application/pdf`) or extension (audio); inline base64 passes
 * through. Same `AttachmentPolicy` gating as image/text reads.
 */
async function prepareBinaryPart(
  attachment: Attachment,
  kind: "pdf" | "audio",
  policy: AttachmentPolicy | undefined,
  bareString: boolean,
): Promise<ContentPart> {
  const resolved = resolveAttachment(attachment);

  if (resolved.type === "url") {
    return { type: kind, source: { url: resolved.value } };
  }

  if (resolved.type === "base64") {
    return { type: kind, source: { base64: resolved.value, mediaType: resolved.mediaType } };
  }

  const mediaType =
    kind === "pdf" ? "application/pdf" : inferAudioMediaType(resolved.value);

  if (!mediaType) {
    throw new InvalidRequestError(
      `Cannot infer media type for ${kind} path "${resolved.value}" — use a recognized extension or pass ` +
        `\`{ type: '${kind}', source: { base64, mediaType } }\``,
      { context: { path: resolved.value } },
    );
  }

  enforceLocalPathPolicy(resolved.value, bareString, policy);
  const bytes = await readFile(resolved.value);

  return { type: kind, source: { base64: bytes.toString("base64"), mediaType } };
}

/** Infer an audio media type from a path's extension. */
function inferAudioMediaType(path: string): string | undefined {
  return AUDIO_EXTENSIONS_TO_MEDIA_TYPE[extname(stripQuery(path)).toLowerCase()];
}

/**
 * Produce an `image` ContentPart. URLs pass through; paths are
 * read from disk and base64-encoded with an inferred media type.
 * Inline base64 attachments pass through unchanged.
 */
async function prepareImagePart(
  attachment: Attachment,
  policy: AttachmentPolicy | undefined,
  bareString: boolean,
): Promise<ContentPart> {
  const inferredMediaType = isTaggedAttachment(attachment)
    ? undefined
    : inferImageMediaType(attachment);

  const resolved = resolveAttachment(attachment);

  if (resolved.type === "url") {
    // URL images are handed to the provider as a URL — the provider
    // fetches them, not us — so there's no server-side SSRF surface here.
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

  enforceLocalPathPolicy(resolved.value, bareString, policy);
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
async function prepareTextPart(
  attachment: Attachment,
  policy: AttachmentPolicy | undefined,
  bareString: boolean,
): Promise<ContentPart> {
  const resolved = resolveAttachment(attachment);

  if (resolved.type === "url") {
    // Default-deny: a remote text attachment is a server-side fetch of
    // user-controlled input — refuse unless the app explicitly opted in,
    // then run it through the shared OutboundPolicy (scheme/host/private-
    // IP/max-bytes/timeout).
    if (!policy?.allowRemoteFetch) {
      throw new OutboundPolicyError(
        `remote text attachment fetch is disabled by default — set \`attachmentPolicy.allowRemoteFetch: true\` (with an \`outbound\` policy) to fetch "${resolved.value}"`,
        { context: { url: resolved.value } },
      );
    }

    const result = await fetchTextWithPolicy(resolved.value, policy.outbound ?? {});

    if (!result.ok) {
      throw new InvalidRequestError(
        `Failed to fetch text attachment "${resolved.value}" — status ${result.status}`,
        { context: { url: resolved.value, status: result.status } },
      );
    }

    return { type: "text", text: result.text };
  }

  if (resolved.type === "base64") {
    const decoded = Buffer.from(resolved.value, "base64").toString("utf8");

    return { type: "text", text: decoded };
  }

  enforceLocalPathPolicy(resolved.value, bareString, policy);
  const bytes = await readFile(resolved.value, "utf8");

  return { type: "text", text: bytes };
}

/** Process-lifetime flag so the bare-string deprecation warns at most once. */
let warnedBareLocalPath = false;

/**
 * Enforce the local-file half of {@link AttachmentPolicy} (S1):
 *
 * - **Bare-string local paths** are staged for deprecation. With
 *   `allowBareLocalPaths: false` they hard-deny now; otherwise they warn
 *   once (outside tests) — the typed `StorageFile.absolutePath` route is
 *   the supported way to read a local file.
 * - **`allowedRoots` sandbox** — when set, the resolved path must live
 *   inside one of the roots, else the read is refused.
 */
function enforceLocalPathPolicy(
  path: string,
  bareString: boolean,
  policy: AttachmentPolicy | undefined,
): void {
  if (bareString) {
    if (policy?.allowBareLocalPaths === false) {
      throw new OutboundPolicyError(
        `local file attachment via a bare string path ("${path}") is disabled — pass a typed \`{ type, source: { absolutePath } }\` StorageFile, or set \`attachmentPolicy.allowBareLocalPaths: true\``,
        { context: { path } },
      );
    }

    if (!warnedBareLocalPath && !process.env.VITEST && process.env.NODE_ENV !== "test") {
      warnedBareLocalPath = true;
      console.warn(
        "[warlock-ai] reading a local file attachment from a bare string path is deprecated and will be denied by default in a future minor. " +
          "Pass a typed `{ type, source: { absolutePath } }` StorageFile and confine reads with `attachmentPolicy.allowedRoots`.",
      );
    }
  }

  const roots = policy?.allowedRoots;
  if (roots && roots.length > 0) {
    const target = resolvePath(path);
    const inside = roots.some(root => {
      const rel = relative(resolvePath(root), target);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });

    if (!inside) {
      throw new OutboundPolicyError(
        `local file attachment "${path}" is outside the allowed roots`,
        { context: { path, allowedRoots: roots } },
      );
    }
  }
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
