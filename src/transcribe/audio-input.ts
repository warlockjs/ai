import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { AudioInput } from "../contracts/transcription-model.contract";

/**
 * File-extension → IANA audio media type map covering the formats the
 * common STT providers accept — including the **WhatsApp voice-note**
 * formats (`.ogg` / `.opus`, Opus-in-Ogg on Android; `.m4a` on iOS).
 */
const AUDIO_MEDIA_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".mpeg": "audio/mpeg",
  ".mpga": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".weba": "audio/webm",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
};

/**
 * Resolve the audio media type from a filename's extension, or
 * `undefined` when the extension is unknown. Case-insensitive.
 *
 * @example
 * audioMediaTypeForFilename("voice-note.opus"); // "audio/ogg"
 */
export function audioMediaTypeForFilename(filename: string): string | undefined {
  return AUDIO_MEDIA_TYPES[extname(filename).toLowerCase()];
}

/**
 * Package raw audio bytes as an {@link AudioInput} for `ai.transcribe()`.
 * Pure plumbing — no AI, no I/O. Use when you already hold the bytes
 * (an upload buffer, a downloaded blob).
 *
 * @example
 * const audio = audioFromBuffer(uploadBuffer, "audio/ogg", "note.ogg");
 * const { data } = await ai.transcribe({ model: openai.transcribe({ name: "whisper-1" }), audio });
 */
export function audioFromBuffer(
  data: Uint8Array,
  mediaType: string,
  filename?: string,
): AudioInput {
  return {
    base64: Buffer.from(data).toString("base64"),
    mediaType,
    ...(filename ? { filename } : {}),
  };
}

/**
 * Read an audio file from disk and package it as an {@link AudioInput}
 * for `ai.transcribe()` — the one-line bridge from a file on disk
 * (WhatsApp `.ogg`/`.opus`, a meeting `.m4a`, a `.wav`) to the
 * transcription verb. **Pure utility — no AI here**; the actual text
 * extraction is the AI step (`ai.transcribe`).
 *
 * The media type is inferred from the file extension (override via
 * `options.mediaType` for extensionless or mislabeled files).
 *
 * @example
 * // WhatsApp voice note → text, end to end:
 * const audio = await audioFromFile("./voice-note.ogg");
 * const { data, error } = await ai.transcribe({
 *   model: openai.transcribe({ name: "whisper-1" }),
 *   audio,
 *   language: "en",
 * });
 * if (!error) console.log(data.text);
 */
export async function audioFromFile(
  filePath: string,
  options?: { mediaType?: string },
): Promise<AudioInput> {
  const buffer = await readFile(filePath);
  const filename = basename(filePath);
  const mediaType = options?.mediaType ?? audioMediaTypeForFilename(filename) ?? "audio/mpeg";

  return { base64: buffer.toString("base64"), mediaType, filename };
}
