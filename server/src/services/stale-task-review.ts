// Classifies stale, deferred, and superseded tasks for the existing SAK-40
// supervision cycle. Pure: the same inputs always yield the same result.
// It does not close tasks, wake agents, send messages, or add a schedule.
// Age is a signal. A missing read is a failure, not an empty queue.

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

// Examples recorded as defaults, not a rigid SLA. Callers can override them.
// in-progress idle sits above one 2h supervision cycle. Backlog and a named
// wait sit on a scale of days. Reminders wait a day so two cycles do not repeat.
export const DEFAULT_STALE_THRESHOLDS = {
  inProgressIdleMs: 6 * HOUR_MS,
  blockedNamedDependencyMs: 7 * DAY_MS,
  backlogQuietMs: 14 * DAY_MS,
  humanReviewQuietMs: 3 * DAY_MS,
  reminderThrottleMs: 24 * HOUR_MS,
  shortWaitMs: 2 * HOUR_MS,
} as const;

export const MAX_DANIEL_TOPICS = 3;

const SUBSTANTIVE_PROGRESS = new Set(["substantive", "dependency_resolved", "assignment"]);
const TERMINAL_STATUS = new Set(["done", "cancelled"]);

export type ProgressKind = "substantive" | "control" | "dependency_resolved" | "assignment";

export type MatterCategory =
  | "resume"
  | "fix_assignment"
  | "wait_named_dependency"
  | "defer_with_return"
  | "duplicate"
  | "close_after_evidence";

export interface TaskSnapshot {
  id: string;
  identifier: string;
  title: string;
  status: string;
  ownerId: string | null;
  activeRun: boolean;
  queuedRun: boolean;
  hasCheckpoint: boolean;
  previouslyApproved: boolean;
  closeEvidence: boolean;
  questionAlreadyOpen: boolean;
  consciousDeferral: { condition: string; reviewAfterMs: number } | null;
  blocker: {
    id: string;
    identifier: string;
    title: string;
    status: string;
    requiresHuman: boolean;
  } | null;
  duplicateOf: { id: string; identifier: string; evidence: boolean } | null;
  progress: Array<{ atMs: number; kind: ProgressKind }>;
  causeKey?: string;
  causeLabel?: string;
}

export interface StaleThresholds {
  inProgressIdleMs: number;
  blockedNamedDependencyMs: number;
  backlogQuietMs: number;
  humanReviewQuietMs: number;
  reminderThrottleMs: number;
  shortWaitMs: number;
}

export interface ShownMatter {
  fingerprint: string;
  atMs: number;
}

export interface PriorDigest {
  atMs: number;
  fingerprints: string[];
  shown?: ShownMatter[];
}

export interface ClassifiedTask {
  id: string;
  identifier: string;
  category: MatterCategory | null;
  alarm: boolean;
  reason: string;
  recommendedAction: string;
  needsHuman: boolean;
  question: string | null;
  servicerMayAct: boolean;
  lastSubstantiveAtMs: number | null;
  idleMs: number | null;
  causeKey: string;
  causeLabel: string;
  fingerprint: string | null;
}

export interface CauseGroup {
  causeKey: string;
  causeLabel: string;
  category: MatterCategory;
  impact: number;
  identifiers: string[];
  needsHuman: boolean;
  question: string | null;
  servicerMayAct: boolean;
  recommendedAction: string;
  reason: string;
  fingerprint: string;
  throttled: boolean;
}

export type QueueRead =
  | { ok: true; tasks: TaskSnapshot[] }
  | { ok: false; reason: "read_failed" };

export type ReviewResult =
  | {
      ok: true;
      analyzed: number;
      matters: ClassifiedTask[];
      notMatters: number;
      groups: CauseGroup[];
      digest: {
        danielTopics: CauseGroup[];
        servicerActions: CauseGroup[];
        ownerFollowUps: CauseGroup[];
        suppressedUnchanged: number;
        suppressedShortWait: number;
        notify: boolean;
        fingerprints: string[];
        shown: ShownMatter[];
      };
    }
  | { ok: false; reason: "read_failed"; analyzed: 0; digest: null };

const URGENCY: Record<MatterCategory, number> = {
  fix_assignment: 50,
  resume: 40,
  close_after_evidence: 30,
  duplicate: 20,
  wait_named_dependency: 10,
  defer_with_return: 5,
};

export function resolveThresholds(override?: Partial<StaleThresholds>): StaleThresholds {
  return { ...DEFAULT_STALE_THRESHOLDS, ...override };
}

export function lastSubstantiveProgressAt(task: TaskSnapshot): number | null {
  let best: number | null = null;
  for (const event of task.progress) {
    if (!SUBSTANTIVE_PROGRESS.has(event.kind)) continue;
    if (best === null || event.atMs > best) best = event.atMs;
  }
  return best;
}

