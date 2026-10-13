import { z } from "zod";

/**
 * One estimate for a decision card, stored when the card is created.
 * The screen and Slack only read the stored integer. They do not run this
 * formula again. The same numbers are in the agent instruction
 * `zasady-decyzji-daniela`.
 *
 * A card description's first 700 characters are inside the base minute.
 * Each further 700 characters adds one minute. A linked document adds one
 * minute per 1500 characters, and at most 10 extra minutes.
 */

export const ESTIMATED_MINUTES_MIN = 1;
export const ESTIMATED_MINUTES_MAX = 30;
export const QUESTION_LONG_TEXT_CHARS = 400;
export const DESCRIPTION_MINUTE_CHARS = 700;
export const CHECKBOX_OPTIONS_PER_MINUTE = 5;
export const ITEM_LONG_TEXT_CHARS = 400;
export const DOCUMENT_MINUTE_CHARS = 1500;
export const DOCUMENT_EXTRA_MINUTES_MAX = 10;

export const estimatedMinutesSchema = z
  .number()
  .int()
  .min(ESTIMATED_MINUTES_MIN)
  .max(ESTIMATED_MINUTES_MAX);

export const updateEstimatedMinutesSchema = z
  .object({ estimatedMinutes: estimatedMinutesSchema })
  .strict();

const DECISION_CARD_KINDS = new Set([
  "ask_user_questions",
  "request_confirmation",
  "request_checkbox_confirmation",
  "request_item_verdicts",
  "suggest_tasks",
  "decision",
]);

export function readEstimatedMinutes(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < ESTIMATED_MINUTES_MIN || value > ESTIMATED_MINUTES_MAX) return null;
  return value;
}

/** `ok. 6 min`, or nothing when the card has no stored minute count. */
export function formatDecisionMinutesLabel(value: unknown): string | null {
  const minutes = readEstimatedMinutes(value);
  if (minutes == null) return null;
  return `ok. ${minutes} min`;
}

export function appendDecisionMinutesLine(text: string, value: unknown): string {
  const label = formatDecisionMinutesLabel(value);
  if (!label) return text;
  if (text.split("\n").some((line) => line.trim() === label)) return text;
  return text.length > 0 ? `${text}\n${label}` : label;
}

/** The only field a pending-card correction is allowed to write. */
export function estimatedMinutesPatch(minutes: number): { estimatedMinutes: number } {
  const stored = readEstimatedMinutes(minutes);
  if (stored == null) {
    throw new Error("estimatedMinutes must be an integer from 1 to 30");
  }
  return { estimatedMinutes: stored };
}

export function descriptionExtraMinutes(text: string): number {
  if (text.length <= DESCRIPTION_MINUTE_CHARS) return 0;
  return Math.ceil((text.length - DESCRIPTION_MINUTE_CHARS) / DESCRIPTION_MINUTE_CHARS);
}

export function documentExtraMinutes(characters: number): number {
  if (!Number.isFinite(characters) || characters < DOCUMENT_MINUTE_CHARS) return 0;
  return Math.min(DOCUMENT_EXTRA_MINUTES_MAX, Math.floor(characters / DOCUMENT_MINUTE_CHARS));
}

function clampDecisionMinutes(total: number): number {
  if (!Number.isFinite(total)) return ESTIMATED_MINUTES_MIN;
  return Math.min(
    ESTIMATED_MINUTES_MAX,
    Math.max(ESTIMATED_MINUTES_MIN, Math.floor(total)),
  );
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> =>
    Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );
}

function questionMinutes(questions: Record<string, unknown>[]): number {
  let total = 0;
  for (const question of questions) {
    total += 1;
    const optionText = records(question.options)
      .map((option) => textOf(option.description))
      .join("");
    const extra = `${textOf(question.helpText)}${optionText}`;
    if (extra.length > QUESTION_LONG_TEXT_CHARS) total += 1;
  }
  return total;
}

function checkboxMinutes(options: unknown[]): number {
  if (options.length === 0) return 0;
  return Math.ceil(options.length / CHECKBOX_OPTIONS_PER_MINUTE);
}

function itemMinutes(items: Record<string, unknown>[]): number {
  let total = 0;
  for (const item of items) {
    total += 1;
    const text = `${textOf(item.description)}${textOf(item.previewMarkdown)}`;
    if (text.length > ITEM_LONG_TEXT_CHARS) total += 1;
  }
  return total;
}

function confirmationMinutes(description: string): number {
  return 1 + descriptionExtraMinutes(description);
}

function standaloneDecisionMinutes(optionCount: number, body: string): number {
  return 1 + Math.max(0, optionCount - 2) + descriptionExtraMinutes(body);
}

export function estimateDecisionMinutes(input: {
  kind: string;
  payload?: Record<string, unknown> | null;
  body?: string | null;
  optionCount?: number;
  documentCharacters?: number;
}): number {
  const payload = input.payload ?? {};
  const documentMinutes = documentExtraMinutes(input.documentCharacters ?? 0);
  let total = 0;
  switch (input.kind) {
    case "ask_user_questions":
      total = questionMinutes(records(payload.questions));
      break;
    case "request_confirmation":
      total = confirmationMinutes(textOf(payload.detailsMarkdown));
      break;
    case "request_checkbox_confirmation":
      total = checkboxMinutes(Array.isArray(payload.options) ? payload.options : []);
      break;
    case "request_item_verdicts":
      total = itemMinutes(records(payload.items));
      break;
    case "suggest_tasks":
      total = Array.isArray(payload.tasks) ? payload.tasks.length : 0;
      break;
    case "decision":
      total = standaloneDecisionMinutes(
        input.optionCount ?? (Array.isArray(payload.options) ? payload.options.length : 0),
        textOf(input.body ?? payload.body),
      );
      break;
    default:
      total = 1;
      break;
  }
  return clampDecisionMinutes(total + documentMinutes);
}

export function stampInteractionEstimatedMinutes<T extends { kind: string; payload: object }>(
  input: T,
  documentCharacters = 0,
): T & { payload: T["payload"] & { estimatedMinutes?: number } } {
  if (!DECISION_CARD_KINDS.has(input.kind) || input.kind === "decision") return input;
  const payload = input.payload as Record<string, unknown>;
  if (readEstimatedMinutes(payload.estimatedMinutes)) return input;
  return {
    ...input,
    payload: {
      ...payload,
      estimatedMinutes: estimateDecisionMinutes({
        kind: input.kind,
        payload,
        documentCharacters,
      }),
    },
  };
}

export function stampDecisionMetadata(
  body: string,
  options: readonly unknown[],
  metadata: Record<string, unknown> | null | undefined,
  documentCharacters = 0,
): Record<string, unknown> {
  const base = { ...(metadata ?? {}) };
  if (readEstimatedMinutes(base.estimatedMinutes)) return base;
  return {
    ...base,
    estimatedMinutes: estimateDecisionMinutes({
      kind: "decision",
      body,
      optionCount: options.length,
      documentCharacters,
    }),
  };
}
