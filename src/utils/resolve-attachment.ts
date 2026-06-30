import type {
  Attachment,
  AttachmentSource,
  ResolvedAttachment,
} from "../contracts/attachment.type";
import { InvalidRequestError } from "../errors";

const REMOTE_URL_PATTERN = /^https?:\/\//i;

/**
 * Normalize a user-supplied `Attachment` (or bare `AttachmentSource`)
 * into a `ResolvedAttachment` the agent can hand to file-reading code
 * without re-discriminating the input variant.
 *
 * Resolution rules:
 * - `{ base64, mediaType }` → `{ type: "base64", value, mediaType }`.
 * - `StorageFileShape` (`{ url?, absolutePath? }`) → `absolutePath` wins
 *   over `url` when both are present (prefer the local file over an extra
 *   remote hop). Absolute path becomes `{ type: "path" }`; url becomes
 *   `{ type: "url" }`.
 * - String starting with `http://` / `https://` → `{ type: "url" }`.
 * - Any other string → `{ type: "path" }`.
 * - Tagged `{ type: "image" | "text", source }` → recurses into `source`.
 *
 * Throws `InvalidRequestError` on obviously invalid input (empty
 * string, storage object with neither url nor absolutePath, missing
 * source field).
 *
 * @example
 * resolveAttachment("https://cdn.example.com/doc.pdf");
 * // → { type: "url", value: "https://cdn.example.com/doc.pdf" }
 *
 * @example
 * resolveAttachment({ type: "image", source: "/tmp/x.png" });
 * // → { type: "path", value: "/tmp/x.png" }
 */
export function resolveAttachment(attachment: Attachment): ResolvedAttachment {
  if (
    typeof attachment === "object" &&
    attachment !== null &&
    "type" in attachment
  ) {
    return resolveSource(attachment.source);
  }

  return resolveSource(attachment);
}

function resolveSource(source: AttachmentSource): ResolvedAttachment {
  if (typeof source === "string") {
    if (!source) {
      throw new InvalidRequestError("Cannot resolve empty attachment string");
    }

    if (REMOTE_URL_PATTERN.test(source)) {
      return { type: "url", value: source };
    }

    return { type: "path", value: source };
  }

  // StorageFile objects (from @warlock.js/core) can expose a `base64`
  // property alongside `url` / `absolutePath`. Check storage shape
  // first so we don't treat a StorageFile as an inline-bytes payload.
  if ("url" in source || "absolutePath" in source) {
    const storage = source as { url?: string; absolutePath?: string };

    if (storage.absolutePath) {
      return { type: "path", value: storage.absolutePath };
    }

    if (storage.url) {
      return { type: "url", value: storage.url };
    }

    throw new InvalidRequestError(
      "Storage attachment has neither url nor absolutePath",
    );
  }

  if ("base64" in source) {
    if (!source.base64 || !source.mediaType) {
      throw new InvalidRequestError(
        "Inline attachment requires both `base64` and `mediaType`",
      );
    }

    return {
      type: "base64",
      value: source.base64,
      mediaType: source.mediaType,
    };
  }

  throw new InvalidRequestError(
    "Unrecognized attachment source — expected a string path/URL, a StorageFile, or `{ base64, mediaType }`",
  );
}