function deriveCause(task: TaskSnapshot): { key: string; label: string } {
  if (task.causeKey && task.causeLabel) return { key: task.causeKey, label: task.causeLabel };
  if (task.blocker) {
    return {
      key: `blocker:${task.blocker.id}`,
      label: `${task.blocker.identifier}: ${task.blocker.title}`,
    };
  }
  if (task.duplicateOf?.evidence) {
    return {
      key: `duplicate:${task.duplicateOf.id}`,
      label: `Możliwy duplikat ${task.duplicateOf.identifier}`,
    };
  }
  if (!task.ownerId && task.status === "in_progress") {
    return { key: "missing-owner", label: "Praca w toku bez właściciela" };
  }
  return { key: `task:${task.id}`, label: `${task.identifier}: ${task.title}` };
}

function notMatter(
  task: TaskSnapshot,
  cause: { key: string; label: string },
  reason: string,
  idleMs: number | null,
  lastSubstantiveAtMs: number | null,
): ClassifiedTask {
  return {
    id: task.id,
    identifier: task.identifier,
    category: null,
    alarm: false,
    reason,
    recommendedAction: "",
    needsHuman: false,
    question: null,
    servicerMayAct: false,
    lastSubstantiveAtMs,
    idleMs,
    causeKey: cause.key,
    causeLabel: cause.label,
    fingerprint: null,
  };
}

function matter(input: {
  task: TaskSnapshot;
  cause: { key: string; label: string };
  category: MatterCategory;
  alarm: boolean;
  reason: string;
  recommendedAction: string;
  needsHuman: boolean;
  question: string | null;
  servicerMayAct: boolean;
  idleMs: number | null;
  lastSubstantiveAtMs: number | null;
}): ClassifiedTask {
  return {
    id: input.task.id,
    identifier: input.task.identifier,
    category: input.category,
    alarm: input.alarm,
    reason: input.reason,
    recommendedAction: input.recommendedAction,
    needsHuman: input.needsHuman,
    question: input.question,
    servicerMayAct: input.servicerMayAct,
    lastSubstantiveAtMs: input.lastSubstantiveAtMs,
    idleMs: input.idleMs,
    causeKey: input.cause.key,
    causeLabel: input.cause.label,
    fingerprint: input.alarm ? `${input.cause.key}|${input.category}` : null,
  };
}

