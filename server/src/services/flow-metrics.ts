// Before/after delivery-flow comparison for the SAK-40 supervision cycle.
// Pure: reads records the cycle already has, adds no schedule or storage.
// Unknown stays unknown. A missing cost is null, never zero. The number of
// cards is not a success measure, so it is reported as context only.

export interface FlowRecord {
  id: string;
  identifier: string;
  // Used to compare like with like. Tasks in different cohorts are never mixed.
  cohort: string;
  createdAtMs: number;
  assignedAtMs: number | null;
  firstRunStartedAtMs: number | null;
  deliveredAtMs: number | null;
  ciWaitMs: number | null;
  reviewWaitMs: number | null;
  handoffs: number | null;
  fixRounds: number | null;
  costUsd: number | null;
}

export interface MetricSummary {
  n: number;
  median: number | null;
}

export interface FlowSummary {
  tasks: number;
  deliveredTasks: number;
  assignmentWaitMs: MetricSummary;
  executionMs: MetricSummary;
  ciWaitMs: MetricSummary;
  reviewWaitMs: MetricSummary;
  totalToDeliveryMs: MetricSummary;
  handoffs: MetricSummary;
  fixRounds: MetricSummary;
  costUsd: MetricSummary;
}

export interface CohortComparison {
  cohort: string;
  before: FlowSummary;
  after: FlowSummary;
  // Shown only when both sides have enough delivered tasks of this cohort.
  comparable: boolean;
  note: string;
}

export interface FlowComparison {
  cutoffMs: number;
  minPerSide: number;
  cohorts: CohortComparison[];
  // Cards created is context, not an outcome.
  cardsBefore: number;
  cardsAfter: number;
}

export const DEFAULT_MIN_PER_SIDE = 3;

function median(values: Array<number | null | undefined>): MetricSummary {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (nums.length === 0) return { n: 0, median: null };
  const mid = Math.floor(nums.length / 2);
  const value = nums.length % 2 === 1 ? nums[mid]! : (nums[mid - 1]! + nums[mid]!) / 2;
  return { n: nums.length, median: value };
}

function diff(to: number | null, from: number | null): number | null {
  return to !== null && from !== null && to >= from ? to - from : null;
}

export function summarizeFlow(records: FlowRecord[]): FlowSummary {
  return {
    tasks: records.length,
    deliveredTasks: records.filter((r) => r.deliveredAtMs !== null).length,
    assignmentWaitMs: median(records.map((r) => diff(r.firstRunStartedAtMs, r.assignedAtMs))),
    executionMs: median(records.map((r) => diff(r.deliveredAtMs, r.firstRunStartedAtMs))),
    ciWaitMs: median(records.map((r) => r.ciWaitMs)),
    reviewWaitMs: median(records.map((r) => r.reviewWaitMs)),
    totalToDeliveryMs: median(records.map((r) => diff(r.deliveredAtMs, r.createdAtMs))),
    handoffs: median(records.map((r) => r.handoffs)),
    fixRounds: median(records.map((r) => r.fixRounds)),
    costUsd: median(records.map((r) => r.costUsd)),
  };
}

export type FlowRead =
  | { ok: true; records: FlowRecord[] }
  | { ok: false; reason: "read_failed" };

// A failed read never looks like an empty comparison.
export function compareFlow(
  read: FlowRead | null,
  cutoffMs: number,
  minPerSide: number = DEFAULT_MIN_PER_SIDE,
): { ok: true; comparison: FlowComparison } | { ok: false; reason: "read_failed" } {
  if (!read || read.ok === false) return { ok: false, reason: "read_failed" };
  const cohorts = new Map<string, FlowRecord[]>();
  for (const record of read.records) {
    const list = cohorts.get(record.cohort) ?? [];
    list.push(record);
    cohorts.set(record.cohort, list);
  }
  const result: CohortComparison[] = [];
  for (const [cohort, records] of [...cohorts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const before = summarizeFlow(records.filter((r) => r.createdAtMs < cutoffMs));
    const after = summarizeFlow(records.filter((r) => r.createdAtMs >= cutoffMs));
    const comparable = before.deliveredTasks >= minPerSide && after.deliveredTasks >= minPerSide;
    result.push({
      cohort,
      before,
      after,
      comparable,
      note: comparable
        ? "Porównywalne zakresy tej samej grupy."
        : `Za mało dostarczonych zadań po jednej ze stron (min ${minPerSide}). Bez wniosku o poprawie albo pogorszeniu.`,
    });
  }
  return {
    ok: true,
    comparison: {
      cutoffMs,
      minPerSide,
      cohorts: result,
      cardsBefore: read.records.filter((r) => r.createdAtMs < cutoffMs).length,
      cardsAfter: read.records.filter((r) => r.createdAtMs >= cutoffMs).length,
    },
  };
}
