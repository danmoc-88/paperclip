import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Storage compaction for `heartbeat_runs.context_snapshot` of finished runs.
 *
 * While a run executes, its snapshot carries the full continuation envelope
 * (every task comment, twice: `executionContinuation.messages` and
 * `paperclipWake.executionContinuation.messages`) plus rendered prompt text.
 * After the run is terminal nothing reads those bodies or rendered texts:
 * the next run rebuilds them from `issue_comments` and the issue row, and the
 * only reader of a finished run's delivered messages is the `resumeDelta`
 * comparison, which `deliveredMessageMatches` serves from the compact form.
 * Identifiers, objectives, origins, trust metadata and every routing key
 * (`issueId`, `taskId`, `taskKey`, ...) stay untouched.
 */

export const RUN_CONTEXT_COMPACTION_VERSION = 1;
export const RUN_CONTEXT_COMPACTION_MARKER_KEY = "_storageCompaction";
/** Bodies up to this length stay verbatim (short replies, quarantine placeholder). */
export const COMPACT_MESSAGE_BODY_MAX_CHARS = 256;
/** Rendered prompt text rebuilt by `executeRun` before every dispatch. */
export const RENDERED_CONTEXT_KEYS = [
  "paperclipTaskMarkdown",
  "paperclipTaskMarkdownCompact",
  "paperclipTaskMarkdownAssignment",
  "paperclipTaskMarkdownAssignmentCompact",
  "paperclipFreshSessionHandoffMarkdown",
] as const;
export const RUN_CONTEXT_COMPACTION_TERMINAL_STATUSES = [
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
] as const;
/** Late writers (chat completion delivery, secret redaction) finish well within this. */
export const RUN_CONTEXT_COMPACTION_MIN_AGE_MS = 60 * 60 * 1000;
export const RUN_CONTEXT_COMPACTION_BATCH_SIZE = 25;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function compactMessages(value: unknown, counter: { bodies: number }): unknown {
  if (!Array.isArray(value)) return value;
  let changed = false;
  const next = value.map((entry) => {
    const message = record(entry);
    if (!message || typeof message.body !== "string") return entry;
    if (message.body.length <= COMPACT_MESSAGE_BODY_MAX_CHARS) return entry;
    const { body, ...rest } = message;
    changed = true;
    counter.bodies += 1;
    return { ...rest, bodyOmitted: true, bodyChars: (body as string).length };
  });
  return changed ? next : value;
}

function compactEnvelope(value: unknown, counter: { bodies: number }): unknown {
  const envelope = record(value);
  if (!envelope) return value;
  let next: Record<string, unknown> = envelope;
  const messages = compactMessages(envelope.messages, counter);
  if (messages !== envelope.messages) next = { ...next, messages };
  const delta = record(envelope.resumeDelta);
  if (delta) {
    const deltaMessages = compactMessages(delta.messages, counter);
    if (deltaMessages !== delta.messages) {
      next = { ...next, resumeDelta: { ...delta, messages: deltaMessages } };
    }
  }
  return next;
}

/**
 * Pure: returns a compacted copy of a finished run's snapshot, or
 * `changed: false` when it is already compact. Never mutates the input.
 */
export function compactTerminalRunContextSnapshot(
  snapshot: unknown,
  now: Date = new Date(),
): { changed: boolean; snapshot: Record<string, unknown> | null } {
  const source = record(snapshot);
  if (!source) return { changed: false, snapshot: source };
  if (record(source[RUN_CONTEXT_COMPACTION_MARKER_KEY])) {
    return { changed: false, snapshot: source };
  }
  const counter = { bodies: 0 };
  const next: Record<string, unknown> = { ...source };
  const omittedKeys: string[] = [];
  for (const key of RENDERED_CONTEXT_KEYS) {
    if (key in next) {
      delete next[key];
      omittedKeys.push(key);
    }
  }
  if ("executionContinuation" in next) {
    next.executionContinuation = compactEnvelope(next.executionContinuation, counter);
  }
  const wake = record(next.paperclipWake);
  if (wake && "executionContinuation" in wake) {
    const compacted = compactEnvelope(wake.executionContinuation, counter);
    if (compacted !== wake.executionContinuation) {
      next.paperclipWake = { ...wake, executionContinuation: compacted };
    }
  }
  if (omittedKeys.length === 0 && counter.bodies === 0) {
    return { changed: false, snapshot: source };
  }
  next[RUN_CONTEXT_COMPACTION_MARKER_KEY] = {
    version: RUN_CONTEXT_COMPACTION_VERSION,
    compactedAt: now.toISOString(),
    omittedKeys,
    omittedMessageBodies: counter.bodies,
  };
  return { changed: true, snapshot: next };
}