export function classifyTask(
  task: TaskSnapshot,
  nowMs: number,
  thresholds: StaleThresholds,
): ClassifiedTask {
  const cause = deriveCause(task);
  const lastSubstantiveAtMs = lastSubstantiveProgressAt(task);
  const idleMs = lastSubstantiveAtMs === null ? null : Math.max(0, nowMs - lastSubstantiveAtMs);
  const idleKnown = idleMs !== null;

  if (TERMINAL_STATUS.has(task.status)) {
    return notMatter(task, cause, "Zadanie jest zakończone.", idleMs, lastSubstantiveAtMs);
  }
  if (task.activeRun || task.queuedRun) {
    return notMatter(task, cause, "Praca jest aktywna albo czeka w kolejce uruchomienia.", idleMs, lastSubstantiveAtMs);
  }
  if (task.closeEvidence) {
    return matter({
      task,
      cause,
      category: "close_after_evidence",
      alarm: true,
      reason: "Jest osobny dowód zamknięcia. Sam wiek ani cisza go nie zastępują.",
      recommendedAction: "Zamknąć dopiero po decyzji człowieka na podstawie tego dowodu.",
      needsHuman: true,
      question: task.questionAlreadyOpen ? null : `Zamknąć ${task.identifier} na podstawie wskazanego dowodu?`,
      servicerMayAct: false,
      idleMs,
      lastSubstantiveAtMs,
    });
  }
  if (task.duplicateOf && !task.duplicateOf.evidence) {
    return notMatter(task, cause, "Podobieństwo bez dowodu nie jest duplikatem.", idleMs, lastSubstantiveAtMs);
  }
  if (task.duplicateOf?.evidence) {
    return matter({
      task,
      cause,
      category: "duplicate",
      alarm: true,
      reason: `Jest dowód, że pracę zastępuje ${task.duplicateOf.identifier}.`,
      recommendedAction: "Połączyć albo zamknąć jako zastąpione dopiero po decyzji. Nie zamykać z podobieństwa tytułu.",
      needsHuman: true,
      question: task.questionAlreadyOpen
        ? null
        : `Połączyć ${task.identifier} z ${task.duplicateOf.identifier}?`,
      servicerMayAct: false,
      idleMs,
      lastSubstantiveAtMs,
    });
  }
  if (task.consciousDeferral && nowMs < task.consciousDeferral.reviewAfterMs) {
    return matter({
      task,
      cause,
      category: "defer_with_return",
      alarm: false,
      reason: `Świadomie odłożone do: ${task.consciousDeferral.condition}.`,
      recommendedAction: "Zostawić. Nie zamykać i nie budzić przed warunkiem powrotu.",
      needsHuman: false,
      question: null,
      servicerMayAct: false,
      idleMs,
      lastSubstantiveAtMs,
    });
  }
  if (task.consciousDeferral) {
    return matter({
      task,
      cause,
      category: "defer_with_return",
      alarm: true,
      reason: `Minął warunek powrotu: ${task.consciousDeferral.condition}.`,
      recommendedAction: "Sprawdzić warunek powrotu. Nie zamykać z upływu czasu.",
      needsHuman: false,
      question: null,
      servicerMayAct: false,
      idleMs,
      lastSubstantiveAtMs,
    });
  }
  if (task.blocker && TERMINAL_STATUS.has(task.blocker.status)) {
    const servicerMayAct = task.previouslyApproved && task.hasCheckpoint;
    return matter({
      task,
      cause,
      category: "resume",
      alarm: true,
      reason: `Zależność ${task.blocker.identifier} jest zakończona.`,
      recommendedAction: servicerMayAct
        ? "Wznowić wcześniej zatwierdzoną pracę z checkpointu. Nie ruszać aktywnego przebiegu."
        : "Właściciel może wznowić pracę. Brak checkpointu albo wcześniejszej zgody, więc serwisant sam jej nie budzi.",
      needsHuman: false,
      question: null,
      servicerMayAct,
      idleMs,
      lastSubstantiveAtMs,
    });
  }
  if (task.blocker) {
    const stagnant = idleKnown && idleMs >= thresholds.blockedNamedDependencyMs;
    const short = idleKnown && idleMs < thresholds.shortWaitMs;
    return matter({
      task,
      cause,
      category: "wait_named_dependency",
      alarm: stagnant,
      reason: short
        ? `Krótkie oczekiwanie na ${task.blocker.identifier}.`
        : stagnant
          ? `Nazwana zależność ${task.blocker.identifier} stoi dłużej niż próg sprawdzenia.`
          : `Czeka na ${task.blocker.identifier}. To nie jest alarm.`,
      recommendedAction: task.blocker.requiresHuman
        ? "Zostawić nazwaną zależność. Nie zdejmować blokady i nie powtarzać pytania, jeśli już jest."
        : "Zostawić nazwaną zależność u jej właściciela. Nie zdejmować realnej blokady.",
      needsHuman: stagnant && task.blocker.requiresHuman,
      question: stagnant && task.blocker.requiresHuman && !task.questionAlreadyOpen
        ? `Co dalej z zależnością ${task.blocker.identifier}, która blokuje ${task.identifier}?`
        : null,
      servicerMayAct: false,
      idleMs,
      lastSubstantiveAtMs,
    });
  }
  if (task.questionAlreadyOpen) {
    const due = idleKnown && idleMs >= thresholds.humanReviewQuietMs;
    return matter({
      task,
      cause,
      category: "wait_named_dependency",
      alarm: due,
      reason: due
        ? "Otwarte pytanie człowieka przekroczyło próg przypomnienia."
        : "Pytanie człowieka jest już otwarte.",
      recommendedAction: "Nie pytać ponownie.",
      needsHuman: due,
      question: null,
      servicerMayAct: false,
      idleMs,
      lastSubstantiveAtMs,
    });
  }
  if (task.status === "in_progress" && idleKnown && idleMs >= thresholds.inProgressIdleMs) {
    if (!task.ownerId) {
      return matter({
        task,
        cause,
        category: "fix_assignment",
        alarm: true,
        reason: "Praca w toku nie ma właściciela ani aktywnego przebiegu.",
        recommendedAction: "Poprawić przydział. Serwisant nie zmienia wykonawcy rutyny sam.",
        needsHuman: true,
        question: `Kto ma przejąć ${task.identifier}?`,
        servicerMayAct: false,
        idleMs,
        lastSubstantiveAtMs,
      });
    }
    const servicerMayAct = task.previouslyApproved && task.hasCheckpoint;
    return matter({
      task,
      cause,
      category: "resume",
      alarm: true,
      reason: "Brak aktywnego przebiegu, a ostatni merytoryczny ślad jest starszy niż próg.",
      recommendedAction: servicerMayAct
        ? "Wznowić wcześniej zatwierdzoną pracę z checkpointu."
        : "Zostawić właścicielowi. Komentarz kontrolny nie zeruje czasu bez postępu.",
      needsHuman: false,
      question: null,
      servicerMayAct,
      idleMs,
      lastSubstantiveAtMs,
    });
  }
  if (!idleKnown) {
    return notMatter(task, cause, "Brak merytorycznego śladu. Nie uznaję zadania za martwe.", idleMs, lastSubstantiveAtMs);
  }
  if (idleMs < thresholds.shortWaitMs) {
    return notMatter(task, cause, "Krótkie zwykłe oczekiwanie.", idleMs, lastSubstantiveAtMs);
  }
  if (
    (task.status === "backlog" || task.status === "todo")
    && idleMs >= thresholds.backlogQuietMs
  ) {
    return notMatter(task, cause, "Wiek backlogu bez innej przyczyny nie jest sprawą.", idleMs, lastSubstantiveAtMs);
  }
  return notMatter(task, cause, "Brak przyczyny do alarmu.", idleMs, lastSubstantiveAtMs);
}

