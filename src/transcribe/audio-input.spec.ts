import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ai } from "../ai";
import { audioFromBuffer, audioFromFile, audioMediaTypeForFilename } from "./audio-input";

describe("ai.* namespace exposure", () => {
  it("mounts the audio helpers on the ai facade", () => {
    expect(ai.audioFromFile).toBe(audioFromFile);
    expect(ai.audioFromBuffer).toBe(audioFromBuffer);
    expect(ai.audioMediaTypeForFilename).toBe(audioMediaTypeForFilename);
  });

  it("mounts the RAG store + loader helpers under ai.rag", () => {
    expect(typeof ai.rag.pgVectorStore).toBe("function");
    expect(typeof ai.rag.cacheVectorStore).toBe("function");
    expect(typeof ai.rag.loadWeb).toBe("function");
    expect(typeof ai.rag.loadPdf).toBe("function");
    expect(typeof ai.rag.chunk).toBe("function");
    expect(typeof ai.rag.bm25Rank).toBe("function");
  });
});

describe("audioMediaTypeForFilename", () => {
  it("maps WhatsApp voice-note + common audio extensions", () => {
    expect(audioMediaTypeForFilename("note.ogg")).toBe("audio/ogg");
    expect(audioMediaTypeForFilename("note.opus")).toBe("audio/ogg"); // WhatsApp Opus-in-Ogg
    expect(audioMediaTypeForFilename("voice.m4a")).toBe("audio/mp4"); // iOS
    expect(audioMediaTypeForFilename("clip.MP3")).toBe("audio/mpeg"); // case-insensitive
    expect(audioMediaTypeForFilename("rec.wav")).toBe("audio/wav");
  });

  it("returns undefined for an unknown extension", () => {
    expect(audioMediaTypeForFilename("file.xyz")).toBeUndefined();
  });
});

describe("audioFromBuffer", () => {
  it("base64-encodes the bytes with the given media type + filename", () => {
    const audio = audioFromBuffer(new Uint8Array([65, 66, 67]), "audio/ogg", "note.ogg");
    expect(audio).toEqual({ base64: "QUJD", mediaType: "audio/ogg", filename: "note.ogg" });
  });

  it("omits filename when not provided", () => {
    const audio = audioFromBuffer(new Uint8Array([1]), "audio/wav");
    expect(audio).toEqual({ base64: "AQ==", mediaType: "audio/wav" });
  });
});

describe("audioFromFile", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "warlock-audio-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a file and infers the media type from the extension", async () => {
    const path = join(dir, "voice-note.ogg");
    await writeFile(path, Buffer.from([65, 66, 67]));

    const audio = await audioFromFile(path);

    expect(audio).toEqual({ base64: "QUJD", mediaType: "audio/ogg", filename: "voice-note.ogg" });
  });

  it("honors an explicit media-type override", async () => {
    const path = join(dir, "blob");
    await writeFile(path, Buffer.from([0]));

    const audio = await audioFromFile(path, { mediaType: "audio/mpeg" });

    expect(audio.mediaType).toBe("audio/mpeg");
    expect(audio.filename).toBe("blob");
  });

  it("falls back to audio/mpeg for an unknown extension", async () => {
    const path = join(dir, "mystery.xyz");
    await writeFile(path, Buffer.from([0]));

    const audio = await audioFromFile(path);

    expect(audio.mediaType).toBe("audio/mpeg");
  });
});
