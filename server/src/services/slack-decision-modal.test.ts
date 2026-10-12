import { describe, expect, it } from "vitest";
import type { AskUserQuestionsInteraction, RequestConfirmationInteraction } from "@paperclipai/shared";
import { slackDecisionSourceDigest, type SlackDecisionPolicyContext } from "./slack-decision-policy.js";
import { buildSlackDecisionModal, mapSlackDecisionModalSubmission } from "./slack-decision-modal.js";

function card(): RequestConfirmationInteraction {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    issueId: "22222222-2222-4222-8222-222222222222",
    companyId: "33333333-3333-4333-8333-333333333333",
    kind: "request_confirmation", status: "pending", title: "Układ strony",
    continuationPolicy: "wake_assignee", resolverPolicy: "human_only",
    requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
    resolverPolicyProvenance: "explicit", effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: { requested: null, effective: null },
    createdAt: "2026-10-08T10:00:00Z", updatedAt: "2026-10-08T10:00:00Z",
    payload: {
      version: 1, prompt: "Czy wybrać układ A?",
      detailsMarkdown: "Rekomendacja: A. TAK: przygotujemy A. NIE: pozostanie B.",
    },
  };
}

function context(source: RequestConfirmationInteraction | AskUserQuestionsInteraction = card()): SlackDecisionPolicyContext {
  return {
    companyId: source.companyId, userId: "daniel", now: new Date("2026-10-08T11:00:00Z"),
    disclosure: {
      companyId: source.companyId, interactionId: source.id,
      sourceDigest: slackDecisionSourceDigest(source), topic: "product_direction",
      expiresAt: "2026-10-08T12:00:00Z",
    },
  };
}
function question(): AskUserQuestionsInteraction {
  return {
    ...card(), kind: "ask_user_questions", result: null,
    payload: { version: 1, questions: [{
      id: "layout", prompt: "Jaki układ?", selectionMode: "single", required: true,
      options: [{ id: "a", label: "A", description: "Zachowamy widok A" }, { id: "b", label: "B" }],
    }] },
  };
}


const selected = (value: string | null) => ({ input: { type: "static_select", selected_option: value ? { value, text: { text: "untrusted label" } } : null } });
const typed = (value: string | null) => ({ input: { type: "plain_text_input", value } });

