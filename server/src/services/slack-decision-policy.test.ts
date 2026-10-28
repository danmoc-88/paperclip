import { describe, expect, it } from "vitest";
import type { AskUserQuestionsInteraction, RequestConfirmationInteraction } from "@paperclipai/shared";
import {
  assertSlackDecisionAllowed,
  isSlackDecisionAllowed,
  mapSlackDecisionResolution,
  projectSlackDecision,
  projectSlackDecisionPublication,
  slackDecisionSourceDigest,
  type SlackDecisionPolicyContext,
} from "./slack-decision-policy.js";

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
const origin = "https://myday.example.com";

describe("Slack decision policy boundary", () => {
  it("retains complete allowed source copy and the canonical card anchor", () => {
    const source = card();
    const projected = projectSlackDecision(source, context(source), origin)!;
    expect(projected.mode).toBe("decision");
    expect(projected.text).toContain(source.payload.detailsMarkdown);
    expect(projected.cardUrl).toBe(`${origin}/issues/${source.issueId}#interaction-${source.id}`);
    expect(projected).not.toHaveProperty("attachmentIds");
  });

  it("requires a separate bound server disclosure; payload assertions cannot opt in", () => {
    const source = card();
    const policy = { ...context(source), disclosure: null };
    expect(projectSlackDecision(source, policy, origin)).toMatchObject({ mode: "link_only" });
    expect(() => assertSlackDecisionAllowed(source, policy)).toThrow("response in MyDay");
    Object.assign(source.payload, { classification: "external" });
    expect(isSlackDecisionAllowed(source, context(source))).toBe(false);
  });

  it.each(["toolAction", "secretProposal", "connectionAuthorization", "futureEffect"])(
    "refuses %s even when title is harmless and disclosure matches", (field) => {
      const source = card();
      Object.assign(source.payload, { [field]: null });
      expect(isSlackDecisionAllowed(source, context(source))).toBe(false);
      expect(() => assertSlackDecisionAllowed(source, context(source))).toThrow();
    },
  );

  it.each(["suggest_tasks", "connection_intent", "request_checkbox_confirmation", "request_item_verdicts", "approval", "unknown"])(
    "refuses unsupported kind %s at the backend", (kind) => {
      const source = { ...card(), kind } as RequestConfirmationInteraction;
      expect(() => assertSlackDecisionAllowed(source, context(source))).toThrow();
    },
  );

  it.each(["budget", "connection", "native_completion_review", "unknown"])(
    "refuses custom target %s regardless of the title", (key) => {
      const source = card();
      source.payload.target = { type: "custom", key };
      expect(isSlackDecisionAllowed(source, context(source))).toBe(false);
    },
  );

  it("allows only the same-issue plan target and binds its exact revision", () => {
    const source = card();
    source.payload.target = { type: "issue_document", key: "plan", revisionId: "rev-a" };
    const policy = context(source);
    policy.disclosure!.topic = "implementation_plan";
    expect(isSlackDecisionAllowed(source, policy)).toBe(true);
    expect(projectSlackDecision(source, policy, origin)?.text).toContain("rewizja rev-a");
    source.payload.target.revisionId = "rev-b";
    expect(isSlackDecisionAllowed(source, policy)).toBe(false);
    source.payload.target.issueId = "another-issue";
    policy.disclosure!.sourceDigest = slackDecisionSourceDigest(source);
    expect(isSlackDecisionAllowed(source, policy)).toBe(false);
    source.payload.target.issueId = source.issueId;
    source.payload.target.key = "secrets";
    policy.disclosure!.sourceDigest = slackDecisionSourceDigest(source);
    expect(isSlackDecisionAllowed(source, policy)).toBe(false);
  });

  it.each(["accepted", "rejected", "answered", "expired", "cancelled"])(
    "refuses a %s interaction", (status) => {
      const source = { ...card(), status } as RequestConfirmationInteraction;
      expect(isSlackDecisionAllowed(source, context(source))).toBe(false);
    },
  );

  it("fences company, recipient, policy expiry and acceptance readiness", () => {
    const source = card();
    const policy = context(source);
    expect(isSlackDecisionAllowed(source, { ...policy, companyId: "other" })).toBe(false);
    policy.disclosure!.expiresAt = policy.now.toISOString();
    expect(isSlackDecisionAllowed(source, policy)).toBe(false);
    source.addresseeUserId = "other-user";
    expect(isSlackDecisionAllowed(source, context(source))).toBe(false);
    source.addresseeUserId = "daniel";
    source.addresseeAgentId = "agent";
    expect(isSlackDecisionAllowed(source, context(source))).toBe(false);
    source.addresseeAgentId = null;
    source.acceptanceBlocker = "workspace_sync_pending";
    expect(isSlackDecisionAllowed(source, context(source))).toBe(false);
  });

  it.each(["Marża 30%", "Budżet 100", "125 PLN", "customer@example.com", "password: private", "<@U123>"])(
    "suppresses all public surfaces when any source field contains %s", (canary) => {
      const source = card();
      source.payload.rejectReasonLabel = canary;
      const projected = projectSlackDecision(source, context(source), origin)!;
      expect(projected.mode).toBe("link_only");
      expect(JSON.stringify(projected)).not.toContain(canary);
      expect(JSON.stringify(projected)).not.toContain(source.title);
    },
  );

  it("invalidates disclosure after changing title, details or recipient", () => {
    for (const mutate of [
      (source: RequestConfirmationInteraction) => { source.title = "Another title"; },
      (source: RequestConfirmationInteraction) => { source.payload.detailsMarkdown = "Other effect"; },
      (source: RequestConfirmationInteraction) => { source.addresseeUserId = "daniel"; },
    ]) {
      const source = card();
      const policy = context(source);
      mutate(source);
      expect(isSlackDecisionAllowed(source, policy)).toBe(false);
    }
  });

  it("does not depend on object key insertion order", () => {
    const source = card();
    const copy = structuredClone(source);
    copy.payload = { detailsMarkdown: source.payload.detailsMarkdown, prompt: source.payload.prompt, version: 1 };
    expect(slackDecisionSourceDigest(copy)).toBe(slackDecisionSourceDigest(source));
  });

  it.each(["title", "section"])("uses link-only instead of truncating oversize %s", (size) => {
    const source = card();
    if (size === "title") source.title = "A".repeat(151);
    else source.payload.detailsMarkdown = "A".repeat(2801);
    const projected = projectSlackDecision(source, context(source), origin)!;
    expect(projected.mode).toBe("link_only");
    expect(projected.text).toContain("Otwórz kartę:");
  });

  it("refuses publication when no usable Board URL is available", () => {
    for (const invalid of ["", "http://example.com", "https://localhost", "javascript:bad"])
      expect(projectSlackDecision(card(), context(), invalid)).toBeNull();
  });

  it("does not invent missing recommendations or effects", () => {
    const source = card();
    delete source.payload.detailsMarkdown;
    expect(projectSlackDecision(source, context(source), origin)?.text).toContain("Nie podano na karcie");
  });
});

