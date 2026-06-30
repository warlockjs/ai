import type { AgentContract } from "../contracts/agent/agent.contract";
import type { ModelContract } from "../contracts/model.contract";
import { judge } from "../eval/judge-scorer";
import type { PromptValidationNote, PromptValidationReport } from "./prompt.type";

/**
 * Placeholder matcher — kept in lock-step with the matcher
 * `renderPlaceholders` uses (`src/system-prompt/render-placeholders.ts`) so the
 * lint sees the same `{{key}}` / `{{a.b}}` / `{{key|default}}` set the renderer
 * substitutes. Global so every occurrence is collected.
 */
const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Lower bound below which a prompt is suspiciously terse. */
const MIN_REASONABLE_LENGTH = 12;

/** Upper bound above which a prompt is likely bloated / unfocused. */
const MAX_REASONABLE_LENGTH = 8000;

/**
 * Severity rank for most-severe-first ordering. Higher sorts earlier.
 */
const SEVERITY_RANK: Record<PromptValidationNote["severity"], number> = {
  error: 2,
  warn: 1,
  info: 0,
};

/**
 * The fixed rubric the LLM-as-judge grades a prompt body against. Surfaced
 * here (not inline) so the static-lint pass and the judge pass document the
 * same quality dimensions.
 */
export const PROMPT_JUDGE_RUBRIC = [
  "Grade this SYSTEM PROMPT on a 0..1 scale for overall quality:",
  "- Clarity: is the intent unambiguous and easy to follow?",
  "- Role definition: does it clearly state who/what the assistant is?",
  "- Output-format specificity: does it say how the answer should be shaped?",
  "- No conflicting instructions: are any directives contradictory?",
  "Score 1.0 only when all four hold; deduct for each weakness and explain why.",
].join("\n");

/**
 * Heuristic role-line detector — a prompt that never says "you are …" /
 * "act as …" / "your role is …" typically lacks a persona. Case-insensitive.
 */
const ROLE_HINT_PATTERN = /\b(you are|act as|your role is|you're a|you will act)\b/i;

/**
 * Run the cheap, model-free static lint over a prompt body. Flags:
 * - length out of the reasonable band (too terse / too bloated),
 * - any `{{placeholder}}` that survives (undeclared / unresolved at lint time),
 * - a missing role line.
 *
 * Pure and synchronous — used standalone (no judge model) and merged with the
 * judge findings when a model is available.
 *
 * @param text - The prompt body to lint.
 */
export function staticLint(text: string): PromptValidationNote[] {
  const notes: PromptValidationNote[] = [];
  const trimmed = text.trim();

  if (trimmed.length < MIN_REASONABLE_LENGTH) {
    notes.push({
      severity: "warn",
      message: `Prompt is very short (${trimmed.length} chars) — it may be too vague to steer the model.`,
      suggestion: "Add an explicit role and at least one concrete instruction.",
    });
  }

  if (trimmed.length > MAX_REASONABLE_LENGTH) {
    notes.push({
      severity: "warn",
      message: `Prompt is very long (${trimmed.length} chars) — long prompts dilute focus and inflate cost.`,
      suggestion: "Split into a tighter persona plus a few focused instructions.",
    });
  }

  const placeholders = collectPlaceholders(text);

  for (const placeholder of placeholders) {
    notes.push({
      severity: "info",
      message: `Unresolved placeholder "{{${placeholder}}}" — confirm it is supplied at resolve time or give it a default ("{{${placeholder}|...}}").`,
    });
  }

  if (!ROLE_HINT_PATTERN.test(trimmed)) {
    notes.push({
      severity: "warn",
      message: "No role line found — the prompt never states who the assistant is.",
      suggestion: 'Open with a role, e.g. "You are a senior support engineer for …".',
    });
  }

  return notes;
}

/**
 * Collect every distinct placeholder PATH (the part before any `|default`)
 * from a template, in first-seen order. Matches `renderPlaceholders`' own
 * parsing so the lint never disagrees with the renderer.
 */
function collectPlaceholders(template: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const path = match[1].split("|")[0].trim();

    if (path.length > 0 && !seen.has(path)) {
      seen.add(path);
      found.push(path);
    }
  }

  return found;
}

