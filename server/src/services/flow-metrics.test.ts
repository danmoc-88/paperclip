import { describe, expect, it } from "vitest";
import { HOUR_MS } from "./stale-task-review.js";
import { compareFlow, summarizeFlow, type FlowRecord } from "./flow-metrics.js";

const CUT = Date.parse("2026-10-14T00:27:00Z");

function rec(i: number, over: Partial<FlowRecord> = {}): FlowRecord {
  const created = CUT - 5 * 24 * HOUR_MS + i * HOUR_MS;
  return {
    id: `t${i}`,
    identifier: `SAK-${i}`,
    cohort: "code",
    createdAtMs: created,
    assignedAtMs: created + HOUR_MS,
    firstRunStartedAtMs: created + 3 * HOUR_MS,
    deliveredAtMs: created + 10 * HOUR_MS,
    ciWaitMs: HOUR_MS,
    reviewWaitMs: 2 * HOUR_MS,
    handoffs: 2,
    fixRounds: 1,
    costUsd: null,
    ...over,
  };
}

describe("flow metrics", () => {
  it("splits delivery time into assignment, execution, CI and review wait", () => {
    const s = summarizeFlow([rec(1), rec(2)]);
    expect(s.assignmentWaitMs.median).toBe(2 * HOUR_MS);
    expect(s.executionMs.median).toBe(7 * HOUR_MS);
    expect(s.totalToDeliveryMs.median).toBe(10 * HOUR_MS);
    expect(s.ciWaitMs.median).toBe(HOUR_MS);
    expect(s.reviewWaitMs.median).toBe(2 * HOUR_MS);
  });

  it("keeps unknown cost as unknown, not zero", () => {
    const s = summarizeFlow([rec(1), rec(2)]);
    expect(s.costUsd).toEqual({ n: 0, median: null });
    const withCost = summarizeFlow([rec(1, { costUsd: 4 }), rec(2, { costUsd: null }), rec(3, { costUsd: 2 })]);
    expect(withCost.costUsd).toEqual({ n: 2, median: 3 });
  });

  it("does not turn undelivered or unstarted work into a duration", () => {
    const s = summarizeFlow([rec(1, { deliveredAtMs: null, firstRunStartedAtMs: null })]);
    expect(s.executionMs.median).toBeNull();
    expect(s.totalToDeliveryMs.median).toBeNull();
    expect(s.assignmentWaitMs.median).toBeNull();
    expect(s.deliveredTasks).toBe(0);
  });

  it("compares only inside a cohort and only with enough delivered tasks", () => {
    const before = [1, 2, 3].map((i) => rec(i));
    const after = [1, 2, 3].map((i) => rec(100 + i, {
      createdAtMs: CUT + i * HOUR_MS,
      assignedAtMs: CUT + i * HOUR_MS,
      firstRunStartedAtMs: CUT + (i + 1) * HOUR_MS,
      deliveredAtMs: CUT + (i + 5) * HOUR_MS,
    }));
    const docs = [rec(50, { cohort: "docs" })];
    const out = compareFlow({ ok: true, records: [...before, ...after, ...docs] }, CUT);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const code = out.comparison.cohorts.find((c) => c.cohort === "code")!;
    const docsC = out.comparison.cohorts.find((c) => c.cohort === "docs")!;
    expect(code.comparable).toBe(true);
    expect(code.before.totalToDeliveryMs.median).toBe(10 * HOUR_MS);
    expect(code.after.totalToDeliveryMs.median).toBe(5 * HOUR_MS);
    expect(docsC.comparable).toBe(false);
    expect(docsC.note).toMatch(/Bez wniosku/);
  });

  it("does not count a non-finite delivery time as delivered", () => {
    const bad = (offset: number) => [1, 2, 3].map((i) => rec(offset + i, { deliveredAtMs: Number.NaN }));
    expect(summarizeFlow(bad(0)).deliveredTasks).toBe(0);
    const after = [1, 2, 3].map((i) => rec(100 + i, { createdAtMs: CUT + i * HOUR_MS, deliveredAtMs: Number.NaN }));
    const out = compareFlow({ ok: true, records: [...bad(0), ...after] }, CUT);
    expect(out.ok && out.comparison.cohorts[0]!.comparable).toBe(false);
  });

  it("reports card counts as context only and fails loudly on a read failure", () => {
    const out = compareFlow({ ok: true, records: [rec(1), rec(2, { createdAtMs: CUT + HOUR_MS })] }, CUT);
    expect(out.ok && out.comparison.cardsBefore).toBe(1);
    expect(out.ok && out.comparison.cardsAfter).toBe(1);
    expect(compareFlow({ ok: false, reason: "read_failed" }, CUT)).toEqual({ ok: false, reason: "read_failed" });
    expect(compareFlow(null, CUT)).toEqual({ ok: false, reason: "read_failed" });
  });
});