/**
 * Whether a message delivered in an earlier run (full or compacted form) is
 * the same as the current projection of that comment. Comment edits always
 * move `updatedAt`; the quarantine placeholder is short and stays verbatim, so
 * a trust-exposure change is still detected through the body or its length.
 */
export function deliveredMessageMatches(
  prior: Record<string, unknown>,
  message: {
    id: string;
    updatedAt: string;
    body: string;
    deleted: boolean;
    authorId: string | null;
    createdByRunId: string | null;
    sourceTrust: unknown;
  },
): boolean {
  const bodyMatches =
    typeof prior.body === "string"
      ? prior.body === message.body
      : prior.bodyOmitted === true && prior.bodyChars === message.body.length;
  return (
    prior.id === message.id &&
    prior.updatedAt === message.updatedAt &&
    bodyMatches &&
    prior.deleted === message.deleted &&
    prior.authorId === message.authorId &&
    (prior.createdByRunId ?? null) === message.createdByRunId &&
    JSON.stringify(prior.sourceTrust) === JSON.stringify(message.sourceTrust)
  );
}

export type RunContextCompactionResult = {
  scanned: number;
  compacted: number;
  skippedConcurrentWrite: number;
};

/**
 * One bounded pass over finished runs older than `minAgeMs`, in
 * (finish time, id) order from an in-memory cursor. After a restart the
 * cursor starts over; already compacted rows are recognized by their marker
 * and skipped. Each write is a compare-and-set on the exact snapshot read and
 * on a terminal status, so a concurrent writer is never overwritten; such a
 * row is simply retried on a later pass.
 */
export function createRunContextCompactionSweep(
  db: Db,
  options: { minAgeMs?: number; batchSize?: number; now?: () => Date } = {},
) {
  const minAgeMs = options.minAgeMs ?? RUN_CONTEXT_COMPACTION_MIN_AGE_MS;
  const batchSize = options.batchSize ?? RUN_CONTEXT_COMPACTION_BATCH_SIZE;
  const clock = options.now ?? (() => new Date());
  let cursor: { at: string; id: string } | null = null;
  const finishedAt = sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt})`;

  async function sweep(): Promise<RunContextCompactionResult> {
    const now = clock();
    const cutoff = new Date(now.getTime() - minAgeMs).toISOString();
    const candidates = await db
      .select({ id: heartbeatRuns.id, at: sql<string>`${finishedAt}::text` })
      .from(heartbeatRuns)
      .where(
        and(
          inArray(heartbeatRuns.status, [...RUN_CONTEXT_COMPACTION_TERMINAL_STATUSES]),
          sql`${finishedAt} < ${cutoff}::timestamptz`,
          cursor
            ? sql`(${finishedAt}, ${heartbeatRuns.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(finishedAt, heartbeatRuns.id)
      .limit(batchSize);
    const result: RunContextCompactionResult = {
      scanned: candidates.length,
      compacted: 0,
      skippedConcurrentWrite: 0,
    };
    // The cursor advances only through the uncontended prefix of the batch, so
    // a row that lost its compare-and-set is read again on a later pass.
    let contended = false;
    for (const candidate of candidates) {
      const row = await db
        .select({ status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, candidate.id))
        .then((rows) => rows[0] ?? null);
      const { changed, snapshot } = row
        ? compactTerminalRunContextSnapshot(row.contextSnapshot, now)
        : { changed: false, snapshot: null };
      if (row && changed && snapshot) {
        const updated = await db
          .update(heartbeatRuns)
          .set({ contextSnapshot: snapshot })
          .where(
            and(
              eq(heartbeatRuns.id, candidate.id),
              eq(heartbeatRuns.status, row.status),
              inArray(heartbeatRuns.status, [...RUN_CONTEXT_COMPACTION_TERMINAL_STATUSES]),
              sql`${heartbeatRuns.contextSnapshot} = ${JSON.stringify(row.contextSnapshot)}::jsonb`,
            ),
          )
          .returning({ id: heartbeatRuns.id });
        if (updated.length > 0) result.compacted += 1;
        else {
          result.skippedConcurrentWrite += 1;
          contended = true;
        }
      }
      if (!contended) cursor = { at: candidate.at, id: candidate.id };
    }
    if (result.compacted > 0 || result.skippedConcurrentWrite > 0) {
      logger.info({ ...result }, "compacted finished run context snapshots");
    }
    return result;
  }

  return { sweep, resetCursor: () => { cursor = null; } };
}