function question(): AskUserQuestionsInteraction {
  return {
    ...card(), kind: "ask_user_questions", result: null,
    payload: { version: 1, questions: [{
      id: "layout", prompt: "Jaki układ?", selectionMode: "single", required: true,
      options: [{ id: "a", label: "A", description: "Zachowamy widok A" }, { id: "b", label: "B" }],
    }] },
  };
}

describe("Slack canonical answer mapping", () => {
  it("maps confirmation outcomes without accepting provider-supplied side effects", () => {
    const source = card();
    expect(mapSlackDecisionResolution(source, context(source), "accept", { issueId: "forged", reason: "injected" }))
      .toEqual({ method: "acceptInteraction", input: {} });
    expect(mapSlackDecisionResolution(source, context(source), "reject", { reason: "  Preferuję B  " }))
      .toEqual({ method: "rejectInteraction", input: { reason: "Preferuję B" } });
    source.payload.rejectRequiresReason = true;
    expect(() => mapSlackDecisionResolution(source, context(source), "reject", {})).toThrow();
    expect(() => mapSlackDecisionResolution(source, context(source), "answer", { answers: [] })).toThrow();
  });

  it("keeps canonical IDs and drops untrusted summaries", () => {
    const source = question();
    const policy = context(source);
    expect(projectSlackDecision(source, policy, origin)?.mode).toBe("decision");
    const answers = [{ questionId: "layout", optionIds: ["a"] }];
    expect(mapSlackDecisionResolution(source, policy, "answer", { answers, summaryMarkdown: "Forged attribution" }))
      .toEqual({ method: "answerQuestions", input: { answers } });
    expect(() => mapSlackDecisionResolution(source, policy, "accept", {})).toThrow();
  });

  it.each([
    [],
    [{ questionId: "other", optionIds: ["a"] }],
    [{ questionId: "layout", optionIds: ["unknown"] }],
    [{ questionId: "layout", optionIds: ["a", "b"] }],
    [{ questionId: "layout", optionIds: ["a", "a"] }],
    [{ questionId: "layout", optionIds: ["a"] }, { questionId: "layout", optionIds: ["b"] }],
    [{ questionId: "layout", optionIds: [], otherText: "unsolicited" }],
  ].map((answers) => ({ answers })))("rejects incomplete, forged, duplicate or disallowed answers: $answers", ({ answers }) => {
    const source = question();
    expect(() => mapSlackDecisionResolution(source, context(source), "answer", { answers })).toThrow();
  });

  it("requires free text when the selected option requests it", () => {
    const source = question();
    source.payload.questions[0].options[1].freeText = true;
    const policy = context(source);
    expect(() => mapSlackDecisionResolution(source, policy, "answer", {
      answers: [{ questionId: "layout", optionIds: ["b"] }],
    })).toThrow();
    const answers = [{ questionId: "layout", optionIds: ["b"], otherText: "Private explanation" }];
    expect(mapSlackDecisionResolution(source, policy, "answer", { answers })).toEqual({ method: "answerQuestions", input: { answers } });
    expect(JSON.stringify(projectSlackDecision(source, policy, origin))).not.toContain("Private explanation");
  });

  it("validates all questions before mapping a multi-select submission", () => {
    const source = question();
    source.payload.questions[0].selectionMode = "multi";
    source.payload.questions.push({ id: "reason", prompt: "Dlaczego?", selectionMode: "single", required: true, allowOther: true, options: [] });
    const policy = context(source);
    const answers = [{ questionId: "layout", optionIds: ["a", "b"] }];
    expect(() => mapSlackDecisionResolution(source, policy, "answer", { answers })).toThrow();
    const complete = [...answers, { questionId: "reason", optionIds: [], otherText: "Reason" }];
    expect(mapSlackDecisionResolution(source, policy, "answer", { answers: complete })).toMatchObject({ input: { answers: complete } });
  });
});

