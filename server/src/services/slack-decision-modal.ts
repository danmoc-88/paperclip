import { z } from "zod";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import {
  assertSlackDecisionAllowed,
  mapSlackDecisionResolution,
  SlackDecisionPolicyError,
  type SlackDecisionPolicyContext,
  projectSlackDecision,
} from "./slack-decision-policy.js";

const option = z.object({ value: z.string().min(1).max(160) });
const text = z.object({ type: z.literal("plain_text_input"), value: z.string().max(3000).nullable() });
const single = z.object({ type: z.literal("static_select"), selected_option: option.nullable() });
const multi = z.object({ type: z.literal("multi_static_select"), selected_options: z.array(option).max(100) });
const state = z.record(z.string(), z.object({ input: z.unknown() }).strict());

/** Stable field IDs shared by the modal renderer and decoder. They carry no
 * source text or identity. Source order is bound by the durable action digest.
 */
export function slackDecisionModalFieldId(index: number, kind: "select" | "text") {
  return `q${index}_${kind}`;
}

/** No truncation of questions or consequences. Unsupported sizes return null
 * and the caller retains the canonical card link instead of opening a modal.
 * The submit token is persisted and bound to the views.open receipt by caller.
 */
export function buildSlackDecisionModal(
  interaction: IssueThreadInteraction,
  context: SlackDecisionPolicyContext,
  origin: string,
  submitActionId: string,
) {
  const projection = projectSlackDecision(interaction, context, origin);
  if (projection?.mode !== "decision" || !/^pcsd:[A-Za-z0-9_-]{32}$/.test(submitActionId)) return null;
  const plain = (value: string) => ({ type: "plain_text" as const, text: value });
  const blocks: Record<string, unknown>[] = [];
  // Keep complete classified context visible, including both outcomes.
  for (const section of [projection.title, ...projection.sections]) {
    blocks.push({ type: "section", text: plain(section) });
  }
  blocks.push({ type: "section", text: { type: "mrkdwn", text: `<${projection.cardUrl}|Otwórz kartę>` } });
  const input = (blockId: string, label: string, element: Record<string, unknown>, optional: boolean) => {
    blocks.push({ type: "input", block_id: blockId, label: plain(label), optional, element: { ...element, action_id: "input" } });
  };
  if (interaction.kind === "request_confirmation") {
    input("reason", "Powód odmowy", { type: "plain_text_input", multiline: true, max_length: 3000 }, false);
  } else if (interaction.kind === "ask_user_questions") {
    for (const [index, question] of interaction.payload.questions.entries()) {
      // Full prompts/help/descriptions are already in the safe projection.
      // Select labels and values must fit without altering their meaning.
      if (question.options.length > 100 || question.options.some((option) => option.label.length > 75 || option.id.length > 150)) return null;
      const permitsText = question.allowOther === true || question.options.some((option) => option.freeText);
      if (question.options.length) {
        input(slackDecisionModalFieldId(index, "select"), `Pytanie ${index + 1}: wybór`, {
          type: question.selectionMode === "multi" ? "multi_static_select" : "static_select",
          options: question.options.map((option) => ({ text: plain(option.label), value: option.id })),
        }, !question.required || question.allowOther === true);
      }
      if (permitsText) input(slackDecisionModalFieldId(index, "text"), `Pytanie ${index + 1}: własny tekst`, {
        type: "plain_text_input", multiline: true, max_length: 3000,
      }, Boolean(question.options.length) || !question.required);
    }
  } else return null;
  if (blocks.length > 100) return null;
  return {
    type: "modal" as const, callback_id: submitActionId, private_metadata: submitActionId,
    notify_on_close: true, title: plain("Odpowiedź w MyDay"), close: plain("Anuluj"),
    submit: plain(interaction.kind === "request_confirmation" ? "Odrzuć i podaj powód" : "Odpowiedz"), blocks,
  };
}

/** Decode only an authenticated view_submission with a matching stored view
 * receipt. This does not authorize or resolve: the caller must pass the result
 * to the transactional resolver, which rechecks source, policy and membership.
 * https://docs.slack.dev/reference/interaction-payloads/view-interactions-payload/
 */
export function mapSlackDecisionModalSubmission(
  interaction: IssueThreadInteraction,
  context: SlackDecisionPolicyContext,
  values: unknown,
) {
  assertSlackDecisionAllowed(interaction, context);
  const parsed = state.safeParse(values);
  if (!parsed.success) throw new SlackDecisionPolicyError();
  const remaining = new Map(Object.entries(parsed.data));
  function take<T>(key: string, schema: z.ZodType<T>): T {
    const field = remaining.get(key);
    remaining.delete(key);
    const decoded = schema.safeParse(field?.input);
    if (!decoded.success) throw new SlackDecisionPolicyError();
    return decoded.data;
  }
  if (interaction.kind === "request_confirmation") {
    // A confirmation modal is always explicitly rejection with a reason.
    // Closing the modal never calls this function or resolves the interaction.
    const reason = take("reason", text).value?.trim();
    if (!reason || remaining.size) throw new SlackDecisionPolicyError();
    return mapSlackDecisionResolution(interaction, context, "reject", { reason });
  }
  if (interaction.kind !== "ask_user_questions") throw new SlackDecisionPolicyError();
  const answers = interaction.payload.questions.map((question, index) => {
    let optionIds: string[] = [];
    if (question.options.length) {
      const key = slackDecisionModalFieldId(index, "select");
      optionIds = question.selectionMode === "multi"
        ? take(key, multi).selected_options.map((selected) => selected.value)
        : (() => { const selected = take(key, single).selected_option; return selected ? [selected.value] : []; })();
    }
    const permitsText = question.allowOther === true || question.options.some((candidate) => candidate.freeText);
    const otherText = permitsText ? take(slackDecisionModalFieldId(index, "text"), text).value?.trim() : undefined;
    return { questionId: question.id, optionIds, ...(otherText ? { otherText } : {}) };
  });
  if (remaining.size) throw new SlackDecisionPolicyError();
  // Canonical mapping rejects unknown/duplicate options, missing mandatory
  // answers, text where forbidden and text-required options without text.
  return mapSlackDecisionResolution(interaction, context, "answer", { answers });
}
