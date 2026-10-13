import { describe, expect, it } from "vitest";
import { requestConfirmationPayloadSchema } from "./validators/issue.js";
import {
  appendDecisionMinutesLine,
  descriptionExtraMinutes,
  documentExtraMinutes,
  estimateDecisionMinutes,
  estimatedMinutesPatch,
  formatDecisionMinutesLabel,
  readEstimatedMinutes,
  stampDecisionMetadata,
  stampInteractionEstimatedMinutes,
} from "./decision-minutes.js";

function questions(count: number, extra = "") {
  return Array.from({ length: count }, (_, index) => ({
    id: `q${index}`,
    prompt: "Krótkie pytanie",
    helpText: extra,
    options: [{ id: "a", label: "Tak", description: "" }],
  }));
}

describe("estimateDecisionMinutes", () => {
  it("counts one minute per short question", () => {
    expect(estimateDecisionMinutes({
      kind: "ask_user_questions",
      payload: { questions: questions(6) },
    })).toBe(6);
  });

  it("adds a minute when one question's note and answer descriptions exceed 400 characters", () => {
    expect(estimateDecisionMinutes({
      kind: "ask_user_questions",
      payload: { questions: questions(1, "x".repeat(401)) },
    })).toBe(2);
    expect(estimateDecisionMinutes({
      kind: "ask_user_questions",
      payload: { questions: questions(1, "x".repeat(400)) },
    })).toBe(1);
  });

  it("counts a short confirmation as one minute and adds one per further 700 description characters", () => {
    expect(estimateDecisionMinutes({
      kind: "request_confirmation",
      payload: { detailsMarkdown: "Krótko" },
    })).toBe(1);
    expect(descriptionExtraMinutes("x".repeat(700))).toBe(0);
    expect(estimateDecisionMinutes({
      kind: "request_confirmation",
      payload: { detailsMarkdown: "x".repeat(701) },
    })).toBe(2);
  });

  it("counts checkbox options in started groups of five", () => {
    expect(estimateDecisionMinutes({
      kind: "request_checkbox_confirmation",
      payload: { options: Array.from({ length: 5 }, (_, index) => ({ id: String(index) })) },
    })).toBe(1);
    expect(estimateDecisionMinutes({
      kind: "request_checkbox_confirmation",
      payload: { options: Array.from({ length: 6 }, (_, index) => ({ id: String(index) })) },
    })).toBe(2);
  });

  it("counts one minute per verdict item and one more when that item's text is long", () => {
    expect(estimateDecisionMinutes({
      kind: "request_item_verdicts",
      payload: { items: [{ description: "krótko" }] },
    })).toBe(1);
    expect(estimateDecisionMinutes({
      kind: "request_item_verdicts",
      payload: { items: [{ description: "x".repeat(401) }] },
    })).toBe(2);
  });

  it("counts one minute per suggested task", () => {
    expect(estimateDecisionMinutes({
      kind: "suggest_tasks",
      payload: { tasks: [{ title: "A" }, { title: "B" }] },
    })).toBe(2);
  });

  it("adds document time once, capped at 10 minutes", () => {
    expect(documentExtraMinutes(1500)).toBe(1);
    expect(documentExtraMinutes(1499)).toBe(0);
    expect(documentExtraMinutes(15_000)).toBe(10);
    expect(documentExtraMinutes(30_000)).toBe(10);
    expect(estimateDecisionMinutes({
      kind: "request_confirmation",
      payload: { detailsMarkdown: "" },
      documentCharacters: 1500,
    })).toBe(2);
    expect(estimateDecisionMinutes({
      kind: "ask_user_questions",
      payload: { questions: questions(6) },
      documentCharacters: 15_000,
    })).toBe(16);
  });

  it("caps the stored number at 30", () => {
    expect(estimateDecisionMinutes({
      kind: "ask_user_questions",
      payload: { questions: questions(40) },
    })).toBe(30);
  });

  it("counts a standalone decision from its options and description", () => {
    expect(estimateDecisionMinutes({
      kind: "decision",
      body: "Krótko",
      optionCount: 2,
    })).toBe(1);
    expect(estimateDecisionMinutes({
      kind: "decision",
      body: "Krótko",
      optionCount: 4,
    })).toBe(3);
  });
});

describe("stored minutes", () => {
  it("leaves an old confirmation without a number, and does not format zero", () => {
    const payload = requestConfirmationPayloadSchema.parse({ version: 1, prompt: "Czy tak?" });
    expect(payload.estimatedMinutes).toBeUndefined();
    expect(readEstimatedMinutes(undefined)).toBeNull();
    expect(readEstimatedMinutes(0)).toBeNull();
    expect(formatDecisionMinutesLabel(undefined)).toBeNull();
    expect(formatDecisionMinutesLabel(0)).toBeNull();
    expect(formatDecisionMinutesLabel(6)).toBe("ok. 6 min");
  });

  it("keeps an explicit number and fills one when the card omits it", () => {
    const explicit = stampInteractionEstimatedMinutes({
      kind: "ask_user_questions",
      payload: { questions: questions(6), estimatedMinutes: 4 },
    });
    expect(explicit.payload.estimatedMinutes).toBe(4);

    const filled = stampInteractionEstimatedMinutes({
      kind: "ask_user_questions",
      payload: { questions: questions(6) },
    });
    expect(filled.payload.estimatedMinutes).toBe(6);
  });

  it("reads a standalone decision's number from the existing metadata bag", () => {
    const kept = stampDecisionMetadata("Krótko", [{}, {}], { estimatedMinutes: 6, source: "agent" });
    expect(kept).toEqual({ estimatedMinutes: 6, source: "agent" });
    expect(readEstimatedMinutes(kept.estimatedMinutes)).toBe(6);

    const filled = stampDecisionMetadata("Krótko", [{}, {}, {}], { source: "agent" });
    expect(filled.source).toBe("agent");
    expect(filled.estimatedMinutes).toBe(2);
  });

  it("changes only the minutes field", () => {
    const payload = {
      questions: questions(2),
      options: [{ id: "a" }],
      addresseeUserId: "daniel",
    };
    const next = { ...payload, ...estimatedMinutesPatch(3) };
    expect(estimatedMinutesPatch(3)).toEqual({ estimatedMinutes: 3 });
    expect(next.questions).toEqual(payload.questions);
    expect(next.options).toEqual(payload.options);
    expect(next.addresseeUserId).toBe("daniel");
    expect(next.estimatedMinutes).toBe(3);
  });

  it("adds the slack line only for a stored 6", () => {
    const text = "Sześć pytań\n- Tak";
    expect(appendDecisionMinutesLine(text, 6)).toContain("ok. 6 min");
    expect(appendDecisionMinutesLine(text, 1)).not.toContain("ok. 6 min");
    expect(appendDecisionMinutesLine(text, 1)).toContain("ok. 1 min");
    expect(appendDecisionMinutesLine(text, undefined)).toBe(text);
    expect(appendDecisionMinutesLine(text, 0)).toBe(text);
    expect(appendDecisionMinutesLine(text, 0)).not.toContain("ok. 0 min");
  });
});