describe("Slack decision modal decoding", () => {
  it("maps source IDs and excludes Slack labels from canonical answers", () => {
    const source = question();
    expect(mapSlackDecisionModalSubmission(source, context(source), { q0_select: selected("a") }))
      .toEqual({ method: "answerQuestions", input: { answers: [{ questionId: "layout", optionIds: ["a"] }] } });
  });
  it("maps multiple questions, multiselect and private custom text together", () => {
    const source = question();
    source.payload.questions[0].selectionMode = "multi";
    source.payload.questions.push({ id: "why", prompt: "Dlaczego?", required: true, allowOther: true, selectionMode: "single", options: [] });
    expect(mapSlackDecisionModalSubmission(source, context(source), {
      q0_select: { input: { type: "multi_static_select", selected_options: [{ value: "a" }, { value: "b" }] } },
      q1_text: typed("  Private explanation  "),
    })).toEqual({ method: "answerQuestions", input: { answers: [
      { questionId: "layout", optionIds: ["a", "b"] },
      { questionId: "why", optionIds: [], otherText: "Private explanation" },
    ] } });
  });
  it.each([
    {}, { q0_select: selected(null) }, { q0_select: selected("forged") },
    { q0_select: selected("a"), extra: typed("injection") },
    { q0_select: { ...selected("a"), forged: {} } },
    { q0_select: typed("a") },
  ])("rejects incomplete or unexpected state without reflecting input", (values) => {
    const source = question();
    expect(() => mapSlackDecisionModalSubmission(source, context(source), values)).toThrow("This decision requires a response in MyDay");
  });
  it("requires text for an option that requests it", () => {
    const source = question();
    source.payload.questions[0].options[1].freeText = true;
    expect(() => mapSlackDecisionModalSubmission(source, context(source), { q0_select: selected("b"), q0_text: typed(null) })).toThrow();
    expect(mapSlackDecisionModalSubmission(source, context(source), { q0_select: selected("b"), q0_text: typed("explanation") })).toMatchObject({ method: "answerQuestions" });
  });
  it("rejects duplicated multiselect IDs and missing questions atomically", () => {
    const source = question();
    source.payload.questions[0].selectionMode = "multi";
    const values = { q0_select: { input: { type: "multi_static_select", selected_options: [{ value: "a" }, { value: "a" }] } } };
    expect(() => mapSlackDecisionModalSubmission(source, context(source), values)).toThrow();
  });
  it("requires a nonempty reason and maps confirmation modal only to rejection", () => {
    const source = card();
    expect(mapSlackDecisionModalSubmission(source, context(source), { reason: typed("  Prefer B  ") }))
      .toEqual({ method: "rejectInteraction", input: { reason: "Prefer B" } });
    for (const reason of [null, "", "  ", "x".repeat(3001)]) {
      expect(() => mapSlackDecisionModalSubmission(source, context(source), { reason: typed(reason) })).toThrow();
    }
  });
  it("does not reuse a stale or revoked disclosure for modal data", () => {
    const source = question();
    const policy = context(source);
    source.payload.questions[0].prompt = "Changed";
    expect(() => mapSlackDecisionModalSubmission(source, policy, { q0_select: selected("a") })).toThrow();
    expect(() => mapSlackDecisionModalSubmission(source, { ...context(source), disclosure: null }, { q0_select: selected("a") })).toThrow();
  });
});


describe("Slack decision modal rendering", () => {
  const actionId = `pcsd:${"a".repeat(32)}`;
  const origin = "https://myday.example.com";
  it("preserves both outcomes, the source revision and a canonical link", () => {
    const source = card();
    source.payload.target = { type: "issue_document", key: "plan", revisionId: "rev-a" };
    const policy = context(source);
    policy.disclosure!.topic = "implementation_plan";
    const view = buildSlackDecisionModal(source, policy, origin, actionId)!;
    expect(view.submit.text).toBe("Odrzuć i podaj powód");
    expect(view.private_metadata).toBe(actionId);
    expect(view.notify_on_close).toBe(true);
    expect(JSON.stringify(view)).toContain(source.payload.detailsMarkdown);
    expect(JSON.stringify(view)).toContain("rev-a");
    expect(JSON.stringify(view)).toContain(`#interaction-${source.id}`);
  });
  it("uses the same field IDs for rendering and decoding multi choice with text", () => {
    const source = question();
    source.payload.questions[0].selectionMode = "multi";
    source.payload.questions[0].options[1].freeText = true;
    const view = buildSlackDecisionModal(source, context(source), origin, actionId)!;
    expect(view.blocks.filter((block) => block.type === "input").map((block) => block.block_id)).toEqual(["q0_select", "q0_text"]);
    expect(JSON.stringify(view)).toContain("multi_static_select");
  });
  it("refuses oversized source copy, oversized option labels and unclassified cards", () => {
    const source = question();
    expect(buildSlackDecisionModal(source, { ...context(source), disclosure: null }, origin, actionId)).toBeNull();
    source.payload.questions[0].options[0].label = "a".repeat(76);
    expect(buildSlackDecisionModal(source, context(source), origin, actionId)).toBeNull();
    source.payload.questions[0].prompt = "a".repeat(2801);
    expect(buildSlackDecisionModal(source, context(source), origin, actionId)).toBeNull();
  });
  it("refuses invalid origins and tokens", () => {
    const source = card();
    expect(buildSlackDecisionModal(source, context(source), "javascript:bad", actionId)).toBeNull();
    expect(buildSlackDecisionModal(source, context(source), origin, "forged")).toBeNull();
  });
});