describe("Slack question disclosure surfaces", () => {
  it.each(["title", "help", "option", "description", "submit", "canonical"])("suppresses restricted %s content", (surface) => {
    const source = question();
    const canary = "salary 100 USD";
    if (surface === "title") source.payload.title = canary;
    if (surface === "help") source.payload.questions[0].helpText = canary;
    if (surface === "option") source.payload.questions[0].options[0].label = canary;
    if (surface === "description") source.payload.questions[0].options[0].description = canary;
    if (surface === "submit") source.payload.submitLabel = canary;
    if (surface === "canonical") source.payload.questionSet = { schema: "paperclip.question_set.v1", title: canary, questions: [] };
    const policy = context(source);
    expect(projectSlackDecision(source, policy, origin)?.mode).toBe("link_only");
    expect(JSON.stringify(projectSlackDecision(source, policy, origin))).not.toContain(canary);
    expect(() => mapSlackDecisionResolution(source, policy, "answer", { answers: [{ questionId: "layout", optionIds: ["a"] }] })).toThrow();
  });

  it("keeps every section under its limit but falls back when their total exceeds 6000", () => {
    const source = question();
    source.payload.questions = ["a", "b", "c"].map((id) => ({
      id, prompt: "A".repeat(2100), selectionMode: "single", options: [], allowOther: true,
    }));
    expect(projectSlackDecision(source, context(source), origin)?.mode).toBe("link_only");
  });

  it("does not rewrite an actionable consequence by stripping hidden content", () => {
    const source = card();
    source.payload.detailsMarkdown = "TAK: <internal>important effect</internal> visible effect";
    expect(projectSlackDecision(source, context(source), origin)?.mode).toBe("link_only");
  });
});


describe("Slack provider publication boundary", () => {
  it("preserves source consequences and the canonical link in every transport surface", () => {
    const source = card();
    const prepared = projectSlackDecisionPublication(source, context(source), origin)!;
    expect(prepared.mode).toBe("decision");
    expect(prepared.payload.text).toContain(source.payload.detailsMarkdown);
    expect(prepared.payload.card!.body).toContain(source.payload.detailsMarkdown);
    const url = `${origin}/issues/${source.issueId}#interaction-${source.id}`;
    expect(prepared.payload.text).toContain(url);
    expect(prepared.payload.card!.actions).toEqual([{ type: "link", label: "Otwórz kartę", url }]);
    expect(prepared.payload.attachmentIds).toBeUndefined();
  });

  it.each(["missing", "stale", "restricted", "oversize"])("uses neutral link-only copy for %s policy", (reason) => {
    const source = card();
    const policy = context(source);
    if (reason === "missing") policy.disclosure = null;
    if (reason === "stale") source.payload.prompt = "Zmienione pytanie";
    if (reason === "restricted") source.payload.detailsMarkdown = "Budżet: 100 PLN";
    if (reason === "oversize") source.payload.detailsMarkdown = "A".repeat(2801);
    if (reason === "restricted" || reason === "oversize") policy.disclosure!.sourceDigest = slackDecisionSourceDigest(source);
    const prepared = projectSlackDecisionPublication(source, policy, origin)!;
    expect(prepared.mode).toBe("link_only");
    expect(prepared.payload.card!.kind).toBe("status");
    expect(JSON.stringify(prepared.payload)).not.toContain(source.payload.prompt);
    expect(JSON.stringify(prepared.payload)).not.toContain(source.payload.detailsMarkdown);
    expect(prepared.payload.card!.actions!.every((action) => action.type === "link")).toBe(true);
  });

  it("does not prepare a publication without a public canonical link", () => {
    const source = card();
    expect(projectSlackDecisionPublication(source, context(source), "http://localhost:3100")).toBeNull();
  });
});
