/**
 * Shape of a StorageFile object from @warlock.js/core.
 * Used to detect storage files in the Attachment union.
 *
 * @example
 * const file: StorageFileShape = {
 *   url: "https://cdn.example.com/uploads/doc.pdf",
 *   absolutePath: "/var/www/uploads/doc.pdf",
 * };
 */
export type StorageFileShape = {
  /** Public URL of the file */
  url?: string;
  /** Absolute filesystem path to the file */
  absolutePath?: string;
};

/**
 * Where the bytes of an attachment originate. The agent's
 * `prepareAttachmentPart` collapses every variant into a `ContentPart`
 * the model adapter can consume.
 *
 * - `string` — local file path or remote URL (auto-detected via the
 *   `https?://` prefix).
 * - `StorageFileShape` — a `@warlock.js/core` storage file; URL wins
 *   over path when both are present.
 * - `{ base64, mediaType }` — raw inline bytes with an explicit IANA
 *   media type, useful for in-memory data that never touched disk.
 */
export type AttachmentSource =
  | string
  | StorageFileShape
  | { base64: string; mediaType: string };

/**
 * An attachment that can be passed to an agent execution.
 *
 * Two forms:
 *
 * - **Tagged form** (preferred for non-image types and for explicit
 *   intent): `{ type: "image" | "text", source }`.
 * - **Shorthand string / StorageFileShape**: the agent infers the
 *   media kind from the file extension. Recognized image extensions:
 *   `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`. Recognized text
 *   extension: `.txt`. Anything else throws — silent inference for
 *   ambiguous inputs causes silent bugs.
 *
 * @example
 * // Shorthand — extension-inferred image
 * agent.execute("What's in this?", { attachments: ["./photo.png"] });
 *
 * @example
 * // Tagged form — explicit kind
 * agent.execute("Compare", {
 *   attachments: [
 *     { type: "image", source: "https://cdn.example.com/a.jpg" },
 *     { type: "image", source: { base64: "iVBOR...", mediaType: "image/png" } },
 *   ],
 * });
 *
 * @example
 * // Text attachment — contents are read and injected as extra text
 * agent.execute("Summarize", { attachments: [{ type: "text", source: "./notes.txt" }] });
 *
 * @example
 * // StorageFileShape from @warlock.js/core (extension-inferred)
 * agent.execute("Describe", { attachments: [storageFile] });
 */
export type Attachment =
  | string
  | StorageFileShape
  | { type: "image"; source: AttachmentSource }
  | { type: "text"; source: AttachmentSource };

/**
 * A normalized attachment after source resolution — a tagged value the
 * agent can hand to file-reading code without re-discriminating the
 * input variant.
 *
 * @example
 * const resolved: ResolvedAttachment = { type: "url", value: "https://..." };
 * const resolved2: ResolvedAttachment = { type: "path", value: "/tmp/doc.pdf" };
 * const resolved3: ResolvedAttachment = {
 *   type: "base64",
 *   value: "iVBORw0...",
 *   mediaType: "image/png",
 * };
 */
export type ResolvedAttachment =
  | { type: "url"; value: string }
  | { type: "path"; value: string }
  | { type: "base64"; value: string; mediaType: string };
