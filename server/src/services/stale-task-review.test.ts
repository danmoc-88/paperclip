import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  HOUR_MS,
  classifyTask,
  lastSubstantiveProgressAt,
  resolveThresholds,
  reviewQueue,
  type TaskSnapshot,
} from "./stale-task-review.js";

const NOW = Date.parse("2026-10-14T00:00:00Z");
const thresholds = resolveThresholds();

function task(partial: Partial<TaskSnapshot> & Pick<TaskSnapshot, "id" | "identifier">): TaskSnapshot {
  return {
    title: partial.identifier,
    status: "in_progress",
    ownerId: "owner-1",
    activeRun: false,
    queuedRun: false,
    hasCheckpoint: false,
    previouslyApproved: false,
    closeEvidence: false,
    questionAlreadyOpen: false,
    consciousDeferral: null,
    blocker: null,
    duplicateOf: null,
    progress: [{ atMs: NOW - 30 * 60_000, kind: "substantive" }],
    ...partial,
  };
}

describe("classifyTask", () => {
  it("does not treat a long active run as dead", () => {
    const result = classifyTask(task({
      id: "a",
      identifier: "SAK-1",
      activeRun: true,
      progress: [{ atMs: NOW - 40 * DAY_MS, kind: "substantive" }],
    }), NOW, thresholds);
    expect(result.category).toBeNull();
    expect(result.alarm).toBe(false);
    expect(result.reason).toMatch(/aktywna/i);
  });

  it("keeps a conscious deferral open until its return condition", () => {
    const result = classifyTask(task({
      id: "d",
      identifier: "SAK-2",
      status: "blocked",
      consciousDeferral: { condition: "po instalacji 0.3.0", reviewAfterMs: NOW + 10 * DAY_MS },
      progress: [{ atMs: NOW - 30 * DAY_MS, kind: "substantive" }],
    }), NOW, thresholds);
    expect(result.category).toBe("defer_with_return");
    expect(result.alarm).toBe(false);
    expect(result.recommendedAction).toMatch(/Nie zamykać/);
    expect(result.servicerMayAct).toBe(false);
  });

  it("rechecks an expired deferral without closing it", () => {
    const result = classifyTask(task({
      id: "d2",
      identifier: "SAK-3",
      consciousDeferral: { condition: "po instalacji 0.3.0", reviewAfterMs: NOW - HOUR_MS },
    }), NOW, thresholds);
    expect(result.category).toBe("defer_with_return");
    expect(result.alarm).toBe(true);
    expect(result.recommendedAction).toMatch(/Nie zamykać/);
  });

  it("ignores control comments when measuring stagnation", () => {
    const snapshot = task({
      id: "c",
      identifier: "SAK-4",
      progress: [
        { atMs: NOW - 10 * DAY_MS, kind: "substantive" },
        { atMs: NOW - HOUR_MS, kind: "control" },
      ],
    });
    expect(lastSubstantiveProgressAt(snapshot)).toBe(NOW - 10 * DAY_MS);
    const result = classifyTask(snapshot, NOW, thresholds);
    expect(result.idleMs).toBe(10 * DAY_MS);
    expect(result.category).toBe("resume");
    expect(result.alarm).toBe(true);
  });

  it("does not treat control-only activity as fresh progress or as a dead task", () => {
    const result = classifyTask(task({
      id: "c2",
      identifier: "SAK-5",
      progress: [{ atMs: NOW - 5 * 60_000, kind: "control" }],
    }), NOW, thresholds);
    expect(result.lastSubstantiveAtMs).toBeNull();
    expect(result.category).toBeNull();
    expect(result.alarm).toBe(false);
  });

  it("marks a resolved dependency as a resume candidate and resumes only an approved checkpoint", () => {
    const approved = classifyTask(task({
      id: "r",
      identifier: "SAK-6",
      status: "blocked",
      previouslyApproved: true,
      hasCheckpoint: true,
      blocker: { id: "b", identifier: "SAK-B", title: "zależność", status: "done", requiresHuman: false },
    }), NOW, thresholds);
    expect(approved.category).toBe("resume");
    expect(approved.servicerMayAct).toBe(true);
    const unapproved = classifyTask(task({
      id: "r2",
      identifier: "SAK-7",
      status: "blocked",
      blocker: { id: "b", identifier: "SAK-B", title: "zależność", status: "done", requiresHuman: false },
    }), NOW, thresholds);
    expect(unapproved.category).toBe("resume");
    expect(unapproved.servicerMayAct).toBe(false);
  });

  it("requires evidence before calling a task a duplicate", () => {
    const missing = classifyTask(task({
      id: "dup",
      identifier: "SAK-8",
      duplicateOf: { id: "other", identifier: "SAK-9", evidence: false },
    }), NOW, thresholds);
    expect(missing.category).toBeNull();
    expect(missing.reason).toMatch(/dowodu/);
    const proven = classifyTask(task({
      id: "dup2",
      identifier: "SAK-10",
      duplicateOf: { id: "other", identifier: "SAK-9", evidence: true },
    }), NOW, thresholds);
    expect(proven.category).toBe("duplicate");
    expect(proven.needsHuman).toBe(true);
    expect(proven.servicerMayAct).toBe(false);
  });

  it("does not ask again when a human question is already open", () => {
    const result = classifyTask(task({
      id: "q",
      identifier: "SAK-11",
      status: "in_review",
      questionAlreadyOpen: true,
      progress: [{ atMs: NOW - 5 * DAY_MS, kind: "substantive" }],
    }), NOW, thresholds);
    expect(result.question).toBeNull();
    expect(result.recommendedAction).toMatch(/Nie pytać/);
  });

  it("keeps a short named wait out of the alarm set", () => {
    const result = classifyTask(task({
      id: "w",
      identifier: "SAK-12",
      status: "blocked",
      blocker: { id: "b", identifier: "SAK-B", title: "czekamy", status: "blocked", requiresHuman: true },
      progress: [{ atMs: NOW - 30 * 60_000, kind: "substantive" }],
    }), NOW, thresholds);
    expect(result.alarm).toBe(false);
    expect(result.category).toBe("wait_named_dependency");
  });

  it("is idempotent for the same snapshot", () => {
    const snapshot = task({ id: "same", identifier: "SAK-13" });
    expect(classifyTask(snapshot, NOW, thresholds)).toEqual(classifyTask(snapshot, NOW, thresholds));
  });
});