/**
 * Stable, most-severe-first ordering: `error` before `warn` before `info`,
 * preserving original order within a severity. Returns a fresh array.
 */
export function sortNotesBySeverity(
  notes: PromptValidationNote[],
): PromptValidationNote[] {
  return notes
    .map((note, index) => ({ note, index }))
    .sort((a, b) => {
      const rankDiff = SEVERITY_RANK[b.note.severity] - SEVERITY_RANK[a.note.severity];

      return rankDiff !== 0 ? rankDiff : a.index - b.index;
    })
    .map(entry => entry.note);
}

/**
 * Score the static-lint findings alone, on a `0..1` scale. Starts at `1.0`
 * and deducts per finding by severity, clamped at `0`. Used as the report
 * score when no judge model is available.
 */
export function staticScore(notes: PromptValidationNote[]): number {
  let score = 1;

  for (const note of notes) {
    if (note.severity === "error") {
      score -= 0.4;
    } else if (note.severity === "warn") {
      score -= 0.2;
    } else {
      score -= 0.05;
    }
  }

  return Math.max(0, Number(score.toFixed(4)));
}

/**
 * Run the LLM-as-judge pass over `text` using a judge agent built from
 * `model`, REUSING the eval `judge` scorer so there is no second judging
 * path. Returns the judge `score` (`0..1`) and a single derived note carrying
 * its reason (when present). The judge prompt is the prompt-quality rubric;
 * the "answer to grade" is the prompt body itself.
 *
 * @param text - The prompt body under evaluation.
 * @param model - The model that powers the judge agent.
 * @param buildJudgeAgent - Factory that wraps a model into a name-bearing judge agent.
 */
export async function judgePrompt(
  text: string,
  model: ModelContract,
  buildJudgeAgent: (model: ModelContract) => AgentContract<unknown>,
): Promise<{ score: number; notes: PromptValidationNote[] }> {
  const judgeAgent = buildJudgeAgent(model);
  const scorer = judge({ agent: judgeAgent, rubric: PROMPT_JUDGE_RUBRIC });

  const score = await scorer({
    // The judge scorer only reads `case.input` / `case.expected` / `text` /
    // `output` from the context. We feed the rubric question via `input` and
    // the prompt body as the answer to grade via `text`.
    case: { name: "prompt-quality", input: "Grade the system prompt below." },
    text,
    // `result` is unused by the judge scorer's prompt builder; a minimal
    // stand-in keeps the structural contract satisfied without a real run.
    result: { text } as never,
    output: undefined,
  });

  const notes: PromptValidationNote[] = [];

  if (score.reason) {
    notes.push({
      severity: score.passed ? "info" : "warn",
      message: `LLM-as-judge: ${score.reason}`,
    });
  }

  return { score: score.score, notes };
}

/**
 * Assemble the final {@link PromptValidationReport} from the static-lint
 * findings and (optionally) the judge findings. Notes are merged and sorted
 * most-severe-first. The score is the static score alone when no judge ran,
 * else the mean of the static score and the judge score.
 */
export function buildValidationReport(
  staticNotes: PromptValidationNote[],
  judgeResult?: { score: number; notes: PromptValidationNote[] },
): PromptValidationReport {
  const allNotes = judgeResult
    ? [...staticNotes, ...judgeResult.notes]
    : staticNotes;

  const lintScore = staticScore(staticNotes);

  const score = judgeResult
    ? Number(((lintScore + judgeResult.score) / 2).toFixed(4))
    : lintScore;

  return {
    score,
    notes: sortNotesBySeverity(allNotes),
  };
}
