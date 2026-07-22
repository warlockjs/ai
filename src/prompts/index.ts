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

// LLM-as-judge building blocks — the same machinery `prompts().validate()`
// runs, surfaced publicly so other packages (e.g. `@warlock.js/ai-panoptic`'s
// trace-level system-prompt evaluation) can grade arbitrary prompt text
// against a model + rubric without a second judging implementation.
export { formatCriteria, judgePromptBody } from "./prompts-validate";
export type { JudgeOutcome } from "./prompts-validate";
