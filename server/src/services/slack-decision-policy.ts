import { createHash } from "node:crypto";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { rejectIssueThreadInteractionSchema, respondIssueThreadInteractionSchema } from "@paperclipai/shared";
import { projectSafeChatPublicationText } from "./chat-publication-projection.js";
import { safeChatTaskUrl } from "./chat-task-url.js";

/**
 * This is a server-owned disclosure decision, NOT interaction metadata or a
 * callback parameter. The company publisher must load it from its protected
 * policy configuration. No classification is inferred from a title, a keyword,
 * an agent's assertion, or the absence of a regex match. Missing policy means
 * link-only. Binding the whole source prevents reuse after an edit.
 *
 * The classifier must establish both the topic and that ALL source fields are
 * disclosable (including option labels/help, modal copy and terminal labels).
 * Regex checks below are only a second barrier, never that classifier.
 */
export interface SlackDecisionDisclosure {
  companyId: string;
  interactionId: string;
  sourceDigest: string;
  topic: "product_direction" | "implementation_plan";
  expiresAt: string;
}

export interface SlackDecisionPolicyContext {
  companyId: string;
  userId: string;
  now: Date;
  disclosure: SlackDecisionDisclosure | null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function slackDecisionSourceDigest(interaction: IssueThreadInteraction): string {
  return createHash("sha256").update(canonicalJson({
    companyId: interaction.companyId,
    issueId: interaction.issueId,
    id: interaction.id,
    kind: interaction.kind,
    title: interaction.title,
    payload: interaction.payload,
    addresseeAgentId: interaction.addresseeAgentId,
    addresseeUserId: interaction.addresseeUserId,
    effectiveResolverPolicy: interaction.effectiveResolverPolicy,
  })).digest("hex");
}

// Deliberately conservative. A match suppresses the entire card; removing a
// word/number from a consequence and keeping its button could change consent.
const RESTRICTED_TEXT = /(?:\b(?:budget|budżet\w*|margin|marż\w*|salary|payroll|wynagrodzen\w*|customer|klient\w*|password|hasł\w*|secret|sekret\w*|token|credential|permission|uprawnien\w*|hire|hiring|zatrudn\w*|connection|połączen\w*)\b|\b\d[\d\s.,]*\s*(?:PLN|EUR|USD|zł)\b|[$€£]|[\w.+-]+@[\w.-]+\.[a-z]{2,}|<[@#!][^>]+>)/iu;

function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(allStrings);
  return [];
}

export function isSlackDecisionAllowed(
  interaction: IssueThreadInteraction,
  context: SlackDecisionPolicyContext,
): boolean {
  const disclosure = context.disclosure;
  if (
    !disclosure ||
    !context.userId ||
    !["product_direction", "implementation_plan"].includes(disclosure.topic) ||
    interaction.companyId !== context.companyId ||
    disclosure.companyId !== context.companyId ||
    disclosure.interactionId !== interaction.id ||
    disclosure.sourceDigest !== slackDecisionSourceDigest(interaction) ||
    !Number.isFinite(context.now.getTime()) ||
    !(Date.parse(disclosure.expiresAt) > context.now.getTime()) ||
    interaction.status !== "pending" ||
    interaction.acceptanceBlocker != null ||
    interaction.effectiveResolverPolicy !== "human_only" ||
    interaction.addresseeAgentId != null ||
    (interaction.addresseeUserId != null && interaction.addresseeUserId !== context.userId)
  ) return false;

  if (interaction.kind !== "ask_user_questions" && interaction.kind !== "request_confirmation") return false;
  const payload = interaction.payload as unknown as Record<string, unknown>;
  // Check key presence, including malformed/null values, before any adapter
  // dispatch. An unknown future governed effect cannot inherit this allowlist.
  if (["toolAction", "secretProposal", "connectionAuthorization"].some((key) => key in payload)) return false;
  const permittedFields = interaction.kind === "request_confirmation"
    ? ["version", "prompt", "acceptLabel", "rejectLabel", "rejectRequiresReason", "rejectReasonLabel", "allowDeclineReason", "declineReasonPlaceholder", "detailsMarkdown", "supersedeOnUserComment", "target"]
    : ["version", "title", "submitLabel", "supersedeOnUserComment", "questions", "questionSet", "runtimeRequestId"];
  if (Object.keys(payload).some((key) => !permittedFields.includes(key))) return false;
  if (interaction.kind === "request_confirmation") {
    const target = interaction.payload.target;
    if (target != null && (
      target.type !== "issue_document" ||
      target.key !== "plan" ||
      (target.issueId != null && target.issueId !== interaction.issueId) ||
      !target.revisionId ||
      disclosure.topic !== "implementation_plan"
    )) return false;
    if (disclosure.topic === "implementation_plan" && target?.type !== "issue_document") return false;
  } else if (disclosure.topic !== "product_direction") return false;

  return allStrings([interaction.title, interaction.payload]).every((text) =>
    text.length <= 20_000 &&
    !RESTRICTED_TEXT.test(text) &&
    // Sanitization changing consent text requires Board review, not a subtly
    // different actionable copy. Whitespace normalization alone is harmless.
    (!text.trim() || projectSafeChatPublicationText(text).trim() === text.trim()),
  );
}

export class SlackDecisionPolicyError extends Error {
  constructor() {
    super("This decision requires a response in MyDay");
    this.name = "SlackDecisionPolicyError";
  }
}

/** Must be called again by the resolver on the current row inside its transaction. */
export function assertSlackDecisionAllowed(
  interaction: IssueThreadInteraction,
  context: SlackDecisionPolicyContext,
): void {
  if (!isSlackDecisionAllowed(interaction, context)) throw new SlackDecisionPolicyError();
}

export interface SlackDecisionProjection {
  mode: "link_only" | "decision";
  text: string;
  title: string;
  sections: string[];
  cardUrl: string;
}

/** Never fetches source URLs/documents or exports attachments, result free text or raw logs. */
export function projectSlackDecision(
  interaction: IssueThreadInteraction,
  context: SlackDecisionPolicyContext,
  publicBaseUrl: string,
): SlackDecisionProjection | null {
  const taskUrl = safeChatTaskUrl(publicBaseUrl, interaction.issueId);
  if (!taskUrl) return null; // Never publish a fallback without a usable link.
  const cardUrl = `${taskUrl}#interaction-${encodeURIComponent(interaction.id)}`;
  const neutral = "Karta wymaga odpowiedzi w MyDay";
  const fallback: SlackDecisionProjection = {
    mode: "link_only", title: neutral, sections: [neutral], cardUrl,
    text: `${neutral}\nOtwórz kartę: ${cardUrl}`,
  };
  if (!isSlackDecisionAllowed(interaction, context)) return fallback;
  const title = (interaction.kind === "ask_user_questions" ? interaction.payload.title : null)
    ?? interaction.title ?? "Decyzja w MyDay";
  const sections: string[] = [];
  if (interaction.kind === "request_confirmation") {
    sections.push(interaction.payload.prompt);
    // Preserve source details verbatim: no model-generated recommendation or
    // guessed extraction of the YES/NO consequences from arbitrary Markdown.
    sections.push(interaction.payload.detailsMarkdown || "Rekomendacja i skutki: Nie podano na karcie");
    if (interaction.payload.target?.type === "issue_document") {
      sections.push(`Plan · rewizja ${interaction.payload.target.revisionId}`);
    }
  } else if (interaction.kind === "ask_user_questions") {
    for (const question of interaction.payload.questions) {
      sections.push([question.prompt, question.helpText, ...question.options.map((option) =>
        `${option.label}: ${option.description || "Nie podano na karcie"}`,
      )].filter(Boolean).join("\n"));
    }
  }
  const text = [title, ...sections, `Otwórz kartę: ${cardUrl}`].join("\n\n");
  // Until a complete sentence-preserving renderer can show all consequences,
  // oversize cards are link-only. Never truncate and leave executable buttons.
  if (title.length > 150 || sections.some((section) => section.length > 2800) || text.length > 6000) return fallback;
  return { mode: "decision", title, sections, text, cardUrl };
}

export type SlackDecisionResolution =
  | { method: "acceptInteraction"; input: Record<string, never> }
  | { method: "rejectInteraction"; input: { reason?: string } }
  | { method: "answerQuestions"; input: { answers: Array<{ questionId: string; optionIds: string[]; otherText?: string | null }> } };

/**
 * Maps an already authenticated action to the existing service. Does not write
 * issue state, resolve identity, or authorize a callback. The action type must
 * come from the persisted opaque action record, not a client's arbitrary verb.
 * Cancel and context requests deliberately have no resolution mapping.
 */
export function mapSlackDecisionResolution(
  interaction: IssueThreadInteraction,
  context: SlackDecisionPolicyContext,
  action: "accept" | "reject" | "answer",
  input: unknown,
): SlackDecisionResolution {
  assertSlackDecisionAllowed(interaction, context);
  if (interaction.kind === "request_confirmation" && action === "accept") {
    return { method: "acceptInteraction", input: {} };
  }
  if (interaction.kind === "request_confirmation" && action === "reject") {
    const parsed = rejectIssueThreadInteractionSchema.safeParse(input);
    if (!parsed.success || (interaction.payload.rejectRequiresReason && !parsed.data.reason)) {
      throw new SlackDecisionPolicyError();
    }
    return { method: "rejectInteraction", input: parsed.data };
  }
  if (interaction.kind !== "ask_user_questions" || action !== "answer") throw new SlackDecisionPolicyError();
  const parsed = respondIssueThreadInteractionSchema.safeParse(input);
  if (!parsed.success) throw new SlackDecisionPolicyError();
  const questions = interaction.payload.questions;
  const seen = new Set<string>();
  for (const answer of parsed.data.answers) {
    const question = questions.find((candidate) => candidate.id === answer.questionId);
    if (!question || seen.has(answer.questionId)) throw new SlackDecisionPolicyError();
    seen.add(answer.questionId);
    const options = answer.optionIds.map((id) => question.options.find((option) => option.id === id));
    if (options.some((option) => !option) || new Set(answer.optionIds).size !== answer.optionIds.length ||
      (question.selectionMode === "single" && options.length > 1)) throw new SlackDecisionPolicyError();
    const textRequired = options.some((option) => option?.freeText);
    if (textRequired && !answer.otherText?.trim()) throw new SlackDecisionPolicyError();
    if (answer.otherText?.trim() && !textRequired && question.allowOther !== true) throw new SlackDecisionPolicyError();
    if (question.required && !options.length && !answer.otherText?.trim()) throw new SlackDecisionPolicyError();
  }
  if (questions.some((question) => question.required && !seen.has(question.id))) throw new SlackDecisionPolicyError();
  // No summaryMarkdown from the provider and no reflection of free text into
  // public copy. The canonical service still performs its full validation.
  return { method: "answerQuestions", input: { answers: parsed.data.answers } };
}
