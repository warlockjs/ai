/**
 * Minimal structural view of the parts of the `langfuse` SDK the prompt sync
 * actually calls. Declared locally (rather than importing the SDK's own types)
 * so this module type-checks even when `langfuse` is not installed — it is an
 * OPTIONAL peer, lazily imported at runtime. The shape tracks Langfuse SDK v3's
 * prompt API: `getPrompt(name, version?)` reads a prompt and `createPrompt(...)`
 * writes a new prompt version.
 */
export type LangfuseClientLike = {
  /** Fetch a single prompt by name (optionally a specific version). */
  getPrompt(name: string, version?: number): Promise<LangfusePromptLike>;
  /** Create (push) a new text prompt version. */
  createPrompt(body: LangfuseCreatePromptBody): Promise<LangfusePromptLike>;
};

/**
 * A Langfuse prompt handle as returned by `getPrompt` / `createPrompt`. Only
 * the `name` / `version` / `prompt` (body) fields the sync maps are modeled.
 */
export type LangfusePromptLike = {
  /** Prompt name. */
  name: string;
  /** Numeric version assigned by Langfuse. */
  version: number;
  /** The prompt body text (Langfuse `type: "text"` prompts). */
  prompt: string;
};

/** Body accepted by `client.createPrompt(...)` for a text prompt. */
export type LangfuseCreatePromptBody = {
  /** Prompt name. */
  name: string;
  /** Prompt body text. */
  prompt: string;
  /** Discriminator — always `"text"` for the bodies this sync pushes. */
  type?: "text";
  /** Deploy labels (e.g. `["production"]`). Optional. */
  labels?: string[];
};