function groupMatters(tasks: ClassifiedTask[], throttled: (fingerprint: string) => boolean): CauseGroup[] {
  const buckets = new Map<string, ClassifiedTask[]>();
  for (const task of tasks) {
    if (!task.alarm || !task.category || !task.fingerprint) continue;
    const list = buckets.get(task.fingerprint) ?? [];
    list.push(task);
    buckets.set(task.fingerprint, list);
  }
  const groups: CauseGroup[] = [];
  for (const list of buckets.values()) {
    const first = list[0];
    if (!first?.category || !first.fingerprint) continue;
    const needsHuman = list.some((task) => task.needsHuman);
    const servicerMayAct = list.every((task) => task.servicerMayAct);
    const question = needsHuman ? list.find((task) => task.question)?.question ?? null : null;
    groups.push({
      causeKey: first.causeKey,
      causeLabel: first.causeLabel,
      category: first.category,
      impact: list.length,
      identifiers: list.map((task) => task.identifier),
      needsHuman,
      question: question && list.length > 1
        ? `${first.causeLabel} (${list.length}). ${question}`
        : question,
      servicerMayAct,
      recommendedAction: first.recommendedAction,
      reason: first.reason,
      fingerprint: first.fingerprint,
      throttled: throttled(first.fingerprint),
    });
  }
  return groups.sort((a, b) => b.impact - a.impact || URGENCY[b.category] - URGENCY[a.category] || a.causeKey.localeCompare(b.causeKey));
}

export function reviewQueue(
  read: QueueRead | null,
  nowMs: number,
  override?: Partial<StaleThresholds>,
  prior?: PriorDigest | null,
): ReviewResult {
  if (!read || read.ok === false) {
    return { ok: false, reason: "read_failed", analyzed: 0, digest: null };
  }
  const thresholds = resolveThresholds(override);
  const shownAt = new Map<string, number>();
  if (prior?.shown) {
    for (const item of prior.shown) {
      if (nowMs - item.atMs < thresholds.reminderThrottleMs) shownAt.set(item.fingerprint, item.atMs);
    }
  } else if (prior) {
    for (const fingerprint of prior.fingerprints) {
      if (nowMs - prior.atMs < thresholds.reminderThrottleMs) shownAt.set(fingerprint, prior.atMs);
    }
  }
  const throttled = (fingerprint: string) => shownAt.has(fingerprint);
  const classified = read.tasks.map((task) => classifyTask(task, nowMs, thresholds));
  const matters = classified.filter((task) => task.category !== null);
  const groups = groupMatters(classified, throttled);
  const visible = (group: CauseGroup) => !group.throttled;
  const danielTopics = groups
    .filter((group) => group.needsHuman && visible(group))
    .slice(0, MAX_DANIEL_TOPICS);
  const servicerActions = groups.filter((group) => group.servicerMayAct && visible(group));
  const ownerFollowUps = groups.filter((group) => !group.needsHuman && !group.servicerMayAct && visible(group));
  // Only matters that were actually shown stay throttled. A topic past the
  // limit of three stays eligible for the next cycle. Previously shown matters
  // keep their original time so a later cycle does not refresh their window.
  for (const group of [...danielTopics, ...servicerActions]) {
    if (!shownAt.has(group.fingerprint)) shownAt.set(group.fingerprint, nowMs);
  }
  const shown = [...shownAt.entries()].map(([fingerprint, atMs]) => ({ fingerprint, atMs }));
  return {
    ok: true,
    analyzed: classified.length,
    matters,
    notMatters: classified.length - matters.length,
    groups,
    digest: {
      danielTopics,
      servicerActions,
      ownerFollowUps,
      suppressedUnchanged: groups.filter((group) => group.throttled).length,
      suppressedShortWait: classified.filter((task) => task.idleMs !== null && task.idleMs < thresholds.shortWaitMs && !task.alarm).length,
      notify: danielTopics.length > 0,
      fingerprints: shown.map((item) => item.fingerprint),
      shown,
    },
  };
}