describe("reviewQueue", () => {
  it("fails closed when the queue cannot be read", () => {
    expect(reviewQueue(null, NOW).ok).toBe(false);
    expect(reviewQueue({ ok: false, reason: "read_failed" }, NOW)).toEqual({
      ok: false,
      reason: "read_failed",
      analyzed: 0,
      digest: null,
    });
    const empty = reviewQueue({ ok: true, tasks: [] }, NOW);
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.digest.notify).toBe(false);
  });

  it("covers a 400-task queue without flooding or repeating the next cycle", () => {
    const tasks: TaskSnapshot[] = [];
    const push = (count: number, build: (index: number) => TaskSnapshot) => {
      for (let index = 0; index < count; index += 1) tasks.push(build(index));
    };
    push(266, (index) => task({
      id: `backlog-${index}`,
      identifier: `B-${index}`,
      status: "backlog",
      progress: [{ atMs: NOW - HOUR_MS, kind: "substantive" }],
    }));
    push(40, (index) => task({
      id: `live-${index}`,
      identifier: `L-${index}`,
      activeRun: true,
      progress: [{ atMs: NOW - 40 * DAY_MS, kind: "substantive" }],
    }));
    push(20, (index) => task({
      id: `short-${index}`,
      identifier: `S-${index}`,
      progress: [{ atMs: NOW - 30 * 60_000, kind: "substantive" }],
    }));
    push(14, (index) => task({
      id: `short-block-${index}`,
      identifier: `SB-${index}`,
      status: "blocked",
      blocker: { id: "blocker-a", identifier: "SAK-A", title: "krótka zależność", status: "in_progress", requiresHuman: false },
      progress: [{ atMs: NOW - 30 * 60_000, kind: "substantive" }],
    }));
    push(14, (index) => task({
      id: `long-block-${index}`,
      identifier: `LB-${index}`,
      status: "blocked",
      blocker: { id: "blocker-b", identifier: "SAK-B", title: "długa zależność", status: "blocked", requiresHuman: false },
      progress: [{ atMs: NOW - 20 * DAY_MS, kind: "substantive" }],
    }));
    push(10, (index) => task({
      id: `owner-${index}`,
      identifier: `O-${index}`,
      ownerId: null,
      progress: [{ atMs: NOW - 12 * HOUR_MS, kind: "substantive" }],
    }));
    push(8, (index) => task({
      id: `defer-${index}`,
      identifier: `D-${index}`,
      consciousDeferral: { condition: "nazwany warunek", reviewAfterMs: NOW + DAY_MS },
      progress: [{ atMs: NOW - 30 * DAY_MS, kind: "substantive" }],
    }));
    push(5, (index) => task({
      id: `resume-${index}`,
      identifier: `R-${index}`,
      previouslyApproved: true,
      hasCheckpoint: true,
      causeKey: "approved-checkpoint",
      causeLabel: "Zatwierdzona praca z checkpointu",
      progress: [
        { atMs: NOW - 10 * DAY_MS, kind: "substantive" },
        { atMs: NOW - HOUR_MS, kind: "control" },
      ],
    }));
    push(5, (index) => task({
      id: `dup-miss-${index}`,
      identifier: `DM-${index}`,
      duplicateOf: { id: "ghost", identifier: "SAK-G", evidence: false },
    }));
    push(4, (index) => task({
      id: `dup-${index}`,
      identifier: `DP-${index}`,
      duplicateOf: { id: "canon", identifier: "SAK-C", evidence: true },
    }));
    push(6, (index) => task({
      id: `human-c-${index}`,
      identifier: `HC-${index}`,
      status: "blocked",
      blocker: { id: "blocker-c", identifier: "SAK-C", title: "decyzja C", status: "blocked", requiresHuman: true },
      progress: [{ atMs: NOW - 20 * DAY_MS, kind: "substantive" }],
    }));
    push(5, (index) => task({
      id: `human-d-${index}`,
      identifier: `HD-${index}`,
      status: "blocked",
      blocker: { id: "blocker-d", identifier: "SAK-D", title: "decyzja D", status: "blocked", requiresHuman: true },
      progress: [{ atMs: NOW - 20 * DAY_MS, kind: "substantive" }],
    }));
    push(3, (index) => task({
      id: `human-e-${index}`,
      identifier: `HE-${index}`,
      status: "blocked",
      blocker: { id: "blocker-e", identifier: "SAK-E", title: "decyzja E", status: "blocked", requiresHuman: true },
      progress: [{ atMs: NOW - 20 * DAY_MS, kind: "substantive" }],
    }));
    expect(tasks).toHaveLength(400);

    const first = reviewQueue({ ok: true, tasks }, NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.analyzed).toBe(400);
    expect(first.matters.length + first.notMatters).toBe(400);
    expect(first.digest.suppressedShortWait).toBeGreaterThanOrEqual(300);
    expect(first.digest.danielTopics).toHaveLength(3);
    expect(first.digest.danielTopics.map((topic) => topic.impact)).toEqual([10, 6, 5]);
    expect(first.digest.danielTopics.some((topic) => topic.identifiers.some((id) => id.startsWith("SB-")))).toBe(false);
    const longWait = first.groups.find((group) => group.causeKey === "blocker:blocker-b");
    expect(longWait?.impact).toBe(14);
    expect(longWait?.needsHuman).toBe(false);
    expect(first.digest.servicerActions.map((group) => group.causeKey)).toEqual(["approved-checkpoint"]);
    expect(first.digest.notify).toBe(true);
    expect(first.digest.ownerFollowUps.map((group) => group.causeKey)).toEqual(["blocker:blocker-b"]);
    expect(first.digest.fingerprints).toHaveLength(
      first.digest.danielTopics.length + first.digest.servicerActions.length + first.digest.ownerFollowUps.length,
    );
    expect(first.matters.every((item) => item.category !== "close_after_evidence" || item.needsHuman)).toBe(true);

    const second = reviewQueue({ ok: true, tasks }, NOW + 2 * HOUR_MS, undefined, {
      atMs: NOW,
      fingerprints: first.digest.fingerprints,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.analyzed).toBe(400);
    expect(second.digest.danielTopics.map((topic) => topic.causeKey)).toEqual(["duplicate:canon", "blocker:blocker-e"]);
    expect(second.digest.servicerActions).toEqual([]);
    expect(second.digest.ownerFollowUps).toEqual([]);
    expect(second.digest.notify).toBe(true);
    expect(second.digest.suppressedUnchanged).toBe(5);
    const alreadyShown = new Set(first.digest.danielTopics.map((topic) => topic.causeKey));
    expect(second.digest.danielTopics.some((topic) => alreadyShown.has(topic.causeKey))).toBe(false);

    const third = reviewQueue({ ok: true, tasks }, NOW + 4 * HOUR_MS, undefined, {
      atMs: second.digest.shown[0]?.atMs ?? NOW,
      fingerprints: second.digest.fingerprints,
      shown: second.digest.shown,
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.digest.danielTopics).toEqual([]);
    expect(third.digest.servicerActions).toEqual([]);
    expect(third.digest.notify).toBe(false);

    const reminded = reviewQueue({ ok: true, tasks }, NOW + 25 * HOUR_MS, undefined, {
      atMs: NOW,
      fingerprints: first.digest.fingerprints,
    });
    expect(reminded.ok).toBe(true);
    if (!reminded.ok) return;
    expect(reminded.digest.danielTopics).toHaveLength(3);
    expect(reminded.digest.notify).toBe(true);
  });

  it("shows a capped topic on the next cycle and does not repeat the first three", () => {
    const causes = ["a", "b", "c", "d"] as const;
    const tasks = causes.map((name, index) => task({
      id: name,
      identifier: `SAK-${name}`,
      ownerId: null,
      causeKey: name,
      causeLabel: name,
      progress: [{ atMs: NOW - (12 + index) * HOUR_MS, kind: "substantive" }],
    }));
    const first = reviewQueue({ ok: true, tasks }, NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.digest.danielTopics.map((topic) => topic.causeKey)).toEqual(["a", "b", "c"]);
    expect(first.digest.fingerprints).toEqual(["a|fix_assignment", "b|fix_assignment", "c|fix_assignment"]);

    const second = reviewQueue({ ok: true, tasks }, NOW + 2 * HOUR_MS, undefined, {
      atMs: NOW,
      fingerprints: first.digest.fingerprints,
      shown: first.digest.shown,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.digest.danielTopics.map((topic) => topic.causeKey)).toEqual(["d"]);
    expect(second.digest.notify).toBe(true);

    const third = reviewQueue({ ok: true, tasks }, NOW + 4 * HOUR_MS, undefined, {
      atMs: NOW,
      fingerprints: second.digest.fingerprints,
      shown: second.digest.shown,
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.digest.danielTopics).toEqual([]);
    expect(third.digest.notify).toBe(false);

    const reminded = reviewQueue({ ok: true, tasks }, NOW + 25 * HOUR_MS, undefined, {
      atMs: NOW,
      fingerprints: second.digest.fingerprints,
      shown: second.digest.shown,
    });
    expect(reminded.ok).toBe(true);
    if (!reminded.ok) return;
    expect(reminded.digest.danielTopics.map((topic) => topic.causeKey)).toEqual(["a", "b", "c"]);
  });

  it("does not repeat an owner follow-up inside the throttle", () => {
    const owned = task({
      id: "owner-task",
      identifier: "ATN-1",
      title: "Owner follow-up",
      progress: [{ atMs: NOW - 12 * HOUR_MS, kind: "substantive" }],
    });
    const first = reviewQueue({ ok: true, tasks: [owned] }, NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.digest.notify).toBe(false);
    expect(first.digest.ownerFollowUps.map((group) => group.fingerprint)).toEqual(["task:owner-task|resume"]);
    expect(first.digest.fingerprints).toEqual(["task:owner-task|resume"]);

    const second = reviewQueue({ ok: true, tasks: [owned] }, NOW + 2 * HOUR_MS, undefined, {
      atMs: NOW,
      fingerprints: first.digest.fingerprints,
      shown: first.digest.shown,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.digest.ownerFollowUps).toEqual([]);
    expect(second.digest.notify).toBe(false);
    expect(second.digest.suppressedUnchanged).toBe(1);
  });

  it("still surfaces a new cause during the reminder throttle", () => {
    const held = task({
      id: "held",
      identifier: "SAK-H",
      ownerId: null,
      progress: [{ atMs: NOW - 12 * HOUR_MS, kind: "substantive" }],
    });
    const first = reviewQueue({ ok: true, tasks: [held] }, NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const fresh = task({
      id: "fresh",
      identifier: "SAK-F",
      closeEvidence: true,
      progress: [{ atMs: NOW - 3 * DAY_MS, kind: "substantive" }],
    });
    const second = reviewQueue({ ok: true, tasks: [held, fresh] }, NOW + 2 * HOUR_MS, undefined, {
      atMs: NOW,
      fingerprints: first.digest.fingerprints,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.digest.danielTopics.map((topic) => topic.causeKey)).toEqual(["task:fresh"]);
    expect(second.analyzed).toBe(2);
  });
});
