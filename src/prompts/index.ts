// Factory + process-wide default manager.
export {
  defaultPromptsManager,
  promptKey,
  prompts,
} from "./prompts-manager";

// Types.
export type {
  PromptsManagerContract,
  PromptsManagerEntry,
  PromptsManagerRegisterOptions,
} from "./prompts-manager.contract";

// P2 surface types — validate / define / tag / diff / export / import.
export type {
  ExportedPrompt,
  ExportedPromptVersion,
  ExportedRegistry,
  PromptDiff,
  PromptDiffBlock,
  PromptJudgeCacheLike,
  PromptsManagerOptions,
  PromptTemplateVersion,
  PromptValidateTarget,
  PromptValidationResult,
  PromptsValidateOptions,
} from "./prompts-manager.type";
