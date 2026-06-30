/**
 * A single resolved piece of message content.
 *
 * `ContentPart` is the **resolved** form of attachable content — by the
 * time a part reaches a model adapter, every input variant
 * (path, URL, StorageFile, raw base64) has already been collapsed to a
 * provider-ready shape. Adapters never read files or fetch URLs; they
 * map parts directly into their wire format.
 *
 * Multipart content is opt-in: `Message.content` accepts a
 * plain `string` (the common case) or `ContentPart[]` when attachments
 * are present.
 *
 * @example
 * const userMessage: Message = {
 *   role: "user",
 *   content: [
 *     { type: "text", text: "What's in this picture?" },
 *     { type: "image", source: { url: "https://example.com/cat.jpg" } },
 *   ],
 * };
 *
 * @example
 * // Local file → base64-encoded by the agent before reaching the adapter
 * const part: ContentPart = {
 *   type: "image",
 *   source: { base64: "iVBORw0KGgo...", mediaType: "image/png" },
 * };
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; source: ImageSource }
  | { type: "pdf"; source: BinarySource }
  | { type: "audio"; source: BinarySource };

/**
 * Where binary media bytes live in a resolved `ContentPart`.
 *
 * - `{ url }` — remote URL the provider can fetch directly. Used for
 *   public URLs and StorageFile entries that already expose a URL.
 * - `{ base64, mediaType }` — inlined base64 bytes with an explicit
 *   IANA media type (e.g. `"image/png"`, `"application/pdf"`,
 *   `"audio/mpeg"`). Used for local file paths and StorageFile entries
 *   with only an absolute path.
 */
export type BinarySource = { url: string } | { base64: string; mediaType: string };

/** Image bytes for an `{ type: "image" }` part. Alias of {@link BinarySource}. */
export type ImageSource = BinarySource;
